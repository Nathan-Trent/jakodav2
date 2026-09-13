import * as React from "react";
import { cn } from "../../lib/utils.js";
import { formatNumberAtRest as format, formatNumberLive as formatLive, sanitizeNumber as sanitize } from "../../lib/numberFormat.js";

/**
 * A number box that behaves like a person expects.
 *
 * Why not <input type="number">:
 *  - it cannot show thousands separators, so ₦1500000 reads as one blur;
 *  - our handlers used to coerce every keystroke (`Number(v) || 1`), which
 *    meant the box could never be EMPTY — clear it and it snapped back to 1.
 *    You had to select-all and overtype, which nobody discovers.
 *
 * This is a text box with a numeric keyboard hint. It keeps its own draft,
 * so it can be empty while you type; it formats commas live and keeps the
 * caret where you were; and it reports a clean canonical string upward
 * ("" for empty, else digits with an optional dot, no commas).
 *
 * The value it reports is the SOURCE OF TRUTH for validation: "" means the
 * user has not given a number yet, and callers treat that as "required",
 * never as zero.
 */
export interface NumberFieldProps extends Omit<React.ComponentProps<"input">, "value" | "onChange" | "type" | "inputMode"> {
  /** Canonical value: "" or a plain number string like "1500" / "1500.50". */
  value: string;
  onChange: (canonical: string) => void;
  /** 0 for counts, 2 for money. */
  decimals?: 0 | 2;
  /** Shown inside the box, before the number (e.g. "₦"). */
  prefix?: string;
  /** Inclusive lower bound; below it the box is marked invalid, not clamped. */
  min?: number;
}

export function NumberField({ value, onChange, decimals = 2, prefix, min, className, onBlur, onFocus, ...rest }: NumberFieldProps) {
  const [draft, setDraft] = React.useState(() => format(value, decimals));
  const [focused, setFocused] = React.useState(false);
  const ref = React.useRef<HTMLInputElement>(null);
  const caret = React.useRef<number | null>(null);

  // External change while not editing → re-format (e.g. a reset after save).
  React.useEffect(() => {
    if (!focused) setDraft(format(value, decimals));
  }, [value, decimals, focused]);

  // Put the caret back after we re-format the string underneath it.
  React.useLayoutEffect(() => {
    if (caret.current !== null && ref.current) {
      ref.current.setSelectionRange(caret.current, caret.current);
      caret.current = null;
    }
  });

  const invalid = value !== "" && min !== undefined && Number(value) < min;

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value;
    const selStart = e.target.selectionStart ?? raw.length;
    // How many "real" characters sit before the caret; commas don't count.
    const significantBefore = raw.slice(0, selStart).replace(/[^0-9.]/g, "").length;

    const canonical = sanitize(raw, decimals);
    const shown = formatLive(canonical, decimals);

    // Walk the formatted string until we've passed the same number of real
    // characters, and park the caret there.
    let seen = 0, pos = 0;
    while (pos < shown.length && seen < significantBefore) {
      if (/[0-9.]/.test(shown[pos]!)) seen++;
      pos++;
    }
    caret.current = pos;

    setDraft(shown);
    onChange(canonical);
  }

  return (
    <div className={cn("relative", className)}>
      {prefix && (
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground select-none">
          {prefix}
        </span>
      )}
      <input
        ref={ref}
        type="text"
        inputMode={decimals === 0 ? "numeric" : "decimal"}
        autoComplete="off"
        spellCheck={false}
        value={draft}
        aria-invalid={invalid || rest["aria-invalid"]}
        onChange={handleChange}
        onFocus={(e) => { setFocused(true); onFocus?.(e); }}
        onBlur={(e) => { setFocused(false); setDraft(format(value, decimals)); onBlur?.(e); }}
        className={cn(
          "h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm tabular-nums shadow-xs transition-[color,box-shadow] outline-none",
          "placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
          "aria-invalid:border-destructive aria-invalid:ring-destructive/20 disabled:cursor-not-allowed disabled:opacity-50",
          prefix && "pl-7",
        )}
        {...rest}
      />
    </div>
  );
}
