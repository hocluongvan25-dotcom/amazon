import { Chip, NoAccess, PageHeader, Panel, tableCls } from "@/components/ui";
import { LiveListingList } from "@/components/listing/LiveListing";
import { requireSession } from "@/lib/auth/session";
import { listingList } from "@/lib/data/mock";
import { LISTING_STATUS_TONE, LISTING_STATUS_VI } from "@/lib/data/listing-model";
import type { PersonaKey } from "@/lib/roles";
import type { ListingListRow, ListingStatus } from "@/lib/types";

const ALLOWED: PersonaKey[] = ["ceo"];

// Trạng thái: dùng bản chung của listing-model (0016 thêm REMOVED/CLOSED/DELETED/UNKNOWN)
const statusTone = LISTING_STATUS_TONE;
const statusLabel = LISTING_STATUS_VI;

function chipHref(base: Record<string, string | undefined>, key: string, value: string) {
  const params = new URLSearchParams();
  const merged = { ...base, [key]: value === "all" ? undefined : value };
  for (const [k, v] of Object.entries(merged)) if (v) params.set(k, v);
  const qs = params.toString();
  return `/listing/list${qs ? `?${qs}` : ""}`;
}

export default async function ListingListPage({
  searchParams,
}: {
  searchParams: Promise<{ f?: string; shop?: string; sev?: string; brand?: string; q?: string; sort?: string }>;
}) {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;

  const sp = await searchParams;
  const filters = {
    f: sp.f ?? "all",
    shop: sp.shop ?? "all",
    sev: sp.sev ?? "all",
    brand: sp.brand ?? "all",
    q: (sp.q ?? "").trim().toLowerCase(),
    sort: sp.sort === "sku" ? "sku" : "rev",
  };

  // Supabase mode
  if (session.mode === "supabase") {
    return <LiveListingList filters={filters} />;
  }

  // Demo mode
  let rows = listingList.filter((r) => {
    if (filters.f !== "all" && r.status !== filters.f) return false;
    if (filters.shop !== "all" && r.shop !== filters.shop) return false;
    if (filters.sev === "error" && r.issueErrors === 0) return false;
    if (filters.sev === "warning" && r.issueWarnings === 0) return false;
    if (filters.sev === "clean" && (r.issueErrors > 0 || r.issueWarnings > 0)) return false;
    if (filters.brand !== "all" && r.brand !== filters.brand) return false;
    if (filters.q) {
      const hay = `${r.sku} ${r.asin} ${r.title}`.toLowerCase();
      if (!hay.includes(filters.q)) return false;
    }
    return true;
  });
  rows =
    filters.sort === "sku"
      ? [...rows].sort((a, b) => a.sku.localeCompare(b.sku))
      : [...rows].sort((a, b) => b.revenue30d - a.revenue30d);

  const shops = [...new Set(listingList.map((r) => r.shop))];
  const brands = [...new Set(listingList.map((r) => r.brand))];

  const chip = (active: boolean) =>
    `rounded-full border px-3.5 py-1.5 text-[12.5px] font-bold transition ${
      active
        ? "border-accent bg-accent-soft text-accent-ink"
        : "border-line bg-card text-muted hover:border-accent"
    }`;

  const csv =
    "sku,asin,shop,brand,status,price,stock,errors,warnings,owner\n" +
    rows
      .map((r) =>
        [r.sku, r.asin, r.shop, r.brand, r.status, r.price, r.stock ?? "", r.issueErrors, r.issueWarnings, r.owner].join(","),
      )
      .join("\n");

  return (
    <>
      <div className="mb-3 text-sm font-bold text-amber">DEMO · Dữ liệu minh họa</div>
      <PageHeader
        title="Danh sách listing"
        sub={`${listingList.length} SKU · 14 shop · cập nhật 2 giờ trước`}
        desc="Nguồn: report GET_MERCHANT_LISTINGS_ALL_DATA (hằng ngày 2h sáng) + realtime LISTINGS_ITEM_STATUS_CHANGE / ISSUES_CHANGE + getListingsItem (chi tiết)."
      />

      {/* Tìm kiếm + hành động hàng loạt */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <form action="/listing/list" method="get" className="flex flex-1 items-center gap-2">
          {(["f", "shop", "sev", "brand", "sort"] as const).map((k) =>
            sp[k] !== undefined && sp[k] !== "all" && k !== "sort" ? (
              <input key={k} type="hidden" name={k} value={sp[k]} />
            ) : null,
          )}
          {sp.sort === "sku" ? <input type="hidden" name="sort" value="sku" /> : null}
          <input
            name="q"
            defaultValue={sp.q ?? ""}
            placeholder="Tìm SKU / ASIN / tiêu đề…"
            className="h-9 w-full max-w-xs rounded-full border border-line bg-card px-4 text-[13px] font-semibold outline-none placeholder:text-soft focus:border-accent"
          />
          <button
            type="submit"
            className="h-9 rounded-full border border-line bg-card px-4 text-[12.5px] font-bold text-muted transition hover:border-accent hover:text-accent-ink"
          >
            Tìm
          </button>
        </form>
        <a
          href={`data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`}
          download="listings.csv"
          className="h-9 rounded-full border border-line bg-card px-4 py-2 text-[12.5px] font-bold text-muted transition hover:border-accent hover:text-accent-ink"
        >
          ⬇ Xuất CSV
        </a>
        <span
          title="Gán người xử lý — thao tác ghi nội bộ, kích hoạt khi có Supabase"
          className="h-9 cursor-not-allowed rounded-full border border-dashed border-line px-4 py-2 text-[12.5px] font-bold text-soft"
        >
          👤 Gán người xử lý
        </span>
      </div>

      {/* Filter: trạng thái */}
      <div className="mb-2 flex flex-wrap gap-2">
        {(
          [
            ["all", "Tất cả", listingList.length],
            ["ACTIVE", "Active", listingList.filter((r) => r.status === "ACTIVE").length],
            ["INACTIVE", "Inactive", listingList.filter((r) => r.status === "INACTIVE").length],
            ["STRANDED", "Stranded", listingList.filter((r) => r.status === "STRANDED").length],
            ["SUPPRESSED", "Bị ẩn", listingList.filter((r) => r.status === "SUPPRESSED").length],
          ] as [string, string, number][]
        ).map(([key, label, count]) => (
          <a key={key} href={chipHref({ ...sp, q: sp.q }, "f", key)} className={chip(filters.f === key)}>
            {label} · {count}
          </a>
        ))}
      </div>
      {/* Filter: shop / loại lỗi / brand */}
      <div className="mb-2 flex flex-wrap gap-2">
        {[[ "all", "Mọi shop"], ...shops.map((s) => [s, `Shop ${s}`] as [string, string])].map(([key, label]) => (
          <a key={key} href={chipHref({ ...sp, q: sp.q }, "shop", key)} className={chip(filters.shop === key)}>
            {label}
          </a>
        ))}
        <span className="mx-1 w-px self-stretch bg-line" />
        {(
          [
            ["all", "Mọi lỗi"],
            ["error", "Có ERROR"],
            ["warning", "Có WARNING"],
            ["clean", "Sạch lỗi"],
          ] as [string, string][]
        ).map(([key, label]) => (
          <a key={key} href={chipHref({ ...sp, q: sp.q }, "sev", key)} className={chip(filters.sev === key)}>
            {label}
          </a>
        ))}
        <span className="mx-1 w-px self-stretch bg-line" />
        {[[ "all", "Mọi brand"], ...brands.map((b) => [b, b] as [string, string])].map(([key, label]) => (
          <a key={key} href={chipHref({ ...sp, q: sp.q }, "brand", key)} className={chip(filters.brand === key)}>
            {label}
          </a>
        ))}
      </div>
      {/* Sort */}
      <div className="mb-4 flex items-center gap-2 text-[12px] font-bold text-soft">
        Xếp theo:
        <a
          href={chipHref({ ...sp, q: sp.q }, "sort", "rev")}
          className={filters.sort === "rev" ? "text-accent-ink" : "text-muted hover:text-accent-ink"}
        >
          Doanh thu 30 ngày
        </a>
        ·
        <a
          href={chipHref({ ...sp, q: sp.q }, "sort", "sku")}
          className={filters.sort === "sku" ? "text-accent-ink" : "text-muted hover:text-accent-ink"}
        >
          SKU A→Z
        </a>
      </div>

      <Panel title={`${rows.length} SKU`} hint="tích hợp số issues theo severity từ getListingsItem">
        <table className={tableCls.table}>
          <thead>
            <tr>
              <th className={tableCls.th}>Ảnh</th>
              <th className={tableCls.th}>SKU / Tiêu đề</th>
              <th className={tableCls.th}>ASIN</th>
              <th className={tableCls.th}>Shop</th>
              <th className={tableCls.th}>Brand</th>
              <th className={`${tableCls.th} text-right`}>Giá</th>
              <th className={`${tableCls.th} text-right`}>Tồn</th>
              <th className={`${tableCls.th} text-right`}>Issues</th>
              <th className={tableCls.th}>Trạng thái</th>
              <th className={tableCls.th}>Phụ trách</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.sku}>
                <td className={tableCls.td}>
                  <div
                    className="flex h-9 w-9 items-center justify-center rounded-md border border-line bg-soft text-[11px] font-extrabold text-muted"
                    title="Ảnh từ Catalog API khi kết nối"
                  >
                    {r.brand.slice(0, 2).toUpperCase()}
                  </div>
                </td>
                <td className={tableCls.td}>
                  <a
                    href={`/listing/detail?sku=${r.sku}`}
                    className="font-bold text-blue underline underline-offset-2"
                  >
                    {r.sku}
                  </a>
                  <div className="max-w-[280px] truncate text-[11.5px] text-soft">{r.title}</div>
                </td>
                <td className={`${tableCls.td} text-[12px]`}>{r.asin}</td>
                <td className={tableCls.td}>{r.shop}</td>
                <td className={tableCls.td}>{r.brand}</td>
                <td className={tableCls.tdNum}>{r.price}</td>
                <td className={tableCls.tdNum}>
                  {r.stock === null ? <span className="text-soft">—</span> : r.stock.toLocaleString("en-US")}
                </td>
                <td className={tableCls.tdNum}>
                  {r.issueErrors > 0 ? (
                    <span className="font-extrabold text-red">{r.issueErrors} lỗi</span>
                  ) : null}
                  {r.issueErrors > 0 && r.issueWarnings > 0 ? " · " : null}
                  {r.issueWarnings > 0 ? (
                    <span className="font-bold text-amber">{r.issueWarnings} cảnh báo</span>
                  ) : null}
                  {r.issueErrors === 0 && r.issueWarnings === 0 ? (
                    <span className="text-soft">—</span>
                  ) : null}
                </td>
                <td className={tableCls.td}>
                  <Chip tone={statusTone[r.status]}>{statusLabel[r.status]}</Chip>
                </td>
                <td className={tableCls.td}>{r.owner}</td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={10} className={`${tableCls.td} text-center text-soft`}>
                  Không có SKU nào khớp bộ lọc.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Panel>
      <p className="mt-3 text-[11.5px] font-semibold text-soft">
        Cập nhật lần cuối từng SKU: realtime qua notification · toàn bảng: report 2h sáng · chi tiết từng SKU:
        getListingsItem (includedData: summaries, attributes, issues, offers). Thao tác sửa nội dung làm tại
        Seller Central (L3 — Đợt 2).
      </p>
    </>
  );
}
