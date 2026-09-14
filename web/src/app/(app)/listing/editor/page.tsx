import { NoAccess, PageHeader, Panel } from "@/components/ui";
import { ListingEditor } from "@/components/listing/ListingEditor";
import { LiveListingDraftList, LiveListingEditorDetail } from "@/components/listing/LiveListingEditor";
import { requireSession } from "@/lib/auth/session";
import { createDemoEditorDraft } from "@/lib/listing/editor-demo";
import type { PersonaKey } from "@/lib/roles";

const ALLOWED: PersonaKey[] = ["ceo"];

/**
 * L3 — Trình soạn listing nội bộ.
 * SUPABASE: đọc/ghi catalog.listing_drafts qua RPC public + RLS + trigger 0014.
 * DEMO: form + kiểm tra hạn mức chạy được, nhưng nút lưu bị khoá (thiếu Supabase).
 */
export default async function ListingEditorPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string; shop?: string; sku?: string; productType?: string; marketplaceId?: string }>;
}) {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;

  const params = await searchParams;

  return (
    <>
      <PageHeader
        title="Soạn listing (L3)"
        sub="Draft → Trưởng phòng duyệt → Publish · form động theo product type"
        desc="Soạn và chỉnh sửa nội dung listing với kiểm tra giới hạn ký tự theo chuẩn Amazon. Mọi thay đổi được lưu lịch sử và cần duyệt trước khi đăng lên Amazon."
      />

      {session.mode === "supabase" ? (
        params.id ? (
          <LiveListingEditorDetail draftId={params.id} />
        ) : params.shop && params.sku ? (
          <LiveListingEditorNew
            sellerAccountId={params.shop}
            sku={params.sku}
            productType={params.productType ?? "PRODUCT"}
            marketplaceId={params.marketplaceId ?? "ATVPDKIKX0DER"}
          />
        ) : (
          <LiveListingDraftList />
        )
      ) : (
        <>
          <div className="mb-3 text-sm font-bold text-[#8a5602]">DEMO · Dữ liệu minh họa — không lưu vào database</div>
          <ListingEditor
            mode="demo"
            sellerAccountId="demo-shop"
            shop="Shop Demo US"
            sku="XMO-950-BLK"
            productType="LUGGAGE"
            requirements={"LISTING" as never}
            marketplaceId="ATVPDKIKX0DER"
            locale="en_US"
            initial={{
              draftId: null,
              status: "draft",
              payload: createDemoEditorDraft({}).payload,
              revision: 0,
              asin: "B0C7T31F",
              submittedBy: null,
            }}
            history={[]}
            actor={{ userId: "demo", canWrite: true, isApprover: true }}
          />
          <Panel title="Vì sao không lưu được ở DEMO?" hint="đúng nguyên tắc SUPABASE mode không tự fallback">
            <ul className="list-disc pl-5 text-[12.5px] text-muted">
              <li>Bản nháp + lịch sử thay đổi nằm trong bảng thật (migration 0014) với RLS theo shop và luật 4 mắt.</li>
              <li>Nhập <code>NEXT_PUBLIC_SUPABASE_URL</code> + anon key để bật SUPABASE mode; worker CLI cần service key để publish.</li>
              <li>Ở DEMO, phần kiểm tra hạn mức vẫn chạy đúng vì dùng chung module <code>web/src/lib/listing/editor-model.ts</code>.</li>
            </ul>
          </Panel>
        </>
      )}
    </>
  );
}

/** SKU mới chưa có bản nháp: form rỗng, lưu lần đầu sẽ tạo revision #1. */
async function LiveListingEditorNew({
  sellerAccountId,
  sku,
  productType,
  marketplaceId,
}: {
  sellerAccountId: string;
  sku: string;
  productType: string;
  marketplaceId: string;
}) {
  const { readEditorActor, readProductTypeSchema, readShopOptions } = await import("@/lib/listing/editor");
  const [{ canWrite, isApprover, userId }, shops, productTypeSchema] = await Promise.all([
    readEditorActor(sellerAccountId),
    readShopOptions(),
    readProductTypeSchema({ marketplaceId, productType, requirements: "LISTING" }),
  ]);
  const found = shops.find((s) => s.sellerAccountId === sellerAccountId);
  const shop = found?.shop ?? sellerAccountId;

  // readShopOptions chỉ trả shop ĐÃ KẾT NỐI — vào thẳng URL với shop chưa
  // kết nối (không qua dropdown) thì chặn ở đây, tránh soạn xong không publish được.
  if (!found) {
    return (
      <Panel title="Shop chưa sẵn sàng để soạn listing" hint="cần kết nối Amazon trước">
        <div className="text-[13px] text-soft">
          Shop này chưa kết nối Amazon (chưa có token OAuth còn hiệu lực) hoặc bạn không có quyền xem.
          Publish listing cần gọi SP-API bằng token của chính shop đó — hãy vào trang{" "}
          <a className="font-bold underline" href="/module0/connect">Kết nối shop</a> để kết nối trước,
          rồi quay lại đây soạn nội dung.
        </div>
      </Panel>
    );
  }

  return (
    <ListingEditor
      mode="supabase"
      sellerAccountId={sellerAccountId}
      shop={shop}
      sku={sku}
      productType={productType}
      requirements={"LISTING" as never}
      marketplaceId={marketplaceId}
      locale="en_US"
      initial={{ draftId: null, status: "draft", payload: {}, revision: 0, asin: null, submittedBy: null }}
      history={[]}
      actor={{ userId, canWrite, isApprover }}
      productTypeSchema={productTypeSchema ?? undefined}
    />
  );
}
