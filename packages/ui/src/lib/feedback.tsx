import { toast } from "sonner";
import { friendlyError } from "./errors.js";

/**
 * One place for feedback so every screen behaves the same (Nielsen #4
 * consistency, #1 visibility of status). Errors always carry a next step.
 */
export function notifyError(e: unknown, fallbackTitle?: string): void {
  const f = friendlyError(e);
  toast.error(fallbackTitle && f.title === String(rawOf(e)) ? fallbackTitle : f.title, {
    description: [f.detail, f.action].filter(Boolean).join(" "),
    duration: 6000,
  });
}

export function notifySuccess(title: string, opts?: { description?: string; undo?: () => void | Promise<void> }): void {
  toast.success(title, {
    description: opts?.description,
    action: opts?.undo ? { label: "Undo", onClick: () => void opts.undo!() } : undefined,
  });
}

export function notifyInfo(title: string, description?: string): void {
  toast(title, { description });
}

function rawOf(e: unknown): unknown {
  return e && typeof e === "object" && "message" in e ? (e as { message: unknown }).message : e;
}
