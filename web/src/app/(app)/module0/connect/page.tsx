import { Chip, NoAccess, PageHeader, Panel } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import type { PersonaKey } from "@/lib/roles";

const ALLOWED: PersonaKey[] = ["ceo"];

const STEPS = [
  {
    n: 1,
    title: "Gửi link kết nối cho chủ shop",
    detail: "Hệ thống sinh link authorize (OAuth LWA) theo app SP-API của VEXIM.",
    state: "current" as const,
  },
  {
    n: 2,
    title: "Chủ shop authorize trên Seller Central",
    detail: "Seller đăng nhập Amazon → bấm Authorize → Amazon trả refresh token.",
    state: "todo" as const,
  },
  {
    n: 3,
    title: "Backfill 30 ngày dữ liệu",
    detail: "Orders, FBA Inventory, Listings, Pricing, Settlement qua Reports API.",
    state: "todo" as const,
  },
  {
    n: 4,
    title: "Đăng ký notifications",
    detail: "ORDER_CHANGE, ANY_OFFER_CHANGED, LISTINGS_ITEM_*, ACCOUNT_STATUS_CHANGED.",
    state: "todo" as const,
  },
  {
    n: 5,
    title: "Gán phòng ban & smoke test",
    detail: "Gán nhân viên phụ trách từng module + đối chiếu số liệu với Seller Central.",
    state: "todo" as const,
  },
];

export default async function ConnectPage() {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;

  return (
    <>
      <PageHeader
        title="Kết nối shop Amazon"
        sub="Trình kết nối (wizard) · SOP-11"
        desc="Shop mới vào vận hành trong < 48h từ lúc authorize. Cần app SP-API production đã được Amazon duyệt để chạy thật."
      />

      <Panel title="Trình tự kết nối" hint="đúng luồng OAuth 2.0 / Login with Amazon">
        <ol className="flex flex-col">
          {STEPS.map((s) => (
            <li key={s.n} className="flex gap-3 border-b border-dashed border-[#eef0f4] py-2.5 last:border-0">
              <span
                className={`grid h-[30px] w-[30px] shrink-0 place-items-center rounded-full text-[13px] font-extrabold ${
                  s.state === "current"
                    ? "bg-accent text-white ring-[5px] ring-accent-soft"
                    : "bg-[#eef1f5] text-soft"
                }`}
              >
                {s.n}
              </span>
              <div>
                <div
                  className={`text-[13.5px] font-bold ${
                    s.state === "current" ? "text-accent-ink" : ""
                  }`}
                >
                  {s.title}
                </div>
                <div className="text-[12px] text-soft">{s.detail}</div>
              </div>
            </li>
          ))}
        </ol>
      </Panel>

      <Panel title="Điều kiện chạy được thật">
        <div className="flex flex-col gap-2 text-[13px]">
          <div className="flex items-center gap-2.5 rounded-[10px] border border-line px-3 py-2.5">
            <Chip tone="amber">Chờ</Chip>
            <span>
              Amazon duyệt Developer Profile (Hải Anh theo dõi case — đã nộp)
            </span>
          </div>
          <div className="flex items-center gap-2.5 rounded-[10px] border border-line px-3 py-2.5">
            <Chip tone="amber">Chờ</Chip>
            <span>
              Tạo app SP-API production + cấu hình LWA credentials &amp; redirect
              URI
            </span>
          </div>
          <div className="flex items-center gap-2.5 rounded-[10px] border border-line px-3 py-2.5">
            <Chip tone="green">Sẵn</Chip>
            <span>
              Landing page công khai (điều kiện hồ sơ) — đã dựng, chờ deploy
              HTTPS
            </span>
          </div>
          <div className="flex items-center gap-2.5 rounded-[10px] border border-line px-3 py-2.5">
            <Chip tone="green">Sẵn</Chip>
            <span>
              Database schema + RLS (Supabase migrations 0001–0003) — sẵn sàng
              push khi có project
            </span>
          </div>
        </div>
      </Panel>
    </>
  );
}
