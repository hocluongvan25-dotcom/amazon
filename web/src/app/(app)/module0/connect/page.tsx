/**
 * Module 0 → Kết nối shop (SOP-11) — FIX UX 09/2026.
 *
 * VẤN ĐỀ CŨ:
 *   - Seed cố định 8 dòng (A1·US, C2·US, P1·US...) → người vận hành dễ bấm nhầm [Kết nối] ghi đè Refresh Token sai shop/marketplace
 *   - Mã A1/B1/P1 mang tính kỹ thuật, khách không nhận biết gian hàng nào
 *   - Nhiều dòng "Chưa kết nối" gây rối mắt
 *
 * PHƯƠNG ÁN MỚI:
 *   1. Nhóm theo seller_id: P1·US + P2·CA cùng seller AQMVYI4HJTI4C → 1 card, không còn 8 dòng rời rạc
 *   2. Hiển thị tên thân thiện + cờ marketplace (🇺🇸 US, 🇨🇦 CA) thay cho mã kỹ thuật
 *   3. Tách production vs mock: production hiện chính, mock ẩn trong collapsible để tránh bấm nhầm
 *   4. Thêm modal xác nhận trước khi ghi đè token: hiện rõ Seller ID, Marketplace ID, trạng thái hiện tại, cảnh báo ghi đè
 *   5. Cho phép đổi display_name thân thiện trong DB (thay vì A1/B1/P1)
 *
 * Trang này có HAI chế độ:
 *   • SUPABASE MODE — công cụ thật: danh sách shop + tình trạng token + nút Kết nối
 *   • DEMO MODE — chỉ là bản mô tả trình tự kết nối
 */
import { Chip, NoAccess, PageHeader, Panel } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import { readConnectShops, type ConnectShopRow } from "@/lib/data/oauth";
import type { PersonaKey } from "@/lib/roles";
import { ShopConnectTable } from "./ShopConnectTable";

const ALLOWED: PersonaKey[] = ["ceo"];

const STEPS = [
  {
    n: 1,
    title: "Bấm Kết nối shop",
    detail: "Hệ thống sinh link authorize (OAuth LWA) theo app SP-API của VEXIM. Có modal xác nhận chống bấm nhầm.",
    live: (s: ConnectShopRow) => s.hasToken,
  },
  {
    n: 2,
    title: "Authorize trên Seller Central",
    detail: "Seller đăng nhập Amazon → bấm Authorize → Amazon trả refresh token (lưu vào DB, không nằm trong env).",
    live: (s: ConnectShopRow) => s.hasToken,
  },
  {
    n: 3,
    title: "Backfill 30 ngày dữ liệu",
    detail: "Orders, FBA Inventory, Listings, Pricing, Settlement qua Reports API — chạy bằng Vercel Cron/worker.",
    live: () => false,
  },
  {
    n: 4,
    title: "Đăng ký notifications",
    detail: "ORDER_CHANGE, ANY_OFFER_CHANGED, LISTINGS_ITEM_*, ACCOUNT_STATUS_CHANGED.",
    live: () => false,
  },
  {
    n: 5,
    title: "Gán phòng ban & smoke test",
    detail: "Gán nhân viên phụ trách từng module + đối soát số liệu với Seller Central.",
    live: () => false,
  },
];

function EnvPanel() {
  const rows: { label: string; ok: boolean; hint: string }[] = [
    {
      label: "AMAZON_SP_API_APP_ID (amzn1.sp.solution…)",
      ok: !!process.env.AMAZON_SP_API_APP_ID,
      hint: "Application ID của app SP-API — dùng để dựng link authorize.",
    },
    {
      label: "AMAZON_LWA_CLIENT_ID / SECRET",
      ok: !!process.env.AMAZON_LWA_CLIENT_ID && !!process.env.AMAZON_LWA_CLIENT_SECRET,
      hint: "Login with Amazon credentials của app SP-API.",
    },
    {
      label: "AMAZON_SP_API_REDIRECT_URI",
      ok: !!process.env.AMAZON_SP_API_REDIRECT_URI,
      hint: "Phải trùng ĐÚNG từng ký tự với redirect URI đã đăng ký ở Amazon, nếu không Amazon trả invalid_grant.",
    },
    {
      label: "SUPABASE_SERVICE_ROLE_KEY",
      ok: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      hint: "Server dùng để sinh state + lưu token (RPC chỉ cho service_role).",
    },
  ];
  const ready = rows.every((r) => r.ok);

  return (
    <Panel
      title="Điều kiện chạy được thật"
      hint={ready ? "đủ biến môi trường" : "còn thiếu — nút Kết nối sẽ báo lỗi rõ ràng"}
    >
      <div className="flex flex-col gap-2 text-[13px]">
        {rows.map((r) => (
          <div
            key={r.label}
            className="flex items-center gap-2.5 rounded-[10px] border border-line px-3 py-2.5"
          >
            <Chip tone={r.ok ? "green" : "amber"}>{r.ok ? "Sẵn" : "Thiếu"}</Chip>
            <span className="font-mono text-[12px]">{r.label}</span>
            <span className="text-soft">{r.hint}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

export default async function ConnectPage({
  searchParams,
}: {
  searchParams: Promise<{
    oauth?: string;
    msg?: string;
    seller?: string;
    days?: string;
    warn?: string;
    replaced?: string;
  }>;
}) {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;

  const sp = await searchParams;
  const banner =
    sp.oauth === "ok"
      ? {
          tone: "green" as const,
          text:
            `Đã lưu refresh token cho shop ${sp.seller ?? ""}` +
            (sp.days ? ` (còn ${sp.days} ngày).` : ".") +
            (sp.replaced === "1" ? " Token cũ đã được thay." : ""),
        }
      : sp.oauth === "error"
        ? { tone: "red" as const, text: sp.msg ?? "Kết nối thất bại." }
        : null;

  if (session.mode !== "supabase") {
    return (
      <>
        <div className="mb-3 text-sm font-bold text-amber">DEMO · Chưa cấu hình Supabase</div>
        <PageHeader
          title="Kết nối shop Amazon"
          sub="Trình kết nối (wizard) · SOP-11"
          desc="Shop mới vào vận hành trong < 48h từ lúc authorize. Khi có Supabase + app SP-API, trang này thành công cụ kết nối thật."
        />
        <Panel title="Trình tự kết nối" hint="đúng luồng OAuth 2.0 / Login with Amazon">
          <ol className="flex flex-col">
            {STEPS.map((s) => (
              <li key={s.n} className="flex gap-3 border-b border-dashed border-[#eef0f4] py-2.5 last:border-0">
                <span className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-full bg-[#eef1f5] text-[13px] font-extrabold text-soft">
                  {s.n}
                </span>
                <div>
                  <div className="text-[13.5px] font-bold">{s.title}</div>
                  <div className="text-[12px] text-soft">{s.detail}</div>
                </div>
              </li>
            ))}
          </ol>
        </Panel>
        <EnvPanel />
      </>
    );
  }

  let shops: ConnectShopRow[] = [];
  let loadError: string | null = null;
  try {
    shops = await readConnectShops();
  } catch (e) {
    loadError = (e as Error).message;
  }

  const needing = shops.filter((s) => s.hasToken && (s.needsReauth || s.isExpired)).length;
  const notConnected = shops.filter((s) => !s.hasToken).length;
  const prodCount = shops.filter((s) => (s.dataSource ?? "mock") !== "mock").length;

  return (
    <>
      <PageHeader
        title="Kết nối shop Amazon"
        sub={`SOP-11 · ${prodCount} gian hàng chính · ${shops.length} tổng (có ${shops.filter((s) => (s.dataSource ?? "mock") === "mock").length} demo)`}
        desc="Refresh token lưu trong DB (không nằm trong env). Đã nhóm theo Seller ID để tránh bấm nhầm ghi đè token. Tên kỹ thuật A1/B1/P1 nên đổi thành tên thân thiện như 'VEXIM US' trong DB."
      />

      {banner ? (
        <div
          className={`mb-3 rounded-[10px] border px-3 py-2.5 text-[13px] font-bold ${
            banner.tone === "green"
              ? "border-[#c9e9d5] bg-[#f2fbf5] text-[#17683a]"
              : "border-[#f2c9c9] bg-[#fdf3f3] text-[#8c1d1d]"
          }`}
        >
          {banner.text}
        </div>
      ) : null}

      {sp.warn ? (
        <div className="mb-3 rounded-[10px] border border-[#f2e2c9] bg-[#fdfaf3] px-3 py-2.5 text-[13px] text-[#7a5a12]">
          {sp.warn}
        </div>
      ) : null}

      {loadError ? (
        <div className="mb-3 rounded-[10px] border border-line px-3 py-2.5 text-[13px] text-soft">
          Không đọc được danh sách shop: {loadError}
        </div>
      ) : null}

      <Panel
        title="Gian hàng Amazon — đã nhóm theo Seller để chống ghi đè"
        hint={
          needing > 0
            ? `${needing} shop cần authorize lại`
            : notConnected > 0
              ? `${notConnected} shop chưa kết nối · ${prodCount} production`
              : "tất cả token còn hiệu lực"
        }
      >
        <ShopConnectTable shops={shops} />
      </Panel>

      <Panel title="Trình tự kết nối" hint="đúng luồng OAuth 2.0 / Login with Amazon">
        <ol className="flex flex-col">
          {STEPS.map((s) => {
            const done = shops.length > 0 && shops.every((shop) => s.live(shop));
            return (
              <li
                key={s.n}
                className="flex gap-3 border-b border-dashed border-[#eef0f4] py-2.5 last:border-0"
              >
                <span
                  className={`grid h-[30px] w-[30px] shrink-0 place-items-center rounded-full text-[13px] font-extrabold ${
                    done ? "bg-accent text-white ring-[5px] ring-accent-soft" : "bg-[#eef1f5] text-soft"
                  }`}
                >
                  {s.n}
                </span>
                <div>
                  <div className={`text-[13.5px] font-bold ${done ? "text-accent-ink" : ""}`}>
                    {s.title}
                  </div>
                  <div className="text-[12px] text-soft">{s.detail}</div>
                </div>
              </li>
            );
          })}
        </ol>
      </Panel>

      <EnvPanel />

      <Panel title="Đề xuất đổi tên thân thiện (thay A1/B1/P1)" hint="chạy 1 lần trong Supabase SQL">
        <div className="text-[12.5px] leading-relaxed">
          <div className="mb-2 text-soft">
            Mã kỹ thuật A1/B1/P1 không giúp người vận hành nhận biết gian hàng. Đề xuất đổi{" "}
            <code>display_name</code> thành tên thân thiện trong DB:
          </div>
          <pre className="overflow-x-auto rounded-[8px] bg-[#f6f7f9] p-3 text-[11.5px]">
{`-- Đổi tên P1·US / P2·CA thành tên dễ hiểu
update connections.seller_accounts
set display_name = case
  when marketplace = 'ATVPDKIKX0DER' then 'VEXIM US - Chính'
  when marketplace = 'A2EUQ1WTGCTBG2' then 'VEXIM CA - Canada'
  else display_name
end
where seller_id = 'AQMVYI4HJTI4C';

-- Ẩn shop mock khỏi production view (hoặc xóa)
update connections.seller_accounts set status='revoked' where data_source='mock';
-- hoặc: delete from connections.seller_accounts where data_source='mock';`}
          </pre>
          <div className="mt-2 text-[11.5px] text-soft">
            Sau khi đổi, UI sẽ hiện &quot;VEXIM US - Chính 🇺🇸 US&quot; thay vì &quot;P1 · US&quot;, giảm nhầm lẫn.
            View <code>vexim_shops</code> cần thêm cột <code>seller_id, display_name</code> (migration 0021).
          </div>
        </div>
      </Panel>
    </>
  );
}
