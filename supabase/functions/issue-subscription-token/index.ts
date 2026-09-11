/**
 * issue-subscription-token — SYNC / offline subscription enforcement (TRD §7).
 *
 * Why this exists at all: the desktop app must refuse to run past expiry even
 * with no network, so it has to hold a copy of its subscription state. If that
 * copy were signed with a shared secret the app would need the secret to check
 * it — and anything the app can verify with, it can forge with. So the server
 * signs with an Ed25519 PRIVATE key that never leaves Supabase, and the app
 * verifies with the matching PUBLIC key compiled into it. The app can read and
 * check its token; it cannot mint or extend one.
 *
 * TRD §2 keeps Edge Functions thin — this one does no business logic. It
 * authenticates the device against Postgres, reads state that Postgres already
 * computed, signs it, and hands it back.
 *
 * Deploy (see BUILD_LOG "Stage 5 setup" for the walkthrough):
 *   node scripts/generate-subscription-keys.mjs     # once, prints both keys
 *   npx supabase secrets set SUBSCRIPTION_PRIVATE_KEY=<private>
 *   npx supabase functions deploy issue-subscription-token --no-verify-jwt
 *
 * --no-verify-jwt is deliberate: a terminal that has been logged out still
 * needs to refresh its token. It authenticates with the device credential,
 * which is stronger here than a user session.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";

const PRIVATE_KEY_B64 = Deno.env.get("SUBSCRIPTION_PRIVATE_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/** Token lifetime. Short enough that a cancelled subscription bites within a
 *  sync cycle; long enough to outlive the mandatory 5-day sync window. */
const TOKEN_TTL_DAYS = 14;

/**
 * The desktop app calls this from a webview, so the browser sends a CORS
 * preflight first and drops the response without these headers. Omitting them
 * silently broke every call from the app while curl worked fine.
 */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

function b64urlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function importPrivateKey(): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(PRIVATE_KEY_B64), (c) => c.charCodeAt(0));
  return await crypto.subtle.importKey("pkcs8", raw, { name: "Ed25519" }, false, ["sign"]);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: CORS });
  if (!PRIVATE_KEY_B64) {
    return new Response(JSON.stringify({ error: "signing key not configured" }), { status: 500, headers: { ...CORS, "content-type": "application/json" } });
  }

  let body: { device_id?: string; credential?: string; monotonic_seconds?: number; wall_clock_seconds?: number };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON" }), { status: 400, headers: { ...CORS, "content-type": "application/json" } });
  }
  if (!body.device_id || !body.credential) {
    return new Response(JSON.stringify({ error: "device_id and credential are required" }), { status: 400, headers: { ...CORS, "content-type": "application/json" } });
  }

  const db = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  // device_heartbeat verifies the credential, stamps last_sync_at, logs any
  // clock anomaly, and returns subscription + policy. All of that is Postgres'
  // job; this function only signs the answer.
  const { data, error } = await db.rpc("device_heartbeat", {
    p_device_id: body.device_id,
    p_credential: body.credential,
    p_monotonic_seconds: body.monotonic_seconds ?? null,
    p_wall_clock_seconds: body.wall_clock_seconds ?? null,
  });
  if (error) {
    // Wrong credential or revoked device — say so, reveal nothing else.
    return new Response(JSON.stringify({ error: "unknown or revoked device" }), { status: 401, headers: { ...CORS, "content-type": "application/json" } });
  }

  const state = data as {
    device_id: string;
    shop_id: string;
    server_time: string;
    subscription: { status: string; plan: string; expires_at: string | null };
    policy: Record<string, number>;
  };

  const payload = {
    v: 1,
    device_id: state.device_id,
    shop_id: state.shop_id,
    status: state.subscription.status,
    plan: state.subscription.plan,
    expires_at: state.subscription.expires_at,
    policy: state.policy,
    issued_at: state.server_time,
    // The device treats its token as stale past this, even offline.
    token_expires_at: new Date(Date.parse(state.server_time) + TOKEN_TTL_DAYS * 86_400_000).toISOString(),
  };

  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const key = await importPrivateKey();
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, payloadBytes));
  const token = `${b64urlEncode(payloadBytes)}.${b64urlEncode(sig)}`;

  // Store it so a device that can reach Postgres but not this function still
  // gets its most recent token back from device_heartbeat().
  await db.rpc("store_subscription_token", { p_device_id: state.device_id, p_token: token });

  return new Response(JSON.stringify({ token, payload }), {
    headers: { ...CORS, "content-type": "application/json" },
  });
});
