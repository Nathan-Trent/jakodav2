/**
 * One-time Ed25519 keypair generator for subscription tokens.
 *
 *   deno run -A supabase/functions/issue-subscription-token/keygen.ts
 *
 * Then:
 *   supabase secrets set SUBSCRIPTION_PRIVATE_KEY=<private>
 *   put <public> in .env.local as VITE_SUBSCRIPTION_PUBLIC_KEY
 *
 * The private key must never be committed and never reach a client bundle.
 * The public key is safe to ship — it can only verify, never sign.
 */
const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;

const priv = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

console.log("\nSUBSCRIPTION_PRIVATE_KEY (server only — supabase secrets set):\n");
console.log(b64(priv));
console.log("\nVITE_SUBSCRIPTION_PUBLIC_KEY (safe to ship in the desktop app):\n");
console.log(b64(pub));
console.log("");
