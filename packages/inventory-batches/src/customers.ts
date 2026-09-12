import type { SupabaseClient } from "@supabase/supabase-js";
import type { CustomerRow } from "@zogal/shared";
import { z } from "zod";

/**
 * Customers (0012): the shop's list of known buyers. Optional on every
 * sale; a plain contact record. Anyone who can sell may add one at the
 * till; editing needs `customers.manage` (RLS enforces both).
 */

const phone = z.string().trim().regex(/^\+?[0-9]{7,15}$/, "Phone should be digits only, 7–15 long");

export const NewCustomerSchema = z.object({
  shopId: z.uuid(),
  name: z.string().trim().min(1).max(120),
  phone: phone.nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  createdBy: z.uuid(),
});
export type NewCustomer = z.infer<typeof NewCustomerSchema>;

export const CustomerEditSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(120),
  phone: phone.nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  isActive: z.boolean().optional(),
});
export type CustomerEdit = z.infer<typeof CustomerEditSchema>;

export async function listCustomers(db: SupabaseClient, shopId: string): Promise<CustomerRow[]> {
  const { data, error } = await db
    .from("customers")
    .select<"*", CustomerRow>()
    .eq("shop_id", shopId)
    .order("name");
  if (error) throw error;
  return data;
}

export async function createCustomer(db: SupabaseClient, input: NewCustomer): Promise<CustomerRow> {
  const v = NewCustomerSchema.parse(input);
  const { data, error } = await db
    .from("customers")
    .insert({ shop_id: v.shopId, name: v.name, phone: v.phone || null, note: v.note || null, created_by: v.createdBy })
    .select<"*", CustomerRow>()
    .single();
  if (error) throw error;
  return data;
}

export async function updateCustomer(db: SupabaseClient, input: CustomerEdit): Promise<CustomerRow> {
  const v = CustomerEditSchema.parse(input);
  const patch: Partial<CustomerRow> = { name: v.name, phone: v.phone || null, note: v.note || null };
  if (v.isActive !== undefined) patch.is_active = v.isActive;
  const { data, error } = await db
    .from("customers")
    .update(patch)
    .eq("id", v.id)
    .select<"*", CustomerRow>()
    .single();
  if (error) throw error;
  return data;
}

/** Normalise what a cashier types so "0803 123 4567" matches "08031234567". */
export function normalisePhone(raw: string): string {
  return raw.replace(/[\s\-().]/g, "");
}
