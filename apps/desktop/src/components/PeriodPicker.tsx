import { useState } from "react";
import { IconCalendar } from "@tabler/icons-react";
import { Input } from "@/components/ui/input";
import { PERIOD_PRESETS, resolvePreset, type PeriodPreset, type PeriodRange } from "@/lib/periods";

/**
 * "Which period?" — one control, used on every figures screen so the answer
 * to "is this today or this month?" is always in the same place (Nielsen #4).
 * Presets first because that is what people actually ask; custom dates
 * appear only when chosen, so the common case stays one click.
 */
export function PeriodPicker({ value, onChange }: { value: PeriodRange; onChange: (r: PeriodRange) => void }) {
  const [from, setFrom] = useState(value.from);
  const [to, setTo] = useState(value.to);

  function pick(preset: PeriodPreset) {
    if (preset === "custom") { onChange({ from, to, preset, label: "Custom" }); return; }
    onChange(resolvePreset(preset));
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <label className="inline-flex items-center gap-2 text-small text-muted-foreground">
        <IconCalendar size={15} />
        <select
          className="h-9 rounded-md border bg-card px-2 text-sm text-foreground"
          value={value.preset}
          onChange={(e) => pick(e.target.value as PeriodPreset)}
          aria-label="Period"
        >
          {PERIOD_PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
      </label>
      {value.preset === "custom" && (
        <div className="flex items-center gap-1.5">
          <Input type="date" className="h-9 w-[150px]" value={from} max={to} onChange={(e) => { setFrom(e.target.value); if (e.target.value && to) onChange({ from: e.target.value, to, preset: "custom", label: "Custom" }); }} />
          <span className="text-muted-foreground text-small">to</span>
          <Input type="date" className="h-9 w-[150px]" value={to} min={from} onChange={(e) => { setTo(e.target.value); if (from && e.target.value) onChange({ from, to: e.target.value, preset: "custom", label: "Custom" }); }} />
        </div>
      )}
    </div>
  );
}
