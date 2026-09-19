/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** Ed25519 public key for verifying subscription tokens (safe to ship). */
  readonly VITE_SUBSCRIPTION_PUBLIC_KEY?: string;
  /** Zogal Business server that starts and confirms payments (defaults to ops.business.zogal.app). */
  readonly VITE_PAY_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Release number, injected at build time from apps/desktop/src-tauri/tauri.conf.json. */
declare const __APP_VERSION__: string;
