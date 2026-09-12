/**
 * API L3 — hành động trên bản nháp listing.
 *
 *   POST /api/listing/drafts
 *     { action: "save", ... }                       → lưu/khởi tạo bản nháp
 *     { action: "submit"|"approve"|"reject"|"withdraw"|"publish"|"reopen", draftId, note? }
 *
 * NGUYÊN TẮC:
 *   • Chạy bằng anon client + cookie phiên user → RLS + trigger 0014 quyết định quyền.
 *   • Validation được tính LẠI ở server trước khi ghi: snapshot `validation` trong DB
 *     là cổng chặn của trigger (validation->>'errorCount' = 0 mới cho gửi duyệt).
 *   • DEMO MODE (chưa cấu hình Supabase) trả 409 và nói rõ lý do — không giả lập thành công.
 */

import { NextResponse } from "next/server";

import { getAppSession } from "@/lib/auth/session";
import {
  asPayload,
  readDraft,
  readDraftHistory,
  readProductTypeSchema,
  saveListingDraft,
  stageLabel,
  toDraftStatus,
  transitionListingDraft,
} from "@/lib/listing/editor";
import {
  validateListingDraft,
  type DraftStatus,
  type ListingDraftPayload,
  type ListingRequirements,
} from "@/lib/listing/editor-model.ts";

const TRANSITIONS: Record<string, "submit" | "approve" | "reject" | "withdraw" | "publish" | "reopen"> = {
  submit: "submit",
  approve: "approve",
  reject: "reject",
  withdraw: "withdraw",
  publish: "publish",
  reopen: "reopen",
};

export async function POST(req: Request) {
  const session = await getAppSession();
  if (!session) return NextResponse.json({ error: "Chưa đăng nhập" }, { status: 401 });
  if (session.mode !== "supabase") {
    return NextResponse.json(
      {
        error:
          "DEMO MODE: chưa cấu hình Supabase nên không lưu được bản nháp (cần RLS + trigger 0014 trong DB thật).",
      },
      { status: 409 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Body không phải JSON" }, { status: 400 });
  }

  const action = String(body.action ?? "");

  /* ---------------- Chuyển trạng thái ---------------- */
  if (action in TRANSITIONS) {
    const draftId = String(body.draftId ?? "");
    if (!draftId) return NextResponse.json({ error: "Thiếu draftId" }, { status: 400 });

    const result = await transitionListingDraft({
      draftId,
      action: TRANSITIONS[action],
      note: typeof body.note === "string" ? body.note : undefined,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

    const history = await readDraftHistory(draftId, 20).catch(() => []);
    return NextResponse.json({
      ok: true,
      action,
      draftId,
      status: result.data.status,
      statusLabel: result.data.status,
      history: history.map((row) => ({
        revision: row.revision,
        stage: row.stage,
        stageLabel: stageLabel(row.stage),
        note: row.note,
        changedFields: row.changed_fields ?? [],
        actorId: row.actor_id,
        createdAt: row.created_at,
      })),
    });
  }

  if (action !== "save") {
    return NextResponse.json({ error: `action không hỗ trợ: ${action}` }, { status: 400 });
  }

  /* ---------------- Lưu bản nháp ---------------- */
  const sellerAccountId = String(body.sellerAccountId ?? "");
  const sku = String(body.sku ?? "").trim();
  const productType = String(body.productType ?? "").trim();
  const requirements = (String(body.requirements ?? "LISTING") || "LISTING") as ListingRequirements;
  const marketplaceId = String(body.marketplaceId ?? "ATVPDKIKX0DER");
  const locale = String(body.locale ?? "en_US");
  const asin = body.asin ? String(body.asin) : null;
  const payload = (body.payload ?? {}) as ListingDraftPayload;

  if (!sellerAccountId || !sku || !productType) {
    return NextResponse.json({ error: "Thiếu sellerAccountId / sku / productType" }, { status: 400 });
  }
  if (typeof payload !== "object" || Array.isArray(payload)) {
    return NextResponse.json({ error: "payload phải là object attributes" }, { status: 400 });
  }

  // Validation chạy ở SERVER — snapshot trong DB là căn cứ của trigger 0014.
  // Schema product type lấy từ CACHE trong DB (worker tải bằng
  // getDefinitionsProductType), KHÔNG tin schema do client gửi lên: nếu tin,
  // client có thể gửi schema rỗng để bỏ qua bước kiểm tra trường bắt buộc.
  const productTypeSchema = await readProductTypeSchema({ marketplaceId, productType, requirements });
  const validation = validateListingDraft({
    payload,
    productType,
    marketplaceId,
    locale,
    requirements,
    productTypeSchema,
    brand: typeof body.brand === "string" ? body.brand : null,
  });

  // Bản nháp đang có (nếu đang sửa) — cần để chặn sửa khi đã duyệt + tính diff.
  const existing = body.draftId ? await readDraft(String(body.draftId)) : null;
  if (body.draftId && !existing) {
    return NextResponse.json({ error: "Không tìm thấy bản nháp (hoặc ngoài quyền)" }, { status: 404 });
  }

  const result = await saveListingDraft({
    sellerAccountId: existing?.seller_account_id ?? sellerAccountId,
    sku: existing?.sku ?? sku,
    asin,
    productType,
    requirements,
    marketplaceId,
    locale,
    payload,
    productTypeSchema,
    brand: typeof body.brand === "string" ? body.brand : null,
    existing,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  return NextResponse.json({
    ok: true,
    action: "save",
    created: result.data.created,
    draftId: result.data.draftId,
    revision: result.data.revision,
    changedFields: result.data.changedFields,
    validation,
    status: "draft" as DraftStatus,
  });
}

/** GET: trả nội dung 1 bản nháp (dùng cho client refresh). */
export async function GET(req: Request) {
  const session = await getAppSession();
  if (!session) return NextResponse.json({ error: "Chưa đăng nhập" }, { status: 401 });
  if (session.mode !== "supabase") {
    return NextResponse.json({ error: "DEMO MODE — không có dữ liệu thật" }, { status: 409 });
  }

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Thiếu ?id=" }, { status: 400 });

  const draft = await readDraft(id);
  if (!draft) return NextResponse.json({ error: "Không tìm thấy bản nháp (hoặc ngoài quyền)" }, { status: 404 });

  return NextResponse.json({
    ok: true,
    draft: {
      id: draft.id,
      sku: draft.sku,
      asin: draft.asin,
      status: toDraftStatus(draft.status),
      revision: draft.revision,
      payload: asPayload(draft.payload),
    },
  });
}
