/**
 * Supabase reader cho Module 3 — Kho vận & FBA.
 * Đọc từ public views: vexim_inventory_latest, vexim_inbound_shipments.
 * security_invoker → RLS của bảng gốc vẫn áp.
 */

import { createClient } from "@/lib/supabase/server";
import {
  INVENTORY_SELECT,
  INBOUND_SELECT,
  type InventoryLatestRaw,
  type InboundShipmentRaw,
  readAll,
} from "./inventory-model";

export async function readInventoryLatest(): Promise<InventoryLatestRaw[]> {
  const client = await createClient();
  if (!client) throw new Error("Supabase unavailable");

  return readAll<InventoryLatestRaw>((from, to) =>
    client
      .from("vexim_inventory_latest")
      .select(INVENTORY_SELECT)
      .order("seller_account_id")
      .order("sku")
      .range(from, to),
  );
}

export async function readInboundShipments(): Promise<InboundShipmentRaw[]> {
  const client = await createClient();
  if (!client) throw new Error("Supabase unavailable");

  return readAll<InboundShipmentRaw>((from, to) =>
    client
      .from("vexim_inbound_shipments")
      .select(INBOUND_SELECT)
      .order("created_at", { ascending: false })
      .range(from, to),
  );
}
