/**
 * Supabase reader cho PHÍ THEO FC (0019).
 *
 *   • vexim_storage_fees             — I2: phí lưu kho của một SKU theo FC/tháng
 *   • vexim_storage_fee_by_fc        — Overview: PHÂN BỔ PHÍ LƯU KHO THEO FC
 *   • vexim_inbound_issues           — I4: từng vấn đề khi Amazon nhận lô + phí
 *   • vexim_inbound_issue_shipments  — I4: gộp vấn đề theo lô
 *   • vexim_report_requests          — Module 0: cron Reports API đang ở đâu
 *
 * Cả 5 view đều `security_invoker` → RLS bảng gốc vẫn áp: user chỉ thấy shop
 * mình được gán (iam.can_read_seller_account).
 *
 * Dữ liệu chỉ có sau khi worker kéo report:
 *   npm run worker:reports-pull                       (tự gọi Reports API)
 *   npm run worker:reports-pull -- --storage-fees=<tsv> --noncompliance=<tsv>
 * hoặc Vercel Cron /api/cron/report-pull chạy mỗi ngày 03:00 UTC.
 */

import { createClient } from "@/lib/supabase/server";
import { readAll } from "./inventory-model";
import {
  INBOUND_ISSUE_SELECT,
  INBOUND_ISSUE_SHIPMENT_SELECT,
  REPORT_REQUEST_SELECT,
  STORAGE_FEE_BY_FC_SELECT,
  STORAGE_FEE_SELECT,
  type InboundIssueRaw,
  type InboundIssueShipmentRaw,
  type ReportRequestRaw,
  type StorageFeeByFcRaw,
  type StorageFeeRaw,
} from "./fees-model";

export async function readStorageFees(): Promise<StorageFeeRaw[]> {
  const client = await createClient();
  if (!client) throw new Error("Supabase unavailable");
  return readAll<StorageFeeRaw>((from, to) =>
    client
      .from("vexim_storage_fees")
      .select(STORAGE_FEE_SELECT)
      .order("month_of_charge", { ascending: false })
      .order("fulfillment_center")
      .range(from, to),
  );
}

export async function readStorageFeeByFc(): Promise<StorageFeeByFcRaw[]> {
  const client = await createClient();
  if (!client) throw new Error("Supabase unavailable");
  return readAll<StorageFeeByFcRaw>((from, to) =>
    client
      .from("vexim_storage_fee_by_fc")
      .select(STORAGE_FEE_BY_FC_SELECT)
      .order("month_of_charge", { ascending: false })
      .order("storage_fee", { ascending: false })
      .range(from, to),
  );
}

export async function readInboundIssues(): Promise<InboundIssueRaw[]> {
  const client = await createClient();
  if (!client) throw new Error("Supabase unavailable");
  return readAll<InboundIssueRaw>((from, to) =>
    client
      .from("vexim_inbound_issues")
      .select(INBOUND_ISSUE_SELECT)
      .order("issue_reported_date", { ascending: false })
      .order("shipment_id")
      .range(from, to),
  );
}

export async function readInboundIssueShipments(): Promise<InboundIssueShipmentRaw[]> {
  const client = await createClient();
  if (!client) throw new Error("Supabase unavailable");
  return readAll<InboundIssueShipmentRaw>((from, to) =>
    client
      .from("vexim_inbound_issue_shipments")
      .select(INBOUND_ISSUE_SHIPMENT_SELECT)
      .order("last_issue_date", { ascending: false })
      .order("fee_total", { ascending: false })
      .range(from, to),
  );
}

/**
 * Trạng thái cron Reports API — màn Sync health (Module 0).
 * Dùng readAll + range như các reader khác: client Supabase của repo không có
 * generated types nên `.limit()` trả GenericStringError[] (lỗi biên dịch), còn
 * readAll nhận `unknown[]` rồi ép kiểu ở đây.
 */
export async function readReportRequests(): Promise<ReportRequestRaw[]> {
  const client = await createClient();
  if (!client) throw new Error("Supabase unavailable");
  return readAll<ReportRequestRaw>((from, to) =>
    client
      .from("vexim_report_requests")
      .select(REPORT_REQUEST_SELECT)
      .order("requested_at", { ascending: false })
      .range(from, to),
  );
}
