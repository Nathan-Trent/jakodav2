/** How a shop's customer paid (0022). Not Zogal's billing — the shop's own takings. */
export type PaymentType = "cash" | "transfer" | "card" | "pos";
export const PAYMENT_TYPES: PaymentType[] = ["cash", "transfer", "card", "pos"];
export const PAYMENT_LABEL: Record<PaymentType, string> = { cash: "Cash", transfer: "Transfer", card: "Card", pos: "POS" };
