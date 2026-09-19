import fs from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// Tauri expects a fixed port and no HMR overlay hijacking the webview.
const host = process.env.TAURI_DEV_HOST;

// One release number for every Doka surface: the desktop's tauri.conf.json version. Shown in the sidebar footer.
const APP_VERSION = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../desktop/src-tauri/tauri.conf.json"), "utf8")).version as string;

// Partner web build (`npm run pos:build`): the same app served from
// doka.zogal.app/webapp/ inside the dashboard's Vercel output. Tauri builds
// keep base "/" and their own dist.

export default defineConfig(({ mode }) => {
  const WEBAPP = mode === "webapp";
  return {
  base: WEBAPP ? "/webapp/" : "/",
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  // Only VITE_-prefixed vars reach the bundle; SUPABASE_SERVICE_ROLE_KEY never will.
  envPrefix: ["VITE_", "TAURI_ENV_"],
  // .env.local lives at the repo root, not in apps/desktop
  envDir: "../..",
  build: {
    ...(WEBAPP ? { outDir: path.resolve(import.meta.dirname, "../web/dist/webapp"), emptyOutDir: true } : {}),
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
  };
});
