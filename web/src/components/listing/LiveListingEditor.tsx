/**
 * L3 — server components: đọc bản nháp/lịch sử từ Supabase rồi giao cho
 * ListingEditor (client) hiển thị. Việc gọi SP-API nằm ở worker (CLI
 * `listing:publish`) — web chỉ soạn, duyệt và đẩy vào hàng đợi.
 */

import Link from "next/link";

import { Chip, Panel, tableCls } from "@/components/ui";
import {
  asPayload,
  readDraft,
  readDraftHistory,
  readDrafts,
  readEditorActor,
  readProductTypeSchema,
  readShopOptions,
  toDraftStatus,
  type DraftRaw,
  type RevisionRaw,
} from "@/lib/listing/editor";
import { DRAFT_STATUS_LABEL, type PublishRestrictions } from "@/lib/listing/editor-model.ts";
import { ListingEditor, type EditorHistoryRow } from "./ListingEditor";

function restrictionsFromDraft(draft: DraftRaw): PublishRestrictions | null {
  const raw = draft.publish_issues;
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<PublishRestrictions>;
  if (!Array.isArray(value.reasonCodes)) return null;
  return {
    checkedAt: String(value.checkedAt ?? ""),
    marketplaceId: String(value.marketplaceId ?? draft.marketplace_id),
    asin: value.asin ?? draft.asin,
    reasonCodes: value.reasonCodes,
    messages: Array.isArray(value.messages) ? value.messages : [],
    approvalLinks: Array.isArray(value.approvalLinks) ? value.approvalLinks : [],
  };
}

function toHistoryRows(rows: RevisionRaw[]): EditorHistoryRow[] {
  return rows.map((row) => ({
    revision: row.revision,
    stage: row.stage,
    stageLabel:
      {
        created: "Tạo bản nháp",
        saved: "Lưu thay đổi",
        submitted: "Gửi trưởng phòng duyệt",
        approved: "Trưởng phòng duyệt",
        rejected: "Từ chối",
        publishing: "Đưa vào hàng đợi publish",
        published: "Publish thành công",
        failed: "Publish lỗi",
        reopened: "Mở lại để sửa",
      }[row.stage] ?? row.stage,
    note: row.note,
    changedFields: row.changed_fields ?? [],
    createdAt: row.created_at,
  }));
}

export async function LiveListingEditorDetail({ draftId }: { draftId: string }) {
  const draft = await readDraft(draftId);
  if (!draft) {
    return (
      <Panel title="Không tìm thấy bản nháp" hint="bản nháp có thể đã bị xoá hoặc ngoài phạm vi shop của bạn">
        <Link className="text-[13px] font-bold text-muted underline" href="/listing/editor">
          ← Về danh sách bản nháp
        </Link>
      </Panel>
    );
  }

  // Schema product type lấy từ cache trong DB (worker tải bằng getDefinitionsProductType)
  // → form động có required/maxLength/enum thật của Amazon.
  const [history, actor, productTypeSchema] = await Promise.all([
    readDraftHistory(draft.id),
    readEditorActor(draft.seller_account_id),
    readProductTypeSchema({
      marketplaceId: draft.marketplace_id,
      productType: draft.product_type,
      requirements: draft.requirements,
    }),
  ]);

  return (
    <>
      <div className="mb-2 text-[12.5px] text-soft">
        <Link className="font-bold underline" href="/listing/editor">
          ← Danh sách bản nháp
        </Link>
      </div>
      <ListingEditor
        mode="supabase"
        sellerAccountId={draft.seller_account_id}
        shop={draft.shop}
        sku={draft.sku}
        productType={draft.product_type}
        requirements={draft.requirements as never}
        marketplaceId={draft.marketplace_id}
        locale={draft.locale}
        initial={{
          draftId: draft.id,
          status: toDraftStatus(draft.status),
          payload: asPayload(draft.payload),
          revision: draft.revision,
          asin: draft.asin,
          submittedBy: draft.submitted_by,
        }}
        history={toHistoryRows(history)}
        actor={{ userId: actor.userId, canWrite: actor.canWrite, isApprover: actor.isApprover }}
        productTypeSchema={productTypeSchema ?? undefined}
        restrictions={restrictionsFromDraft(draft)}
      />
    </>
  );
}

export async function LiveListingDraftList() {
  const [drafts, shops] = await Promise.all([readDrafts(), readShopOptions()]);

  return (
    <>
      <Panel title="Mở bản nháp theo SKU" hint="bản nháp đã có ở shop này → mở để sửa; SKU mới → tạo bản nháp">
        <form className="flex flex-wrap items-end gap-3" action="/listing/editor" method="get">
          <label className="flex flex-col gap-1 text-[12px] font-bold text-soft">
            Shop
            <select name="shop" className="rounded-[9px] border border-line px-3 py-2 text-[13px]" required>
              {shops.map((s) => (
                <option key={s.sellerAccountId} value={s.sellerAccountId}>
                  {s.shop}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[12px] font-bold text-soft">
            SKU
            <input name="sku" required placeholder="XMO-950-BLK" className="rounded-[9px] border border-line px-3 py-2 text-[13px]" />
          </label>
          <label className="flex flex-col gap-1 text-[12px] font-bold text-soft">
            Product type
            <input name="productType" defaultValue="PRODUCT" className="rounded-[9px] border border-line px-3 py-2 text-[13px]" />
          </label>
          <button type="submit" className="rounded-[9px] bg-ink px-3.5 py-2 text-[12.5px] font-bold text-white">
            Mở / tạo bản nháp
          </button>
        </form>
        {shops.length === 0 ? (
          <div className="mt-2 text-[12px] text-[#8a5602]">
            Chưa có shop nào sẵn sàng để soạn listing. Bộ chọn này chỉ hiện shop <b>đã kết nối Amazon</b>{" "}
            (có token còn hiệu lực) — vì publish cần gọi SP-API bằng token của chính shop đó. Vào trang{" "}
            <Link className="font-bold underline" href="/module0/connect">
              Kết nối shop
            </Link>{" "}
            để kết nối, hoặc nhờ Admin gán quyền shop cho bạn.
          </div>
        ) : (
          <div className="mt-2 text-[11.5px] text-soft">
            Chỉ hiện shop đã kết nối Amazon (token còn hiệu lực) — shop chưa kết nối không soạn/publish được.
          </div>
        )}
      </Panel>

      <Panel title="Bản nháp listing" hint={`${drafts.length} bản nháp`}>
        {drafts.length === 0 ? (
          <div className="text-[13px] text-soft">Chưa có bản nháp nào — tạo bản nháp đầu tiên ở khung phía trên.</div>
        ) : (
          <table className={tableCls.table}>
            <thead>
              <tr>
                <th className={tableCls.th}>SKU</th>
                <th className={tableCls.th}>Shop</th>
                <th className={tableCls.th}>Product type</th>
                <th className={tableCls.th}>Trạng thái</th>
                <th className={tableCls.th}>Cập nhật</th>
                <th className={tableCls.th}>Revision</th>
                <th className={tableCls.th} />
              </tr>
            </thead>
            <tbody>
              {drafts.map((row) => {
                const status = toDraftStatus(row.status);
                return (
                  <tr key={row.id}>
                    <td className={`${tableCls.td} font-bold`}>{row.sku}</td>
                    <td className={tableCls.td}>{row.shop}</td>
                    <td className={tableCls.td}>{row.product_type}</td>
                    <td className={tableCls.td}>
                      <Chip tone={status === "published" ? "green" : status === "pending_approval" ? "amber" : status === "failed" ? "red" : "gray"}>
                        {DRAFT_STATUS_LABEL[status]}
                      </Chip>
                    </td>
                    <td className={tableCls.td}>{new Date(row.updated_at).toLocaleString("vi-VN")}</td>
                    <td className={tableCls.td}>#{row.revision}</td>
                    <td className={tableCls.td}>
                      <Link className="font-bold underline" href={`/listing/editor?id=${row.id}`}>
                        Mở
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}
