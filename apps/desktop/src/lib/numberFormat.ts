/**
 * Number-box formatting, kept pure so it can be tested without a DOM.
 * Canonical form: "" or digits with an optional dot — no commas, no symbol.
 */

/** Keep digits and at most one dot with at most `decimals` places. */
export function sanitizeNumber(raw: string, decimals: 0 | 2): string {
  let s = raw.replace(/[^0-9.]/g, "");
  if (decimals === 0) return s.replace(/\./g, "").replace(/^0+(?=\d)/, "");
  const dot = s.indexOf(".");
  if (dot !== -1) {
    s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, "").slice(0, decimals);
  }
  // "007" → "7", but keep a lone "0" and "0.5"
  return s.replace(/^0+(?=\d)/, "");
}

/** While typing: commas in the integer part, decimals exactly as typed. */
export function formatNumberLive(canonical: string, decimals: 0 | 2): string {
  if (canonical === "") return "";
  const [int = "", frac] = canonical.split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (decimals === 0) return grouped;
  return frac !== undefined ? `${grouped}.${frac}` : grouped;
}

/** At rest: commas, and money padded to two places ("1,500" → "1,500.00"). */
export function formatNumberAtRest(canonical: string, decimals: 0 | 2): string {
  if (canonical === "") return "";
  const n = Number(canonical);
  if (!Number.isFinite(n)) return "";
  return n.toLocaleString("en-NG", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
