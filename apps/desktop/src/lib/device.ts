import type { DeviceActivation } from "@jakoda/auth-permissions";

/**
 * Persisted device binding (TRD §1 activation flow). The credential is
 * returned exactly once by activate_device(); if this is lost the device
 * must be re-activated with a new code.
 *
 * Stage 3: localStorage (webview-scoped, survives restarts).
 * Stage 5 TODO: move to tauri-plugin-store / OS keychain so it isn't readable
 * from devtools, and so the SYNC layer can read it from the native side.
 */
const KEY = "jakoda.device";

export function loadDevice(): DeviceActivation | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<DeviceActivation>;
    if (v.device_id && v.shop_id && v.credential) return v as DeviceActivation;
    return null;
  } catch {
    return null;
  }
}

export function saveDevice(d: DeviceActivation): void {
  localStorage.setItem(KEY, JSON.stringify(d));
}

export function clearDevice(): void {
  localStorage.removeItem(KEY);
}

/** Best-effort human name for this terminal, editable at activation. */
export function defaultDeviceName(): string {
  const host = typeof navigator !== "undefined" ? navigator.platform : "";
  return `Terminal (${host || "desktop"})`;
}
