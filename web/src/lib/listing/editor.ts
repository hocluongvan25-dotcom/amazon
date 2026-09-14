/**
 * Supabase reader/writer cho L3 — Listing Editor.
 * Đọc/ghi qua public view + bảng staging của migration 0014:
 *   • vexim_listing_drafts        (đọc danh sách + chi tiết bản nháp)
 *   • vexim_listing_draft_history (lịch sử append-only)
 *   • vexim_listing_publish_queue (hàng đợi publish, worker gửi Amazon)
 *   • catalog.listing_drafts      (ghi: lưu nháp, gửi duyệt, duyệt/từ chối, publish)
 *
 * NGUYÊN TẮC:
 *   • Dùng anon client + cookie phiên user → RLS quyết định phạm vi shop.
 *   • KHÔNG dùng service_role ở đây (worker mới cần service_role để ghi kết quả Amazon).
 *   • Mọi thay đổi nội dung đều đi qua validateListingDraft trước khi ghi, và
 *     trigger DB kiểm tra lại lần nữa (cổng validation + máy trạng thái + 4 mắt).
 */

import { createClient } from "@/lib/supabase/server";
import {
  deriveCanWrite,
  diffPayload,
  filterConnectedShops,
  validateListingDraft,
  type DraftStatus,
  type ListingDraftPayload,
  type ValidationReport,
} from "@/lib/listing/editor-model.ts";

/* ------------------------------------------------------------------ */
/* Kiểu dữ liệu                                                       */
/* ------------------------------------------------------------------ */

export type DraftRaw = {
  id: string;
  seller_account_id: string;
  shop: string;
  seller_id: string | null;
  sku: string;
  asin: string | null;
  marketplace_id: string;
  product_type: string;
  requirements: string;
  locale: string;
  status: string;
  payload: unknown;
  validation: unknown;
  revision: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  submitted_by: string | null;
  decided_at: string | null;
  decided_by: string | null;
  decision_note: string | null;
  published_at: string | null;
  publish_submission_id: string | null;
  publish_status: string | null;
  publish_issues: unknown;
};

export type RevisionRaw = {
  id: string;
  draft_id: string;
  seller_account_id: string;
  shop: string;
  sku: string;
  revision: number;
  stage: string;
  actor_id: string | null;
  note: string | null;
  changed_fields: string[] | null;
  after_payload: unknown;
  validation: unknown;
  created_at: string;
};

export type QueueRaw = {
  id: string;
  draft_id: string;
  seller_account_id: string;
  shop: string;
  sku: string;
  marketplace_id: string;
  product_type: string;
  requirements: string;
  method: string;
  status: string;
  block_reason: string | null;
  attempts: number;
  submission_id: string | null;
  issues: unknown;
  last_error: string | null;
  created_at: string;
  processed_at: string | null;
};

export const DRAFT_SELECT =
  "id,seller_account_id,shop,seller_id,sku,asin,marketplace_id,product_type,requirements,locale,status,payload,validation,revision,created_by,updated_by,created_at,updated_at,submitted_at,submitted_by,decided_at,decided_by,decision_note,published_at,publish_submission_id,publish_status,publish_issues";

export const REVISION_SELECT =
  "id,draft_id,seller_account_id,shop,sku,revision,stage,actor_id,note,changed_fields,after_payload,validation,created_at";

export const QUEUE_SELECT =
  "id,draft_id,seller_account_id,shop,sku,marketplace_id,product_type,requirements,method,status,block_reason,attempts,submission_id,issues,last_error,created_at,processed_at";

/* ------------------------------------------------------------------ */
/* Đọc                                                                */
/* ------------------------------------------------------------------ */

export async function readDrafts(limit = 200): Promise<DraftRaw[]> {
  const client = await createClient();
  if (!client) throw new Error("Supabase unavailable");
  const { data, error } = await client
    .from("vexim_listing_drafts")
    .select(DRAFT_SELECT)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Không đọc được vexim_listing_drafts: ${error.message}`);
  return (data ?? []) as DraftRaw[];
}

export async function readDraft(id: string): Promise<DraftRaw | null> {
  const client = await createClient();
  if (!client) throw new Error("Supabase unavailable");
  const { data, error } = await client
    .from("vexim_listing_drafts")
    .select(DRAFT_SELECT)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Không đọc được bản nháp: ${error.message}`);
  return (data as DraftRaw | null) ?? null;
}

export async function readDraftHistory(draftId: string, limit = 100): Promise<RevisionRaw[]> {
  const client = await createClient();
  if (!client) throw new Error("Supabase unavailable");
  const { data, error } = await client
    .from("vexim_listing_draft_history")
    .select(REVISION_SELECT)
    .eq("draft_id", draftId)
    .order("revision", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Không đọc được lịch sử bản nháp: ${error.message}`);
  return (data ?? []) as RevisionRaw[];
}

export async function readPublishQueue(limit = 100): Promise<QueueRaw[]> {
  const client = await createClient();
  if (!client) throw new Error("Supabase unavailable");
  const { data, error } = await client
    .from("vexim_listing_publish_queue")
    .select(QUEUE_SELECT)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Không đọc được hàng đợi publish: ${error.message}`);
  return (data ?? []) as QueueRaw[];
}

/**
 * Đọc JSON Schema product type đã cache (worker tải bằng getDefinitionsProductType
 * — Product Type Definitions API 2020-09-01, xem `worker/src/runtime/run-listing-schema.ts`).
 *
 * Có schema → form động dùng `required` / `maxLength` / `enum` THẬT của Amazon;
 * chưa có (cache trống, worker chưa chạy) → dùng bảng hạn mức nội bộ, và
 * ValidationReport.source ghi rõ "vexim-policy" để người soạn biết.
 */
export async function readProductTypeSchema(input: {
  marketplaceId: string;
  productType: string;
  requirements: string;
}): Promise<unknown | null> {
  const client = await createClient();
  if (!client) return null;
  const { data, error } = await client
    .from("vexim_listing_product_type_schemas")
    .select("schema")
    .eq("marketplace_id", input.marketplaceId)
    .eq("product_type", input.productType)
    .eq("requirements", input.requirements)
    .maybeSingle();
  // Cache là tuỳ chọn: lỗi/không có cũng không được làm hỏng trình soạn thảo.
  if (error) return null;
  return (data as { schema?: unknown } | null)?.schema ?? null;
}

/* ------------------------------------------------------------------ */
/* Ánh xạ dữ liệu thô → model UI                                      */
/* ------------------------------------------------------------------ */

export function toDraftStatus(raw: string): DraftStatus {
  const allowed: DraftStatus[] = [
    "draft",
    "pending_approval",
    "approved",
    "rejected",
    "publishing",
    "published",
    "failed",
  ];
  return (allowed as string[]).includes(raw) ? (raw as DraftStatus) : "draft";
}

export function asPayload(raw: unknown): ListingDraftPayload {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as ListingDraftPayload) : {};
}

export function asValidation(raw: unknown): ValidationReport | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Partial<ValidationReport>;
  if (typeof v.errorCount !== "number" || !Array.isArray(v.issues)) return null;
  return v as ValidationReport;
}

/* ------------------------------------------------------------------ */
/* Ghi (RLS enforced)                                                 */
/* ------------------------------------------------------------------ */

export type WriteResult<T> = { ok: true; data: T } | { ok: false; error: string; status: number };

function friendlyDbError(message: string): { error: string; status: number } {
  // Trigger 0014 raise các thông điệp '[L3] …' — trả nguyên văn tiếng Việt cho UI
  if (message.includes("[L3]")) return { error: message.split("\n")[0], status: 409 };
  if (message.includes("row-level security") || message.includes("permission denied"))
    return { error: "Bạn không có quyền trên shop này (RLS).", status: 403 };
  if (message.includes("duplicate key"))
    return { error: "Đã có bản nháp cho SKU này ở shop này.", status: 409 };
  return { error: message, status: 400 };
}

export type SaveDraftInput = {
  sellerAccountId: string;
  sku: string;
  asin?: string | null;
  productType: string;
  requirements: string;
  marketplaceId: string;
  locale: string;
  payload: ListingDraftPayload;
  productTypeSchema?: unknown;
  brand?: string | null;
  /** Bản nháp đang có (nếu là sửa) — dùng để tính diff + revision */
  existing?: DraftRaw | null;
};

export type SaveDraftOutcome = {
  draftId: string;
  revision: number;
  validation: ValidationReport;
  changedFields: string[];
  created: boolean;
};

/**
 * Lưu bản nháp (tạo mới hoặc cập nhật nội dung đang soạn).
 * Luôn chạy validation và lưu snapshot vào cột `validation` — trigger DB dùng
 * `validation.errorCount` làm cổng chặn gửi duyệt.
 */
export async function saveListingDraft(input: SaveDraftInput): Promise<WriteResult<SaveDraftOutcome>> {
  const client = await createClient();
  if (!client) return { ok: false, error: "Supabase chưa cấu hình", status: 500 };

  const validation = validateListingDraft({
    payload: input.payload,
    productType: input.productType,
    marketplaceId: input.marketplaceId,
    locale: input.locale,
    productTypeSchema: input.productTypeSchema,
    brand: input.brand,
  });

  const existing = input.existing ?? null;
  const editableStatus = ["draft", "rejected", "failed"];
  if (existing && !editableStatus.includes(existing.status)) {
    return {
      ok: false,
      status: 409,
      error:
        `Bản nháp đang ở trạng thái "${existing.status}" — phải đưa về draft trước khi sửa nội dung ` +
        `(trigger 0014 chặn sửa lén sau khi đã duyệt).`,
    };
  }

  const changedFields = existing
    ? diffPayload(asPayload(existing.payload), input.payload)
    : Object.keys(input.payload);

  // Ghi qua RPC public (0014 §7B): không phụ thuộc việc project có expose schema
  // `catalog` hay không — đúng bài học PGRST202/205 của migration 0008.
  const { data, error } = await client.rpc("vexim_save_listing_draft", {
    p_draft_id: existing?.id ?? null,
    p_seller: input.sellerAccountId,
    p_sku: input.sku,
    p_product_type: input.productType,
    p_requirements: input.requirements,
    p_marketplace_id: input.marketplaceId,
    p_locale: input.locale,
    p_payload: input.payload,
    p_validation: validation,
    p_asin: input.asin ?? null,
  });
  if (error) return { ok: false, ...friendlyDbError(error.message) };

  const row = Array.isArray(data)
    ? (data[0] as { draft_id: string; revision: number; created: boolean } | undefined)
    : undefined;
  if (!row?.draft_id) return { ok: false, status: 400, error: "RPC không trả về bản nháp." };

  return {
    ok: true,
    data: {
      draftId: row.draft_id,
      revision: row.revision,
      validation,
      changedFields,
      created: row.created === true,
    },
  };
}

export type TransitionInput = {
  draftId: string;
  action: "submit" | "approve" | "reject" | "withdraw" | "publish" | "mark_published" | "reopen";
  note?: string;
};

const ACTION_TO_STATUS: Record<TransitionInput["action"], DraftStatus> = {
  submit: "pending_approval",
  approve: "approved",
  reject: "rejected",
  withdraw: "draft",
  publish: "publishing",
  mark_published: "published",
  reopen: "draft",
};

/**
 * Chuyển trạng thái bản nháp qua RPC `vexim_transition_listing_draft`:
 *   • RPC kiểm tra quyền lớp 1 và (với action publish) đẩy hàng đợi publish.
 *   • Trigger 0014 là chốt cuối: máy trạng thái + 4 mắt + cổng validation
 *     (validation.errorCount = 0 mới cho sang pending_approval/approved/publishing).
 */
export async function transitionListingDraft(
  input: TransitionInput,
): Promise<WriteResult<{ draftId: string; status: DraftStatus }>> {
  const client = await createClient();
  if (!client) return { ok: false, error: "Supabase chưa cấu hình", status: 500 };

  const { data, error } = await client.rpc("vexim_transition_listing_draft", {
    p_draft_id: input.draftId,
    p_action: input.action,
    p_note: input.note ?? null,
  });
  if (error) return { ok: false, ...friendlyDbError(error.message) };

  const row = Array.isArray(data)
    ? (data[0] as { draft_id: string; status: string } | undefined)
    : undefined;
  if (!row?.draft_id) return { ok: false, status: 400, error: "RPC không trả về trạng thái mới." };
  return {
    ok: true,
    data: { draftId: row.draft_id, status: toDraftStatus(row.status ?? ACTION_TO_STATUS[input.action]) },
  };
}

/* ------------------------------------------------------------------ */
/* Tiện ích cho UI (thuần, test được)                                  */
/* ------------------------------------------------------------------ */

export const STAGE_LABEL: Record<string, string> = {
  created: "Tạo bản nháp",
  saved: "Lưu thay đổi",
  submitted: "Gửi duyệt",
  approved: "Trưởng phòng duyệt",
  rejected: "Từ chối",
  publishing: "Đưa vào hàng đợi publish",
  published: "Đã publish",
  failed: "Gửi Amazon lỗi",
  reopened: "Mở lại để sửa",
};

export function stageLabel(stage: string): string {
  return STAGE_LABEL[stage] ?? stage;
}

export const QUEUE_STATUS_LABEL: Record<string, string> = {
  queued: "Chờ gửi",
  blocked: "Bị chặn (hạn chế danh mục)",
  sent: "Đã gửi Amazon",
  accepted: "Amazon nhận (ACCEPTED)",
  invalid: "Amazon từ chối (INVALID)",
  failed: "Gửi lỗi",
};

export function queueStatusLabel(status: string): string {
  return QUEUE_STATUS_LABEL[status] ?? status;
}

/* ------------------------------------------------------------------ */
/* Ngữ cảnh người soạn (quyền thật lấy từ DB, không tin client)        */
/* ------------------------------------------------------------------ */

export type EditorActor = {
  userId: string | null;
  email: string | null;
  /** Có quyền ghi trên shop này (iam.assignments.can_write) */
  canWrite: boolean;
  /** Trưởng phòng Listing / super_admin / org_admin (iam.role_assignments) */
  isApprover: boolean;
};

/**
 * Quyền của người đang đăng nhập đối với một shop.
 * Đây chỉ là lớp GỢI Ý cho UI (ẩn/hiện nút); quyền thật do RLS + trigger 0014
 * quyết định khi ghi.
 */
export async function readEditorActor(sellerAccountId: string): Promise<EditorActor> {
  const client = await createClient();
  if (!client) throw new Error("Supabase unavailable");

  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) return { userId: null, email: null, canWrite: false, isApprover: false };

  const [{ data: assignments }, { data: roles }] = await Promise.all([
    client
      .schema("iam")
      .from("assignments")
      .select("can_write")
      .eq("user_id", user.id)
      .eq("seller_account_id", sellerAccountId),
    client.schema("iam").from("role_assignments").select("role,department_id").eq("user_id", user.id),
  ]);

  const roleRows = (roles ?? []) as { role: string; department_id: string | null }[];
  const canWrite = deriveCanWrite(
    roleRows,
    (assignments ?? []) as { can_write?: boolean }[],
  );
  let isApprover = roleRows.some((r) => r.role === "super_admin" || r.role === "org_admin");
  if (!isApprover && roleRows.some((r) => r.role === "dept_lead")) {
    const { data: dept } = await client.schema("iam").from("departments").select("id").eq("code", "listing").maybeSingle();
    const listingDeptId = (dept as { id?: string } | null)?.id ?? null;
    isApprover = roleRows.some((r) => r.role === "dept_lead" && r.department_id === listingDeptId);
  }

  return { userId: user.id, email: user.email ?? null, canWrite, isApprover };
}

/** Shop có thể chọn để soạn listing (lấy từ listing đã đồng bộ về). */
/**
 * Danh sách shop cho bộ chọn ở màn soạn listing.
 *
 * FIX 09/2026: trước đây đọc từ view `vexim_listings` (distinct theo
 * seller_account_id) → shop VỪA KẾT NỐI OAuth nhưng CHƯA đồng bộ listing
 * không xuất hiện, dropdown trống dù kết nối thành công. Nguyên tắc đúng
 * (đã áp dụng ở cost-inputs): bộ chọn shop KHÔNG được phụ thuộc dữ liệu đã
 * sync — đọc thẳng view `vexim_shops` (nguồn connections.seller_accounts,
 * RLS lọc theo quyền), shop mới tinh vẫn chọn được ngay.
 * Fallback `vexim_listings` giữ cho môi trường chưa chạy migration 0024
 * (vexim_shops được tạo lại ở 0024 với cột mới).
 */
export async function readShopOptions(): Promise<{ sellerAccountId: string; shop: string }[]> {
  const client = await createClient();
  if (!client) throw new Error("Supabase unavailable");

  const { data, error } = await client
    .from("vexim_shops")
    .select("seller_account_id,shop,status,data_source")
    .order("shop");
  if (!error && data) {
    const shops = (data as { seller_account_id: string; shop: string; status?: string | null }[])
      .filter((r) => r.status !== "revoked")
      .map((r) => ({ sellerAccountId: r.seller_account_id, shop: r.shop }));

    // FIX 09/2026: CHỈ hiện shop ĐÃ KẾT NỐI Amazon (token OAuth còn hiệu lực).
    // Publish đi qua SP-API bằng refresh token per-shop — shop chưa kết nối
    // thì soạn xong cũng không đăng được; hiện ra chỉ gây chọn nhầm.
    // Đọc view vexim_oauth_connections (0020) — cùng nguồn với trang Kết nối shop.
    try {
      const tokens = await client
        .from("vexim_oauth_connections")
        .select("seller_account_id,is_active");
      if (!tokens.error && tokens.data) {
        return filterConnectedShops(
          shops,
          tokens.data as { seller_account_id: string; is_active?: boolean | null }[],
        );
      }
    } catch {
      // View chưa có (DB cũ chưa chạy 0020) — giữ nguyên danh sách, không chặn oan.
    }
    return shops;
  }

  // Fallback: DB chưa có view vexim_shops (chưa chạy 0024) — cách cũ,
  // chỉ thấy shop đã có listing đồng bộ.
  const legacy = await client
    .from("vexim_listings")
    .select("seller_account_id,shop")
    .order("shop")
    .limit(1000);
  if (legacy.error) throw new Error(`Không đọc được danh sách shop: ${legacy.error.message}`);
  const seen = new Map<string, string>();
  for (const row of (legacy.data ?? []) as { seller_account_id: string; shop: string }[]) {
    if (!seen.has(row.seller_account_id)) seen.set(row.seller_account_id, row.shop);
  }
  return [...seen.entries()].map(([sellerAccountId, shop]) => ({ sellerAccountId, shop }));
}
