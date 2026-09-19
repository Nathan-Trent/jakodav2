import { getPassword, setPassword, deletePassword } from "tauri-plugin-keyring-api";
import type { DeviceActivation } from "@zogal/auth-permissions";
import { isTauri } from "@/lib/updater";

/**
 * Persisted device binding (TRD §1 activation flow). The credential is
 * returned exactly once by activate_device(); if this is lost the device
 * must be re-activated with a new code.
 *
 * Stage 5: the OS's own credential store (Windows Credential Manager /
 * macOS Keychain / Linux Secret Service via tauri-plugin-keyring), scoped
 * to the OS user account that installed Doka — not readable from devtools
 * or the app's own storage folder the way localStorage was.
 *
 * The web/POS build has no native keyring (it's a browser tab, not Tauri),
 * so it keeps using localStorage — same tradeoff it always had.
 */
const SERVICE = "app.zogal.doka.device";
const USER = "credential";
/** Pre-Stage-5 storage. Read once on first launch after the upgrade so an
 *  already-activated till isn't asked to re-activate; then moved into the
 *  keyring and never read again. */
const LEGACY_KEYS = ["zogal.device", "jakoda.device"];

function parse(raw: string | null): DeviceActivation | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<DeviceActivation>;
    return v.device_id && v.shop_id && v.credential ? (v as DeviceActivation) : null;
  } catch {
    return null;
  }
}

function loadLegacyLocalStorage(): DeviceActivation | null {
  for (const key of LEGACY_KEYS) {
    const d = parse(localStorage.getItem(key));
    if (d) return d;
  }
  return null;
}

export async function loadDevice(): Promise<DeviceActivation | null> {
  if (!isTauri()) return loadLegacyLocalStorage(); // POS web build: no native keyring available
  try {
    const raw = await getPassword(SERVICE, USER);
    const fromKeyring = parse(raw);
    if (fromKeyring) return fromKeyring;
  } catch (e) {
    console.error("keyring read failed", e); // fall through to the one-time migration below
  }
  // One-time migration from the pre-Stage-5 localStorage binding.
  const legacy = loadLegacyLocalStorage();
  if (legacy) {
    await saveDevice(legacy);
    for (const key of LEGACY_KEYS) localStorage.removeItem(key);
  }
  return legacy;
}

export async function saveDevice(d: DeviceActivation): Promise<void> {
  if (!isTauri()) { localStorage.setItem(LEGACY_KEYS[0]!, JSON.stringify(d)); return; }
  await setPassword(SERVICE, USER, JSON.stringify(d));
}

export async function clearDevice(): Promise<void> {
  if (!isTauri()) { localStorage.removeItem(LEGACY_KEYS[0]!); return; }
  try { await deletePassword(SERVICE, USER); } catch { /* nothing to delete is fine */ }
}

/** Best-effort human name for this terminal, editable at activation. */
/** A name the owner will recognise on the dashboard — not the OS name. Editable on the setup screen and from the dashboard. */
export function defaultDeviceName(): string {
  return "Front counter";
}
