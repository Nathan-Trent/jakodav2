/**
 * Generates the Ed25519 key pair used for offline subscription tokens (TRD §7).
 *
 *   node scripts/generate-subscription-keys.mjs
 *
 * Run this YOURSELF and don't paste the output anywhere — the private key is
 * the thing that stops someone forging a paid subscription. Run it once and
 * keep the output; regenerating invalidates every token already issued, so
 * every terminal would have to sync before it could sell again.
 *
 * Two keys come out:
 *   PRIVATE — goes into Supabase as a secret. Signs tokens. Never leaves the
 *             server, never goes in git, never reaches the desktop app.
 *   PUBLIC  — goes into .env.local and ships inside the app. Can only CHECK a
 *             signature, never make one, so it is safe to distribute.
 *
 * That asymmetry is the whole point: the terminal can confirm its subscription
 * while completely offline, but cannot extend it.
 */
import { generateKeyPairSync } from "node:crypto";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");

// pkcs8/raw are the formats the Edge Function and the browser's WebCrypto
// expect when importing these back.
const priv = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
// An Ed25519 SPKI DER is a 12-byte header followed by the 32-byte raw key;
// WebCrypto's importKey("raw", …) wants just those 32 bytes.
const spki = publicKey.export({ type: "spki", format: "der" });
const pub = spki.subarray(spki.length - 32).toString("base64");

console.log(`
================================================================
  1. PRIVATE KEY — server only
================================================================
Run this command (paste the key where indicated):

  npx supabase secrets set SUBSCRIPTION_PRIVATE_KEY=${priv}

================================================================
  2. PUBLIC KEY — safe to ship with the app
================================================================
Add this line to .env.local in the project root:

  VITE_SUBSCRIPTION_PUBLIC_KEY=${pub}

================================================================
Then deploy the signing function:

  npx supabase functions deploy issue-subscription-token --no-verify-jwt

Restart the desktop app afterwards so it picks up the new .env.local.
================================================================
`);
