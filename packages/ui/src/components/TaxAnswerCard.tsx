import { useState } from "react";
import { IconChevronDown, IconChevronUp } from "@tabler/icons-react";
import { Badge } from "./ui/badge.js";
import { Card, CardContent } from "./ui/card.js";
import { cn } from "../lib/utils.js";

/**
 * One tax, three plain answers (Nathan, 2026-09-18): do I owe anything
 * right now, when is the next payment, roughly how much — then one thing
 * to do. The working is folded away. No law on the face of the card.
 * Takes plain strings so the UI package needs nothing from the tax engine.
 */
export interface TaxAnswerCardProps {
  name: string;
  state: "nothing" | "coming" | "owes" | "unknown";
  owe: string;
  when: string;
  howMuch: string;
  next: string;
  because: string[];
  draft: boolean;
  /** 0–100 progress towards the threshold, when there is one and it isn't crossed. */
  thresholdPct?: number | null;
}

const STATE: Record<TaxAnswerCardProps["state"], { label: string; badge: "success" | "warning" | "critical" | "secondary"; bar: string }> = {
  nothing: { label: "Nothing owed", badge: "success", bar: "bg-status-green" },
  coming: { label: "Coming up", badge: "warning", bar: "bg-status-amber" },
  owes: { label: "Due soon", badge: "critical", bar: "bg-status-red" },
  unknown: { label: "Not set up", badge: "secondary", bar: "bg-muted-foreground" },
};

export function TaxAnswerCard(p: TaxAnswerCardProps) {
  const [open, setOpen] = useState(false);
  const s = STATE[p.state];
  return (
    <Card className={cn("gap-0 overflow-hidden", p.state === "owes" && "border-status-red/40")}>
      <div className={cn("h-1", s.bar)} />
      <CardContent className="grid gap-4 pt-4">
        <div className="flex items-center justify-between gap-3">
          <div className="text-title">{p.name}</div>
          <div className="flex gap-1.5">
            {p.draft && <Badge variant="outline" className="border-status-amber text-status-amber">Estimate</Badge>}
            <Badge variant={s.badge}>{s.label}</Badge>
          </div>
        </div>

        <dl className="grid gap-3">
          <Answer q="Do you owe anything right now?" a={p.owe} strong />
          <Answer q="When is the next payment?" a={p.when} />
          <Answer q="Roughly how much?" a={p.howMuch} />
        </dl>

        {p.thresholdPct != null && (
          <div className="h-1.5 rounded-full bg-muted overflow-hidden" title="How close you are to the level where this tax starts">
            <div className="h-full rounded-full bg-brand-action" style={{ width: `${Math.min(100, p.thresholdPct)}%` }} />
          </div>
        )}

        <div className="rounded-[10px] bg-muted px-4 py-3 text-small">
          <span className="text-micro text-muted-foreground block mb-1">What to do</span>
          {p.next}
        </div>

        {p.because.length > 0 && (
          <div>
            <button type="button" className="text-caption text-muted-foreground inline-flex items-center gap-1 hover:text-foreground" onClick={() => setOpen((o) => !o)}>
              {open ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />} How we worked this out
            </button>
            {open && <ul className="mt-2 grid gap-1 text-caption text-muted-foreground">{p.because.map((b, i) => <li key={i}>· {b}</li>)}</ul>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Answer({ q, a, strong }: { q: string; a: string; strong?: boolean }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-caption text-muted-foreground">{q}</dt>
      <dd className={cn(strong ? "text-subheading font-bold" : "text-small font-medium")}>{a}</dd>
    </div>
  );
}
