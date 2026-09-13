import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

/** Web dashboard — a static SPA (Vercel). Same Supabase project, anon key only. */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  server: { port: 5173, strictPort: true },
  envPrefix: ["VITE_"],
  // .env.local lives at the repo root
  envDir: "../..",
});
