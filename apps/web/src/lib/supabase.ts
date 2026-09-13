import { createAnonClient } from "@zogal/shared";
import type { SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | undefined;

/** Lazily-built singleton. Anon key only — see .env.example. */
export function getSupabase(): SupabaseClient {
  client ??= createAnonClient({
    url: import.meta.env.VITE_SUPABASE_URL ?? "",
    anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY ?? "",
  });
  return client;
}
