/**
 * parse-notebook-page — Stage 7, notebook photo capture (PRD §5.6, §6.5).
 *
 * The ONLY place the system calls an AI model. Its job is narrow: turn a
 * photograph of a handwritten sales page into a DRAFT list of rows the
 * cashier then confirms on the desktop. It never writes a sale — confirmed
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
 *   npx supabase secrets set ANTHROPIC_API_KEY=<key>
 *   npx supabase functions deploy parse-notebook-page
 * (JWT verification stays ON — this runs as a signed-in user.)
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk@0.125.0";
import { z } from "npm:zod@4.6.2";
import { zodOutputFormat } from "npm:@anthropic-ai/sdk@0.125.0/helpers/zod";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

/** What the model must return. Prices in naira as written on the page. */
const PageSchema = z.object({
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

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!ANTHROPIC_API_KEY) return json({ error: "model key not configured" }, 500);

  const authHeader = req.headers.get("authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "sign in first" }, 401);

  let body: { shop_id?: string; device_id?: string | null; image_base64?: string; media_type?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
  if (!body.shop_id || !body.image_base64) return json({ error: "shop_id and image_base64 are required" }, 400);
  const mediaType = body.media_type ?? "image/jpeg";
  if (!["image/jpeg", "image/png", "image/webp"].includes(mediaType)) return json({ error: "unsupported image type" }, 400);
  if (body.image_base64.length * 0.75 > MAX_IMAGE_BYTES) return json({ error: "image too large (max 4 MB)" }, 413);

  // As the user: RLS + the quota check in Postgres decide whether this call may happen.
  const asUser = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } }, auth: { persistSession: false },
  });
  const { data: scanId, error: beginErr } = await asUser.rpc("notebook_scan_begin", {
    p_shop_id: body.shop_id, p_device_id: body.device_id ?? null,
  });
  if (beginErr) {
    const msg = beginErr.message ?? "refused";
    const status = msg.includes("scan_allowance_exhausted") ? 402 : msg.includes("permission") || msg.includes("member") ? 403 : 400;
    return json({ error: msg }, status);
  }

  // The shop's items (RLS-scoped) so the model can match names to ids.
  const { data: items } = await asUser
    .from("items").select("id, name, suggested_price").eq("shop_id", body.shop_id).eq("is_active", true).order("name");
  const itemList = (items ?? []).map((i) => `${i.id}\t${i.name}\t₦${i.suggested_price}`).join("\n");

  const svc = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false }, db: { schema: "public" } });
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
      output_config: { effort: "medium", format: zodOutputFormat(PageSchema) },
      system: [
        {
          type: "text",
          text:
            "You read photographed pages from a Nigerian shop's handwritten sales notebook and transcribe them into rows. " +
            "Each row is one thing sold: the item as written, quantity, unit price in naira (₦), and line total if written. " +
            "Prices may be written like 1,500 / 1500 / 1.5k / 15OO — normalise to a number. Quantity may be written as 'x3', '3pcs', '3 pieces', or a bare number before the item. " +
            "Match each row to the shop's item list by name when you are confident (spelling and abbreviations vary — 'Indomie' for 'Indomie Chicken 70g' is fine if it is the only Indomie); otherwise leave item_id null. " +
            "Never invent rows, quantities or prices you cannot read — use null and say so in note. If the page is not a sales list, say so in warnings and return no rows. " +
            `Return at most ${maxRows} rows.`,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType as "image/jpeg" | "image/png" | "image/webp", data: body.image_base64 } },
            { type: "text", text: `Shop items (id<TAB>name<TAB>usual price):\n${itemList || "(no items yet)"}\n\nTranscribe this page.` },
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

    const result = response.parsed_output;
    // Only accept item ids that really are this shop's — the model is untrusted.
    const known = new Set((items ?? []).map((i) => i.id));
    for (const r of result.rows) if (r.item_id && !known.has(r.item_id)) r.item_id = null;

    await svc.from("notebook_scans").update({
      status: "parsed", result, model,
      input_tokens: response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0) + (response.usage.cache_creation_input_tokens ?? 0),
      output_tokens: response.usage.output_tokens, finished_at: new Date().toISOString(),
    }).eq("id", scanId);

    return json({ scan_id: scanId, result });
  } catch (err) {
    const message = err instanceof Anthropic.APIError ? `model error ${err.status}: ${err.message}` : err instanceof Error ? err.message : String(err);
    await svc.from("notebook_scans").update({ status: "failed", model, error: message, finished_at: new Date().toISOString() }).eq("id", scanId);
    // A failed scan doesn't count against the allowance (quota counts status <> 'failed').
    return json({ error: "Could not read the page right now. Nothing was charged to your allowance." }, 502);
  }
});
