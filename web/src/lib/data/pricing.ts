/**
 * Supabase reader cho Module 2 — Giá & Featured Offer.
 * Đọc từ public view: vexim_pricing.
 */

import { createClient } from "@/lib/supabase/server";
import { PRICING_SELECT, type PricingRaw, readAll } from "./pricing-model";

export async function readPricing(): Promise<PricingRaw[]> {
  const client = await createClient();
  if (!client) throw new Error("Supabase unavailable");

  return readAll<PricingRaw>((from, to) =>
    client
      .from("vexim_pricing")
      .select(PRICING_SELECT)
      .order("sku")
      .range(from, to),
  );
}
