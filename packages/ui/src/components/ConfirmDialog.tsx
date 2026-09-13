import { useState, type ReactNode } from "react";
import { IconAlertTriangle } from "@tabler/icons-react";
import { Button } from "./ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog.js";

/**
 * Replaces window.confirm(). Says what will happen, names the action on the
 * button (never "OK"), and makes the safe choice the easy one
 * (Nielsen #5 error prevention, Norman: constraints + clear signifiers).
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive = false,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => Promise<void> | void;
  children?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <div className="flex items-start gap-3">
            {destructive && (
              <div className="size-9 shrink-0 rounded-full bg-destructive/10 text-destructive grid place-items-center">
                <IconAlertTriangle size={18} />
              </div>
            )}
            <div className="grid gap-1.5">
              <DialogTitle>{title}</DialogTitle>
              {description && <DialogDescription>{description}</DialogDescription>}
            </div>
          </div>
        </DialogHeader>
        {children}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy} autoFocus>Cancel</Button>
          <Button variant={destructive ? "destructive" : "default"} onClick={() => void go()} disabled={busy}>
            {busy ? "Working…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
