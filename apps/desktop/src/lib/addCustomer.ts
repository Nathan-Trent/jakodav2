import { enqueue } from "@zogal/sync";
import type { OfflineCustomerPayload, OfflineCustomerRef } from "@/lib/shopView";

/**
 * SYNC (0026): adding a customer is offline-first, like a sale. The record
 * goes into the outbox first — so it exists on this terminal at once, online
 * or not — and the sync engine uploads it (`replay_offline_customer`,
 * idempotent by client_ref), merging it into the shop's list for every
 * terminal and the dashboard. Online, `syncNow` makes that near-instant.
 *
 * Both the till picker and Customers → Add go through here: one path.
 */
export async function addCustomerOffline(input: {
  shopId: string; userId: string; deviceId: string | null;
  name: string; phone: string | null; note: string | null;
  reloadOverlay: () => Promise<void>;
  syncNow: () => void;
}): Promise<OfflineCustomerRef> {
  const clientRef = crypto.randomUUID();
  const payload: OfflineCustomerPayload = { name: input.name.trim(), phone: input.phone, note: input.note };
  await enqueue({
    kind: "customer", clientRef, shopId: input.shopId, deviceId: input.deviceId,
    userId: input.userId, occurredAt: new Date().toISOString(), payload,
  });
  await input.reloadOverlay();   // shows as 'pending:' in every list right away
  input.syncNow();               // uploads now if we're online; otherwise next tick
  return { client_ref: clientRef, name: payload.name, phone: payload.phone };
}
