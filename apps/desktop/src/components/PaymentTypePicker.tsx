import { IconBuildingBank, IconCash, IconCreditCard, IconDeviceMobile } from "@tabler/icons-react";
import { PAYMENT_LABEL, PAYMENT_TYPES, type PaymentType } from "@zogal/shared";
import { cn } from "@zogal/ui";

const ICON: Record<PaymentType, typeof IconCash> = { cash: IconCash, transfer: IconBuildingBank, card: IconCreditCard, pos: IconDeviceMobile };

/**
 * How the customer paid: four big targets, one always selected (cash by
 * default), so recording a sale never adds a step — only a tap when it
 * wasn't cash. Keyboard: arrow keys move, as a radio group.
 */
export function PaymentTypePicker({ value, onChange, disabled, required }: { value: PaymentType | null; onChange: (v: PaymentType) => void; disabled?: boolean; required?: boolean }) {
  return (
    <div role="radiogroup" aria-label="How the customer paid" aria-required={required} className="grid grid-cols-4 gap-1.5"
      onKeyDown={(e) => {
        if (disabled) return;
        const i = value ? PAYMENT_TYPES.indexOf(value) : -1;
        if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); onChange(PAYMENT_TYPES[(i + 1) % PAYMENT_TYPES.length]!); }
        if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); onChange(PAYMENT_TYPES[(i - 1 + PAYMENT_TYPES.length) % PAYMENT_TYPES.length]!); }
      }}>
      {PAYMENT_TYPES.map((t) => {
        const Icon = ICON[t]; const on = t === value;
        return (
          <button key={t} type="button" role="radio" aria-checked={on} tabIndex={on || (!value && t === 'cash') ? 0 : -1} disabled={disabled} onClick={() => onChange(t)}
            className={cn("grid place-items-center gap-1 rounded-[10px] border py-2 text-caption font-medium transition-colors", on ? "border-brand-forest bg-brand-forest text-white" : "border-border bg-background text-muted-foreground hover:text-foreground", disabled && "opacity-50")}>
            <Icon size={18} stroke={1.75} />{PAYMENT_LABEL[t]}
          </button>
        );
      })}
    </div>
  );
}
