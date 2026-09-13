# Releasing the desktop app

Installed copies update themselves. Nothing is built on a developer machine.

## One-time setup (Nathan)

1. Generate the updater signing key (PowerShell, from the repo root):

       npm run tauri -w @zogal/desktop -- signer generate -w $HOME\.tauri\zogal-updater.key

   It prints a PRIVATE key (file `~/.tauri/zogal-updater.key`) and a PUBLIC key.
   Keep the private key file safe (back it up); if it is lost, existing installs
   can never accept another update.

2. Paste the PUBLIC key into `apps/desktop/src-tauri/tauri.conf.json` →
   `plugins.updater.pubkey` (replace `REPLACE_WITH_UPDATER_PUBLIC_KEY`). Commit.

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

3. GitHub Actions builds the Windows installer (~15 min), signs it, and publishes
   Release `v0.2.0` with `latest.json`. Installed apps see it within 6 hours
   (or on next launch) and offer "Update and restart".

First install on a new machine: download the `.exe` from the latest Release.
