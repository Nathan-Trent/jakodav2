/**
 * Plain-language errors with a way forward (Nielsen #9: help users
 * recognise, diagnose, recover). Maps DB/RPC error strings and codes to
 * copy a shop assistant can act on. Unknown errors fall through verbatim.
 */
export interface FriendlyError {
  title: string;
  detail?: string;
  /** What to do next. */
  action?: string;
}

const NAIRA = (s: string) => `₦${Number(s).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;

export function friendlyError(e: unknown): FriendlyError {
  const raw = rawMessage(e);
  const code = (e as { code?: string })?.code;

  let m: RegExpMatchArray | null;
  if ((m = raw.match(/below_floor: (.+) sold at ([\d.]+) \(floor ([\d.]+)\)/))) {
    return { title: `${m[1]} is priced below its floor`, detail: `Floor is ${NAIRA(m[3]!)}; you entered ${NAIRA(m[2]!)}.`, action: "Raise the price, or ask a manager to change the floor." };
  }
  if ((m = raw.match(/insufficient_stock: item .* short by (\d+)/))) {
    return { title: "Not enough stock", detail: `You're ${m[1]} unit${m[1] === "1" ? "" : "s"} short — another terminal may have just sold some.`, action: "Reduce the quantity or restock first." };
  }
  if (/invalid PIN/i.test(raw)) return { title: "PIN not recognised", action: "Ask the manager to check their current PIN in their own login — PINs rotate weekly." };
  if (/too many failed PIN attempts/i.test(raw)) return { title: "Too many PIN attempts", action: "Wait 15 minutes, then try again." };
  if (/invalid or expired activation code/i.test(raw)) return { title: "Activation code not valid", action: "Codes last 10 minutes. Ask the owner to generate a new one." };
  if (/unknown or revoked device/i.test(raw)) return { title: "This terminal has been revoked", action: "Ask the owner to activate it again." };
  if (/permission denied: ([\w.]+)/.test(raw)) {
    const perm = raw.match(/permission denied: ([\w.]+)/)![1]!;
    return { title: "You don't have permission for that", detail: `Needs “${PERMISSION_NAMES[perm] ?? perm}”.`, action: "Ask the shop owner to grant it." };
  }
  if (/a shop must keep at least one active Owner/i.test(raw)) return { title: "A shop needs at least one owner", action: "Make someone else an owner first." };
  if (/suggested price must be at least the floor/i.test(raw)) return { title: "Suggested price is below the floor", action: "Set the suggested price at or above the floor price." };
  if (/Email not confirmed/i.test(raw)) return { title: "Email not confirmed yet", action: "Open the confirmation link we emailed you, then sign in." };
  if (/Invalid login credentials/i.test(raw)) return { title: "Email or password is wrong", action: "Check both and try again." };
  if (/item_has_barcode|barcodes_one_per_item/i.test(raw)) {
    return { title: "This item already has a barcode", detail: "An item carries exactly one code, so labels never disagree.", action: "Remove the existing barcode first, then generate or attach a new one." };
  }
  if (code === "23505" || /duplicate key|unique constraint/i.test(raw)) {
    if (/barcodes/.test(raw)) return { title: "That barcode is already used in this shop", action: "Check which item has it, or generate a new one." };
    if (/roles/.test(raw)) return { title: "A role with that key already exists", action: "Pick a different key." };
    return { title: "That already exists", action: "Use a different value." };
  }
  if (/Failed to fetch|NetworkError|ERR_INTERNET|fetch failed/i.test(raw)) {
    // Sales queue offline and never reach here. Anything that does is an
    // action that genuinely needs the server, so say what to do — don't
    // imply the whole app is broken.
    return { title: "Can't reach the server", detail: "This change needs a connection and wasn't saved.", action: "It will work again as soon as you're back online. Sales keep working offline." };
  }
  if (code === "PGRST202" || /Could not find the function/i.test(raw)) {
    return { title: "The database is behind the app", detail: raw, action: "Run the latest migration in Supabase." };
  }
  return { title: raw || "Something went wrong" };
}

const PERMISSION_NAMES: Record<string, string> = {
  "sales.create": "Record sales",
  "items.create": "Add items",
  "items.edit": "Edit items",
  "items.edit_floor_price": "Change floor prices",
  "items.view_cost": "See cost prices",
  "purchases.create": "Record purchases",
  "purchases.correct_cost": "Correct batch costs",
  "shop.settings": "Shop settings",
  "users.manage": "Manage staff",
  "roles.manage": "Manage roles",
  "overrides.approve": "Approve overrides",
};

function rawMessage(e: unknown): string {
  if (e && typeof e === "object") {
    const o = e as { message?: unknown; issues?: { message: string }[]; details?: unknown; hint?: unknown };
    if (Array.isArray(o.issues) && o.issues[0]) return o.issues[0].message;
    if (typeof o.message === "string") return o.message;
  }
  return String(e);
}
