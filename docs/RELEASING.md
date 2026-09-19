# Releasing the desktop app

Installed copies update themselves. Nothing is built on a developer machine.

## One-time setup (Nathan)

1. Generate the updater signing key (PowerShell, from the repo root):

       npm run tauri -w @zogal/desktop -- signer generate -w $HOME\.tauri\zogal-updater.key

   It prints a PRIVATE key (file `~/.tauri/zogal-updater.key`) and a PUBLIC key.
   Keep the private key file safe (back it up); if it is lost, existing installs
   can never accept another update.

2. Paste the PUBLIC key into `apps/desktop/src-tauri/tauri.conf.json` →
   `plugins.updater.pubkey` (replace `the public key (set 2026-09-18)`). Commit.

3. GitHub → repo → Settings → Secrets and variables → Actions → New repository secret:
   - `TAURI_SIGNING_PRIVATE_KEY` — the whole contents of the private key file
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the password you typed (empty if none)
   - `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` — from `.env.local` (anon only)
   - `VITE_SUBSCRIPTION_PUBLIC_KEY` — from `.env.local`

## Every release

1. Bump the version in `apps/desktop/src-tauri/tauri.conf.json`,
   `apps/desktop/src-tauri/Cargo.toml` and `apps/desktop/package.json` (same number).
2. Commit, then tag and push:

       git tag v0.2.0
       git push origin v0.2.0

3. GitHub Actions builds the Windows installer and both Mac apps in parallel
   (~20 min) and signs them. Each build uploads to a DRAFT release; once all
   three are in, a final job publishes it (undrafts it) in one step. Installed
   apps and the marketing site never see a half-built release — only the
   complete one. Installed apps see it within 6 hours (or on next launch)
   and offer "Update and restart".

First install on a new machine: download the `.exe` (Windows) or `.dmg` (Mac — Apple Silicon or Intel) from the latest Release.

## macOS

Builds run for both Apple Silicon and Intel. Until an Apple Developer ID
(US$99/yr) is set up they are UNSIGNED: on first open, right-click the app →
Open → Open. The auto-updater still works (it verifies our own signature).
To sign and notarise so it opens normally, add these repository secrets and
nothing else changes: `APPLE_CERTIFICATE` (base64 .p12), `APPLE_CERTIFICATE_PASSWORD`,
`APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` (app-specific), `APPLE_TEAM_ID`.

# Web deployments (Vercel)

Two projects, one repo, both with Root Directory left EMPTY:

| Project | Build command | Output directory | Serves |
|---|---|---|---|
| shop dashboard (existing) | (from `vercel.json`: `npm run web:build`) | `apps/web/dist` | `/` owner dashboard, `/admin` Zogal back office |
| partner POS (temporary) | `npm run pos:build` — set in the project's Build settings, overriding vercel.json | `apps/desktop/dist` | the full desktop till as a website |

Both need env vars `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`; the POS project also `VITE_SUBSCRIPTION_PUBLIC_KEY`.
The POS project is deleted when the partner trial ends — nothing else depends on it.
