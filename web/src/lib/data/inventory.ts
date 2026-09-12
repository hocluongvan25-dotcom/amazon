/**
 * Supabase reader cho Module 3 — Kho vận & FBA.
 * Đọc từ public views:
 *   • vexim_inventory_latest      (0011 + cột giá trị tồn của 0017) — I1/I2/I3
 *   • vexim_inbound_shipments     (0011)                            — I4
 *   • vexim_inventory_fc          (0018) — phân bổ tồn theo FC       — I2
 *   • vexim_inventory_receipts    (0018) — lịch sử nhận hàng         — I2
 *   • vexim_inbound_receipt_shipments (0018) — đối soát nhận theo lô — I4
 * security_invoker → RLS của bảng gốc vẫn áp (chỉ thấy shop mình được gán).
 */

import { createClient } from "@/lib/supabase/server";
import {
  INVENTORY_SELECT,
  INBOUND_SELECT,
  FC_ALLOCATION_SELECT,
  RECEIPT_SELECT,
  RECEIPT_SHIPMENT_SELECT,
  type InventoryLatestRaw,
  type InboundShipmentRaw,
  type FcAllocationRaw,
  type ReceiptRaw,
  type ReceiptShipmentRaw,
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

/**
 * Phân bổ tồn theo FC (snapshot MỚI NHẤT — view đã lọc sẵn).
 * Dữ liệu chỉ có sau khi worker nhập report:
 *   npm run worker:inventory-fc -- --fc=<fba-daily-inventory-history.tsv>
 */
export async function readFcAllocation(): Promise<FcAllocationRaw[]> {
  const client = await createClient();
  if (!client) throw new Error("Supabase unavailable");

  return readAll<FcAllocationRaw>((from, to) =>
    client
      .from("vexim_inventory_fc")
      .select(FC_ALLOCATION_SELECT)
      .order("sku")
      .order("quantity", { ascending: false })
      .range(from, to),
  );
}

/** Lịch sử Amazon thực nhận hàng (từng dòng theo ngày × SKU × lô). */
export async function readReceipts(): Promise<ReceiptRaw[]> {
  const client = await createClient();
  if (!client) throw new Error("Supabase unavailable");

  return readAll<ReceiptRaw>((from, to) =>
    client
      .from("vexim_inventory_receipts")
      .select(RECEIPT_SELECT)
      .order("received_date", { ascending: false })
      .range(from, to),
  );
}

/** Đối soát nhận theo lô: thực nhận (report) so với số gửi (Inbound API). */
export async function readReceiptShipments(): Promise<ReceiptShipmentRaw[]> {
  const client = await createClient();
  if (!client) throw new Error("Supabase unavailable");

  return readAll<ReceiptShipmentRaw>((from, to) =>
    client
      .from("vexim_inbound_receipt_shipments")
      .select(RECEIPT_SHIPMENT_SELECT)
      .order("last_received_date", { ascending: false })
      .range(from, to),
  );
}
