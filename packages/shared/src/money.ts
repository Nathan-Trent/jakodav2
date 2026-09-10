/**
 * Money handling. The DB stores numeric(14,2) NGN; supabase-js returns numeric
 * columns as strings. On the client we keep amounts as integer kobo (bigint-safe
 * within Number range: 14 digits of naira = 16 digits of kobo < 2^53) so no
 * float arithmetic ever touches a price or a cost.
 */

/** Integer kobo. 1 naira = 100 kobo. */
export type Kobo = number & { readonly __brand: "Kobo" };

const KOBO_PER_NAIRA = 100;

/** Parse a DB numeric string ("1500.00") or a number into kobo. */
export function toKobo(value: string | number): Kobo {
  const s = typeof value === "number" ? value.toFixed(2) : value.trim();
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new Error(`invalid money value: ${value}`);
  const sign = m[1] === "-" ? -1 : 1;
  const naira = Number(m[2]);
  const frac = (m[3] ?? "").padEnd(2, "0");
  return (sign * (naira * KOBO_PER_NAIRA + Number(frac))) as Kobo;
}

/** Serialise kobo back to the DB's numeric(14,2) string form. */
export function fromKobo(kobo: Kobo): string {
  const sign = kobo < 0 ? "-" : "";
  const abs = Math.abs(kobo);
  const naira = Math.floor(abs / KOBO_PER_NAIRA);
  const frac = String(abs % KOBO_PER_NAIRA).padStart(2, "0");
  return `${sign}${naira}.${frac}`;
}

export function formatNaira(kobo: Kobo): string {
  return `₦${new Intl.NumberFormat("en-NG", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(kobo / KOBO_PER_NAIRA)}`;
}

export function mulKobo(unit: Kobo, qty: number): Kobo {
  if (!Number.isInteger(qty)) throw new Error("quantity must be an integer");
  return (unit * qty) as Kobo;
}

export function addKobo(...amounts: Kobo[]): Kobo {
  return amounts.reduce((a, b) => a + b, 0) as Kobo;
}
