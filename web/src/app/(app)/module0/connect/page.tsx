/**
 * Module 0 → Kết nối shop (SOP-11).
 *
 * Trang này có HAI chế độ, và chúng KHÁC NHAU về bản chất:
 *   • SUPABASE MODE — công cụ thật: danh sách shop + tình trạng token (còn mấy
 *     ngày, có cần authorize lại không) + nút Kết nối chạy luồng OAuth thật.
 *   • DEMO MODE — chỉ là bản mô tả trình tự kết nối (không có gì để bấm).
 *
 * Vì sao phải hiện hạn token ngay ở đây: LWA refresh token sống 365 ngày và
 * Amazon KHÔNG báo khi nó hết hạn. Nhìn thấy "còn 12 ngày" trước khi mọi thứ
 * ngừng đồng bộ là khác biệt giữa "chủ động authorize lại" và "sáng ra thấy
 * dashboard trống".
 */
import { Chip, NoAccess, PageHeader, Panel, tableCls } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import { connectStatusOf, readConnectShops, type ConnectShopRow } from "@/lib/data/oauth";
import type { PersonaKey } from "@/lib/roles";

const ALLOWED: PersonaKey[] = ["ceo"];

const STEPS = [
  {
    n: 1,
    title: "Bấm Kết nối shop",
    detail: "Hệ thống sinh link authorize (OAuth LWA) theo app SP-API của VEXIM.",
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
  // Chỉ hiện CÓ/KHÔNG — không bao giờ in giá trị biến môi trường ra HTML.
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

function ShopTable({ shops }: { shops: ConnectShopRow[] }) {
  if (shops.length === 0) {
    return (
      <div className="rounded-[10px] border border-dashed border-line px-3 py-6 text-center text-[13px] text-soft">
        Bạn chưa được gán shop nào. Nhờ quản trị viên gán shop ở màn Người dùng &amp; phân quyền.
      </div>
    );
  }
  return (
    <table className={tableCls.table}>
      <thead>
        <tr>
          <th className={tableCls.th}>Shop</th>
          <th className={tableCls.th}>Marketplace</th>
          <th className={tableCls.th}>Trạng thái token</th>
          <th className={`${tableCls.th} text-right`}>Còn lại</th>
          <th className={tableCls.th}>Authorize lần cuối</th>
          <th className={tableCls.th}>Profile Ads</th>
          <th className={tableCls.th} />
        </tr>
      </thead>
      <tbody>
        {shops.map((s) => {
          const st = connectStatusOf(s);
          const label = s.hasToken ? "Kết nối lại" : "Kết nối";
          return (
            <tr key={s.sellerAccountId}>
              <td className={`${tableCls.td} font-bold`}>{s.shop}</td>
              <td className={tableCls.td}>{s.marketplace}</td>
              <td className={tableCls.td}>
                <Chip tone={st.tone}>{st.label}</Chip>
                <div className="mt-1 text-[11.5px] text-soft">{st.hint}</div>
                {s.rotateReminderSent && s.needsReauth ? (
                  <div className="mt-0.5 text-[11.5px] text-soft">
                    đã nhắc lúc {s.noticeSentAt ? s.noticeSentAt.slice(0, 10) : "—"}
                  </div>
                ) : null}
              </td>
              <td className={`${tableCls.td} text-right tabular-nums`}>
                {s.daysLeft === null ? "—" : `${s.daysLeft} ngày`}
              </td>
              <td className={tableCls.td}>
                {s.authorizedAt ? s.authorizedAt.slice(0, 10) : "chưa từng"}
                {s.refreshCount && s.refreshCount > 1 ? (
                  <span className="text-soft"> · lần {s.refreshCount}</span>
                ) : null}
              </td>
              <td className={`${tableCls.td} text-right tabular-nums`}>
                {s.adsProfiles > 0 ? s.adsProfiles : "—"}
              </td>
              <td className={`${tableCls.td} text-right`}>
                <a
                  href={`/api/oauth/amazon/start?seller=${encodeURIComponent(s.sellerAccountId)}`}
                  className="inline-flex items-center rounded-[8px] bg-accent px-3 py-1.5 text-[12.5px] font-extrabold text-white hover:opacity-90"
                >
                  {label}
                </a>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
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
    // DEMO MODE — chưa có Supabase thì chưa lưu được token ở đâu cả.
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

  return (
    <>
      <PageHeader
        title="Kết nối shop Amazon"
        sub={`Trình kết nối · SOP-11 · ${shops.length} shop`}
        desc="Refresh token lưu trong DB (không nằm trong biến môi trường). Amazon không báo khi token hết hạn — trang này nhắc trước."
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
        title="Shop đã cấp quyền cho VEXIM"
        hint={
          needing > 0
            ? `${needing} shop cần authorize lại`
            : notConnected > 0
              ? `${notConnected} shop chưa kết nối`
              : "tất cả token còn hiệu lực"
        }
      >
        <ShopTable shops={shops} />
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
    </>
  );
}
