import fs from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

/** Web dashboard — a static SPA (Vercel). Same Supabase project, anon key only. */
// One release number for every Doka surface: the desktop's tauri.conf.json version. Shown in the sidebar footer.
const APP_VERSION = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../desktop/src-tauri/tauri.conf.json"), "utf8")).version as string;

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  server: { port: 5173, strictPort: true },
  envPrefix: ["VITE_"],
  // .env.local lives at the repo root
  envDir: "../..",
});
