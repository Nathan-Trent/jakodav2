/**
 * SYNC: subscription token verification (TRD §7).
 *
 * The server signs with an Ed25519 private key that never leaves Supabase;
 * this verifies with the matching public key shipped in the app. The app can
 * therefore check its subscription offline but cannot mint or extend one — if
 * it could verify with the same material it signs with, it could forge.
 *
 * Every failure path returns `valid: false`. Nothing here ever falls back to
 * "assume active": an unverifiable token must mean less access, not more.
 */

export interface SubscriptionPayload {
  v: number;
  device_id: string;
  shop_id: string;
  status: "active" | "past_due" | "cancelled";
  plan: string;
  expires_at: string | null;
  policy: { grace_days: number; read_only_days: number; mandatory_sync_days: number; sync_warning_days: number };
  issued_at: string;
  token_expires_at: string;
}

export interface VerifiedToken {
  valid: boolean;
  payload: SubscriptionPayload | null;
  /** Why it failed, for logs and the operational centre — never shown raw. */
  reason?: "no_token" | "no_public_key" | "malformed" | "bad_signature" | "wrong_device" | "token_expired" | "unsupported_version";
}

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let cachedKey: CryptoKey | null = null;
let cachedKeyB64 = "";

async function publicKey(publicKeyB64: string): Promise<CryptoKey | null> {
  if (!publicKeyB64) return null;
  if (cachedKey && cachedKeyB64 === publicKeyB64) return cachedKey;
  try {
    const bin = atob(publicKeyB64);
    const raw = new Uint8Array(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
    const key = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
    cachedKey = key;
    cachedKeyB64 = publicKeyB64;
    return key;
  } catch {
    return null;
  }
}

/**
 * @param expectedDeviceId a token minted for another terminal is not valid
 *        here, even if it verifies — otherwise one paid terminal's token
 *        could be copied to unlock every other install.
 */
export async function verifySubscriptionToken(
  token: string | null,
  publicKeyB64: string,
  expectedDeviceId: string,
  now = new Date(),
): Promise<VerifiedToken> {
  if (!token) return { valid: false, payload: null, reason: "no_token" };

  const key = await publicKey(publicKeyB64);
  if (!key) return { valid: false, payload: null, reason: "no_public_key" };

  const parts = token.split(".");
  if (parts.length !== 2) return { valid: false, payload: null, reason: "malformed" };

  let payloadBytes: Uint8Array<ArrayBuffer>;
  let sigBytes: Uint8Array<ArrayBuffer>;
  try {
    payloadBytes = b64urlDecode(parts[0]!);
    sigBytes = b64urlDecode(parts[1]!);
  } catch {
    return { valid: false, payload: null, reason: "malformed" };
  }

  let ok = false;
  try {
    ok = await crypto.subtle.verify({ name: "Ed25519" }, key, sigBytes, payloadBytes);
  } catch {
    return { valid: false, payload: null, reason: "bad_signature" };
  }
  if (!ok) return { valid: false, payload: null, reason: "bad_signature" };

  let payload: SubscriptionPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as SubscriptionPayload;
  } catch {
    return { valid: false, payload: null, reason: "malformed" };
  }

  // Signature checks the bytes; these check that the bytes mean what we need.
  if (payload.v !== 1) return { valid: false, payload, reason: "unsupported_version" };
  if (payload.device_id !== expectedDeviceId) return { valid: false, payload, reason: "wrong_device" };
  if (Date.parse(payload.token_expires_at) < now.getTime()) {
    return { valid: false, payload, reason: "token_expired" };
  }

  return { valid: true, payload };
}
