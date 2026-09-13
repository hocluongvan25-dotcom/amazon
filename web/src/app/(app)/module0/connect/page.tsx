/**
 * Module 0 → Kết nối shop (SOP-11) — FIX UX 09/2026 + MD1000/MD9100.
 *
 * VẤN ĐỀ CŨ:
 *   - Seed cố định 8 dòng (A1·US, C2·US, P1·US...) → người vận hành dễ bấm nhầm [Kết nối] ghi đè Refresh Token
 *   - Mã A1/B1/P1 mang tính kỹ thuật, khách không nhận biết gian hàng nào
 *   - Nhiều dòng "Chưa kết nối" gây rối mắt
 *   - MD1000: thiếu version=beta, redirect_uri không khớp
 *   - MD9100: This app can't connect right now — redirect_uri lệch 100% hoặc App Draft thiếu Test Accounts
 *
 * PHƯƠNG ÁN MỚI:
 *   1. Nhóm theo seller_id: P1·US + P2·CA cùng seller AQMVYI4HJTI4C → 1 card
 *   2. Tách production vs mock: production chính, mock ẩn collapsible
 *   3. Tên thân thiện + cờ marketplace
 *   4. Modal xác nhận chống ghi đè + ?confirm=1
 *   5. version=beta trong authorize URL (fix MD1000)
 *   6. validateRedirectUri 100% match + diag endpoint /api/oauth/amazon/diag (fix MD9100)
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
    detail: "Hệ thống sinh link authorize (OAuth LWA) với version=beta + modal xác nhận chống bấm nhầm.",
    live: (s: ConnectShopRow) => s.hasToken,
  },
  {
    n: 2,
    title: "Authorize trên Seller Central",
    detail: "Seller đăng nhập Amazon → bấm Authorize → Amazon trả refresh token (lưu DB). Nếu MD9100, check redirect_uri 100% và Test Accounts.",
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
      title="Điều kiện chạy được thật + Chẩn đoán MD1000/MD9100"
      hint={ready ? "đủ biến môi trường + redirect_uri khớp" : "còn thiếu hoặc lệch — sẽ MD1000/MD9100"}
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

      <div className="mt-3 rounded-[10px] border border-line bg-[#f8f9fb] p-3 text-[12px]">
        <div className="font-bold">Checklist MD1000/MD9100:</div>
        <ol className="mt-1 list-decimal pl-4 text-soft">
          <li>
            Vào <b>Amazon Developer Console → Apps & Services → App ee3dce31... → LWA Credentials → Allowed Return URLs</b>
          </li>
          <li>
            So sánh với env <code>AMAZON_SP_API_REDIRECT_URI</code> trên Vercel: <code className="font-mono">{redirectUri || "(thiếu)"}</code> — phải khớp <b>100% từng chữ cái</b>, bao gồm https và dấu / cuối
          </li>
          <li>
            Nếu App ở <b>Draft</b>, Seller email phải trong <b>Test Accounts</b> (Roles → Test Accounts), và Region phải <b>NA</b> cho US/CA
          </li>
          <li>
            Mở <a href="/api/oauth/amazon/diag" className="text-accent underline" target="_blank">/api/oauth/amazon/diag</a> (chỉ CEO) để xem validation chi tiết + close matches
          </li>
          <li>Check Vercel Logs tìm <code>[OAuth Start]</code> để xem URI thực tế gửi sang Amazon</li>
        </ol>
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
        desc="Refresh token lưu trong DB. Đã nhóm theo Seller ID + thêm version=beta (fix MD1000) + validate redirect_uri 100% (fix MD9100). Tên kỹ thuật A1/B1/P1 nên đổi thành tên thân thiện."
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
        title="Gian hàng Amazon — đã nhóm theo Seller để chống ghi đè + fix MD1000/MD9100"
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

      <Panel title="Trình tự kết nối" hint="đúng luồng OAuth 2.0 / Login with Amazon + version=beta">
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
update connections.seller_accounts set status='revoked' where data_source='mock';`}
          </pre>
          <div className="mt-2 text-[11.5px] text-soft">
            Sau khi đổi, UI sẽ hiện &quot;VEXIM US - Chính 🇺🇸 US&quot; thay vì &quot;P1 · US&quot;, giảm nhầm lẫn.
          </div>
        </div>
      </Panel>

      <Panel title="Fix MD9100 - This app can't connect right now" hint="checklist chi tiết">
        <div className="text-[12.5px] leading-relaxed">
          <div className="font-bold">MD9100 thường do 2 nguyên nhân:</div>
          <ol className="mt-2 list-decimal pl-5">
            <li className="mb-2">
              <b>Redirect URI lệch 100% (khả năng cao nhất):</b> Vào <code>Amazon Developer Console → Apps & Services → LWA Credentials → Allowed Return URLs</code> so sánh với env <code>AMAZON_SP_API_REDIRECT_URI</code> trên Vercel. Phải khớp từng chữ cái, bao gồm https và dấu / cuối. Mở <a href="/api/oauth/amazon/diag" className="text-accent underline" target="_blank">/api/oauth/amazon/diag</a> để xem validation + close matches (gần giống nhưng lệch /).
            </li>
            <li className="mb-2">
              <b>App Status & Regions:</b> App ID <code>amzn1.sp.solution.ee3dce31...</code> đang Draft hay Published? Nếu Draft/Private, Seller email đăng nhập phải trong <code>Roles → Test Accounts</code>. Region phải <b>NA</b> cho US/CA (check env <code>AMAZON_SP_API_REGION=NA</code> và Console chọn North America).
            </li>
          </ol>
          <div className="mt-2 text-soft">
            Log <code>[OAuth Start]</code> trong Vercel Logs sẽ hiện URI thực tế gửi sang Amazon để đối soát. Nếu đã sửa Console, đợi vài phút để Amazon cache refresh.
          </div>
        </div>
      </Panel>
    </>
  );
}
