import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Client factory. ANON KEY ONLY — this module is bundled into the desktop
 * and web clients. The service-role key must never pass through here
 * (TRD §10). Server-side code creates its own client from process.env.
 */
export interface ClientEnv {
  url: string;
  anonKey: string;
}

export function createAnonClient(env: ClientEnv): SupabaseClient {
  if (!env.url || !env.anonKey) {
    throw new Error("Supabase URL and anon key are required (see .env.example)");
  }
  if (/service_role/i.test(env.anonKey)) {
    // JWT payload of a service-role key contains "role":"service_role"; a
    // cheap guard against pasting the wrong key into VITE_SUPABASE_ANON_KEY.
    throw new Error("Refusing to start a client with a service-role key");
  }
  return createClient(env.url, env.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
}
