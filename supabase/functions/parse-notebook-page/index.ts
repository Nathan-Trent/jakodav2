/**
 * parse-notebook-page — document scan (PRD §5.6, §6.5; kinds added 0029).
 *
 * The ONLY place the system calls an AI model. Its job is narrow: turn a
 * photograph of a page — a sales book page, a stock ledger, a supplier
 * invoice, a receipt — into a DRAFT list of rows the person then confirms
 * on the screen they were already on. It never writes a sale — confirmed
 * rows go through record_sale like any other sale. The image is not stored.
 *
 * Money and permission decisions stay in Postgres:
 *   notebook_scan_begin()  — as the USER: membership, sales.create, and the
 *                            monthly free-scan allowance (a platform setting
 *                            Nathan's back office controls). Refused = no
 *                            model call, no cost.
 *   notebook_scans row     — updated with the result via the service role.
 *
 * Deploy:
 *   npx supabase functions deploy parse-notebook-page
 * The Anthropic key is set from the back office (Doka → Settings → Keys,
 * product_secrets doka/anthropic_api_key). `supabase secrets set
 * ANTHROPIC_API_KEY=…` still works as a fallback.
 * (JWT verification stays ON — this runs as a signed-in user.)
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk@0.125.0";
import { z } from "npm:zod@4.6.2";
import { zodOutputFormat } from "npm:@anthropic-ai/sdk@0.125.0/helpers/zod";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY_ENV = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

/**
 * 0029: one function, four page kinds. The kind comes from the screen the
 * user is on — never asked. Each kind has its own schema and instructions;
 * the pipeline (quota, row, cost accounting) is identical.
 */
type PageKind = "sales" | "items" | "purchase" | "expenses";
const KINDS: PageKind[] = ["sales", "items", "purchase", "expenses"];
const confidence = z.enum(["high", "medium", "low"]);
const note = z.string().nullable().describe("Anything the person should check, in one short sentence");

/** Sales page (the original): one row per thing sold. Prices in naira as written. */
const SalesSchema = z.object({
  page_date: z.string().nullable().describe("Date written on the page as YYYY-MM-DD, or null if none"),
  rows: z.array(z.object({
    line: z.number().int().describe("1-based position on the page"),
    item_text: z.string().describe("The item exactly as written"),
    item_id: z.string().nullable().describe("id of the matching shop item, or null if no confident match"),
    quantity: z.number().nullable().describe("Units sold; null if unreadable"),
    unit_price: z.number().nullable().describe("Price per unit in naira; null if unreadable. If only a line total is written, divide by quantity"),
    line_total: z.number().nullable().describe("Line total in naira if written"),
    confidence: z.enum(["high", "medium", "low"]),
    note: z.string().nullable().describe("Anything the cashier should check, in one short sentence"),
  })),
  warnings: z.array(z.string()).describe("Page-level problems: not a sales page, unreadable, columns unclear"),
});

/** Stock ledger / price list → new items with opening stock. */
const ItemsSchema = z.object({
  page_date: z.string().nullable().describe("Date written on the page as YYYY-MM-DD, or null"),
  rows: z.array(z.object({
    line: z.number().int(),
    name: z.string().describe("Item name as written, tidied for a product list (capitalised, no trailing punctuation)"),
    existing_item_id: z.string().nullable().describe("id of a shop item that is clearly the SAME product, or null if this is new"),
    quantity: z.number().nullable().describe("Quantity on hand / in stock if written; null if not"),
    unit_cost: z.number().nullable().describe("Cost price per unit in naira if written (what the shop paid)"),
    selling_price: z.number().nullable().describe("Selling price per unit in naira if written"),
    confidence, note,
  })),
  warnings: z.array(z.string()),
});

/** Supplier invoice / delivery note / handwritten restock list → one purchase. */
const PurchaseSchema = z.object({
  page_date: z.string().nullable().describe("Invoice or delivery date as YYYY-MM-DD, or null"),
  supplier: z.string().nullable().describe("Supplier name if printed or written"),
  rows: z.array(z.object({
    line: z.number().int(),
    item_text: z.string().describe("The item exactly as written"),
    item_id: z.string().nullable().describe("id of the matching shop item, or null if no confident match"),
    quantity: z.number().nullable().describe("Units received; null if unreadable"),
    unit_cost: z.number().nullable().describe("Cost per unit in naira; if only a line total is written, divide by quantity"),
    line_total: z.number().nullable(),
    confidence, note,
  })),
  warnings: z.array(z.string()),
});

/** Receipts / an expenses page → expense lines. */
const ExpensesSchema = z.object({
  page_date: z.string().nullable().describe("Date on the receipt or page as YYYY-MM-DD, or null"),
  rows: z.array(z.object({
    line: z.number().int(),
    description: z.string().describe("What was paid for, in a few words"),
    category: z.enum(["rent", "transport", "staff", "utilities", "other"]).describe("Best-fit category"),
    amount: z.number().nullable().describe("Amount in naira; null if unreadable"),
    date: z.string().nullable().describe("YYYY-MM-DD if this line has its own date"),
    confidence, note,
  })),
  warnings: z.array(z.string()),
});

const SCHEMA = { sales: SalesSchema, items: ItemsSchema, purchase: PurchaseSchema, expenses: ExpensesSchema } as const;

const COMMON = "Amounts may be written like 1,500 / 1500 / 1.5k / 15OO — normalise to a number in naira. Quantities may be written as 'x3', '3pcs', '3 pieces', '3 ctn' or a bare number. Never invent rows, quantities or amounts you cannot read — use null and say so in note. ";
const INSTRUCTIONS: Record<PageKind, (maxRows: number) => string> = {
  sales: (n) =>
    "You read photographed pages from a Nigerian shop's handwritten sales notebook and transcribe them into rows. " +
    "Each row is one thing sold: the item as written, quantity, unit price in naira (₦), and line total if written. " + COMMON +
    "Match each row to the shop's item list by name when you are confident (spelling and abbreviations vary — 'Indomie' for 'Indomie Chicken 70g' is fine if it is the only Indomie); otherwise leave item_id null. " +
    `If the page is not a sales list, say so in warnings and return no rows. Return at most ${n} rows.`,
  items: (n) =>
    "You read a photographed page of a Nigerian shop's stock ledger, stock-count book or price list, so the shop can be set up without typing every product. " +
    "Each row is one product: its name, quantity on hand if written, cost price and selling price in naira if written. " + COMMON +
    "If a row is clearly the same product as one already in the shop's item list, set existing_item_id so it is not created twice; otherwise leave it null. " +
    "Tidy names for a product list (e.g. 'peak milk 400g' → 'Peak Milk 400g') but never change what the product is. " +
    `If the page is not a stock or price list, say so in warnings and return no rows. Return at most ${n} rows.`,
  purchase: (n) =>
    "You read a photographed supplier invoice, delivery note or handwritten restock list for a Nigerian shop and transcribe the goods received. " +
    "Each row is one item received: the item as written, quantity, unit cost in naira, line total if printed. Read the supplier name and date if present. " + COMMON +
    "Match each row to the shop's item list when confident; otherwise leave item_id null so the person can pick or create the item. " +
    `If the page is not an invoice or stock list, say so in warnings and return no rows. Return at most ${n} rows.`,
  expenses: (n) =>
    "You read a photographed receipt, or a page of a Nigerian shop's expenses book, and transcribe each expense. " +
    "Each row is one payment: a short description, the best-fit category (rent, transport, staff, utilities, other), the amount in naira and the date if written. " + COMMON +
    `A single receipt is usually one row (its total). If the page is not a receipt or expenses list, say so in warnings and return no rows. Return at most ${n} rows.`,
};

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const authHeader = req.headers.get("authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "sign in first" }, 401);

  let body: { shop_id?: string; device_id?: string | null; image_base64?: string; media_type?: string; page_kind?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
  if (!body.shop_id || !body.image_base64) return json({ error: "shop_id and image_base64 are required" }, 400);
  const mediaType = body.media_type ?? "image/jpeg";
  const kind = (KINDS as string[]).includes(body.page_kind ?? "sales") ? ((body.page_kind ?? "sales") as PageKind) : null;
  if (!kind) return json({ error: "unknown page kind" }, 400);
  if (!["image/jpeg", "image/png", "image/webp"].includes(mediaType)) return json({ error: "unsupported image type" }, 400);
  if (body.image_base64.length * 0.75 > MAX_IMAGE_BYTES) return json({ error: "image too large (max 4 MB)" }, 413);

  const svc = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false }, db: { schema: "public" } });
  // Key from product_secrets (back-office set), env as fallback. Service role only — never the user's client.
  const { data: secretRow, error: secretErr } = await svc.from("product_secrets").select("value").eq("product", "doka").eq("key", "anthropic_api_key").maybeSingle();
  if (secretErr) console.error("product_secrets read failed:", secretErr.message);
  const ANTHROPIC_API_KEY = (secretRow?.value as string | undefined) || ANTHROPIC_API_KEY_ENV;
  // Checked before notebook_scan_begin so a missing key never spends the shop's allowance.
  if (!ANTHROPIC_API_KEY) return json({ error: "Notebook reading is not switched on yet. Ask Zogal to set the model key." }, 500);

  // As the user: RLS + the quota check in Postgres decide whether this call may happen.
  const asUser = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } }, auth: { persistSession: false },
  });
  const { data: scanId, error: beginErr } = await asUser.rpc("notebook_scan_begin", {
    p_shop_id: body.shop_id, p_device_id: body.device_id ?? null, p_page_kind: kind,
  });
  if (beginErr) {
    const msg = beginErr.message ?? "refused";
    const status = msg.includes("scan_allowance_exhausted") || msg.includes("plan_limit") ? 402 : msg.includes("permission") || msg.includes("member") ? 403 : 400;
    return json({ error: msg }, status);
  }

  // The shop's items (RLS-scoped) so the model can match names to ids.
  const { data: items } = await asUser
    .from("items").select("id, name, suggested_price").eq("shop_id", body.shop_id).eq("is_active", true).order("name");
  const itemList = (items ?? []).map((i) => `${i.id}\t${i.name}\t₦${i.suggested_price}`).join("\n");

  const { data: modelSetting } = await svc.rpc("platform_setting", { p_key: "notebook.model" });
  const { data: maxRowsSetting } = await svc.rpc("platform_setting", { p_key: "notebook.max_rows_per_page" });
  const model = typeof modelSetting === "string" && modelSetting ? modelSetting : "claude-opus-5";
  const maxRows = typeof maxRowsSetting === "number" ? maxRowsSetting : 60;

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  try {
    const response = await client.messages.parse({
      model,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium", format: zodOutputFormat(SCHEMA[kind]) },
      system: [{ type: "text", text: INSTRUCTIONS[kind](maxRows), cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType as "image/jpeg" | "image/png" | "image/webp", data: body.image_base64 } },
            { type: "text", text: kind === "expenses" ? "Transcribe this page." : `Shop items (id<TAB>name<TAB>usual price):\n${itemList || "(no items yet)"}\n\nTranscribe this page.` },
          ],
        },
      ],
    });

    if (response.stop_reason === "refusal" || !response.parsed_output) {
      await svc.from("notebook_scans").update({
        status: "failed", model, error: response.stop_reason === "refusal" ? "model declined" : "unparseable result",
        input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens, finished_at: new Date().toISOString(),
      }).eq("id", scanId);
      return json({ error: "The page could not be read. Try a clearer photo." }, 422);
    }

    const result = response.parsed_output as { rows: Record<string, unknown>[] };
    // Only accept item ids that really are this shop's — the model is untrusted.
    const known = new Set((items ?? []).map((i) => i.id));
    for (const r of result.rows) {
      for (const k of ["item_id", "existing_item_id"]) if (typeof r[k] === "string" && !known.has(r[k] as string)) r[k] = null;
    }

    await svc.from("notebook_scans").update({
      status: "parsed", result, model,
      input_tokens: response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0) + (response.usage.cache_creation_input_tokens ?? 0),
      output_tokens: response.usage.output_tokens, finished_at: new Date().toISOString(),
    }).eq("id", scanId);

    return json({ scan_id: scanId, page_kind: kind, result });
  } catch (err) {
    const message = err instanceof Anthropic.APIError ? `model error ${err.status}: ${err.message}` : err instanceof Error ? err.message : String(err);
    await svc.from("notebook_scans").update({ status: "failed", model, error: message, finished_at: new Date().toISOString() }).eq("id", scanId);
    // A failed scan doesn't count against the allowance (quota counts status <> 'failed').
    return json({ error: "Could not read the page right now. Nothing was charged to your allowance." }, 502);
  }
});
