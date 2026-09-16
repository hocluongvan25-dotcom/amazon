/**
 * Module 0 → Kết nối shop (SOP-11).
 *
 * BA VIỆC CỦA TRANG NÀY (16/09/2026 — đã gọn lại theo yêu cầu vận hành):
 *   1. THÊM SHOP MỚI (nút [+ Thêm shop mới]) — tạo dòng shop trước khi authorize;
 *      shop nằm ở trạng thái "chưa kết nối" cho tới khi bấm [Kết nối].
 *   2. KẾT NỐI / KẾT NỐI LẠI một gian hàng (OAuth LWA → refresh token lưu DB).
 *      Sau khi authorize: Amazon trả selling_partner_id (tự điền seller id nếu shop
 *      mới) + hệ thống lấy luôn TÊN SHOP trên Amazon (storeName, Sellers API v1).
 *   3. XOÁ SHOP (nút [Xoá] từng dòng) — có bước đếm dữ liệu phụ thuộc trước khi xoá.
 *
 * ĐÃ BỎ khỏi màn hình (nội dung thừa, gây rối): checklist MD1000/MD9100, panel
 * "đề xuất đổi tên thân thiện" (đã làm tự động bằng migration 0024) và panel
 * "Fix MD9100" (trùng với ghi chú trong panel điều kiện kết nối).
 */
import { Chip, NoAccess, PageHeader, Panel } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import { readConnectShops, type ConnectShopRow } from "@/lib/data/oauth";
import type { PersonaKey } from "@/lib/roles";
import { ShopConnectTable } from "./ShopConnectTable";
import { validateRedirectUri } from "@/lib/spapi/oauth";

const ALLOWED: PersonaKey[] = ["ceo"];

const STEPS = [
  {
    n: 1,
    title: "Bấm Kết nối shop",
    detail: "Hệ thống sinh link authorize (OAuth LWA) + modal xác nhận chống bấm nhầm.",
    live: (s: ConnectShopRow) => s.hasToken,
  },
  {
    n: 2,
    title: "Authorize trên Seller Central",
    detail: "Seller đăng nhập Amazon → bấm Authorize → hệ thống nhận seller id + refresh token, rồi lấy luôn tên shop.",
    live: (s: ConnectShopRow) => s.hasToken,
  },
  {
    n: 3,
    title: "Backfill 30 ngày dữ liệu",
    detail: "Orders, FBA Inventory, Listings, Pricing, Settlement qua Reports API — Vercel Cron/worker.",
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
  const redirectUri = (process.env.AMAZON_SP_API_REDIRECT_URI ?? "").trim();
  const allowedEnv = (process.env.AMAZON_LWA_ALLOWED_RETURN_URLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const validation = validateRedirectUri(redirectUri, allowedEnv.length > 0 ? allowedEnv : undefined);

  const rows: { label: string; ok: boolean; hint: string; value?: string }[] = [
    {
      label: "AMAZON_SP_API_APP_ID",
      ok: !!process.env.AMAZON_SP_API_APP_ID,
      hint: `App ID: ${(process.env.AMAZON_SP_API_APP_ID ?? "").slice(0, 30)}... — phải là amzn1.sp.solution.ee3dce31...`,
      value: process.env.AMAZON_SP_API_APP_ID,
    },
    {
      label: "AMAZON_LWA_CLIENT_ID / SECRET",
      ok: !!process.env.AMAZON_LWA_CLIENT_ID && !!process.env.AMAZON_LWA_CLIENT_SECRET,
      hint: "Login with Amazon credentials",
    },
    {
      label: "AMAZON_SP_API_REDIRECT_URI",
      ok: !!redirectUri && validation.ok,
      hint: validation.hint,
      value: redirectUri,
    },
    {
      label: "AMAZON_LWA_ALLOWED_RETURN_URLS (optional)",
      ok: allowedEnv.length === 0 || validation.ok,
      hint:
        allowedEnv.length > 0
          ? `Env đối soát: ${allowedEnv.join(" | ")} — phải khớp 100% với Console`
          : "Chưa set — cần vào Console LWA Credentials → Allowed Return URLs để đối soát thủ công",
      value: allowedEnv.join(", "),
    },
    {
      label: "SUPABASE_SERVICE_ROLE_KEY",
      ok: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      hint: "Server dùng để sinh state + lưu token",
    },
    {
      label: "AMAZON_SP_API_REGION",
      ok: true,
      hint: `Region hiện tại: ${process.env.AMAZON_SP_API_REGION || "NA (default)"} — phải NA cho US/CA`,
      value: process.env.AMAZON_SP_API_REGION || "NA",
    },
  ];
  const ready = rows.every((r) => r.ok);

  return (
    <Panel
      title="Điều kiện kết nối (biến môi trường)"
      hint={ready ? "đủ biến môi trường — nút [Kết nối] chạy được" : "còn thiếu biến — bấm [Kết nối] sẽ báo lỗi"}
    >
      <div className="flex flex-col gap-2 text-[13px]">
        {rows.map((r) => (
          <div
            key={r.label}
            className={`flex flex-col gap-1 rounded-[10px] border px-3 py-2.5 ${r.ok ? "border-line" : "border-amber-soft bg-amber-soft/20"}`}
          >
            <div className="flex items-center gap-2.5">
              <Chip tone={r.ok ? "green" : "amber"}>{r.ok ? "Sẵn" : "Lệch/Thiếu"}</Chip>
              <span className="font-mono text-[12px]">{r.label}</span>
              <span className="text-soft">{r.hint}</span>
            </div>
            {r.value ? (
              <div className="ml-14 font-mono text-[11px] text-soft break-all">
                Giá trị: {r.value.slice(0, 120)}
                {r.value.length > 120 ? "..." : ""} {r.value.endsWith("/") ? " (CÓ / cuối)" : " (KHÔNG có / cuối)"}
              </div>
            ) : null}
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
    /** nhãn vận hành của shop vừa kết nối */
    shop?: string;
    /** TÊN SHOP AMAZON (storeName) vừa lấy được ở callback */
    store?: string;
    /** lý do chưa lấy được tên shop Amazon */
    storeMsg?: string;
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
            `Đã lưu refresh token cho shop ${sp.shop || sp.seller || ""}` +
            (sp.days ? ` (còn ${sp.days} ngày).` : ".") +
            (sp.store
              ? ` Tên shop trên Amazon: “${sp.store}”.`
              : sp.storeMsg
                ? ` Chưa lấy được tên shop Amazon — ${sp.storeMsg}`
                : " Chưa lấy được tên shop Amazon — bấm [Đồng bộ tên shop Amazon] để thử lại.") +
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
          desc="Thêm shop ở đây, rồi bấm [Kết nối] để shop authorize trên Seller Central. Cần cấu hình Supabase + app SP-API để thao tác thật."
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
        sub={`SOP-11 · ${prodCount} gian hàng · ${shops.filter((s) => s.hasToken).length} đã kết nối`}
        desc={
          "Mỗi dòng là một gian hàng theo seller + marketplace. Refresh token lưu trong DB (không hiển thị lại). " +
          "Tên shop trên Amazon lấy từ Sellers API v1 (getMarketplaceParticipations.storeName) — khác tên gọi nội bộ."
        }
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
        title="Gian hàng Amazon"
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

      <Panel title="Trình tự kết nối" hint="OAuth 2.0 / Login with Amazon">
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

    </>
  );
}
