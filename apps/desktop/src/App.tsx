import { useMemo } from "react";
import { getSupabase } from "./lib/supabase.js";

/**
 * Stage 1 shell: proves the toolchain (Vite → Tauri webview) and the anon
 * Supabase client boot. Real sales flow lands in Stage 3.
 */
export function App() {
  const status = useMemo(() => {
    try {
      getSupabase();
      return "Supabase client ready (anon)";
    } catch (e) {
      return `Supabase not configured: ${(e as Error).message}`;
    }
  }, []);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <h1>JakoDav — desktop</h1>
      <p>Stage 1 foundation scaffold.</p>
      <p>{status}</p>
    </main>
  );
}
