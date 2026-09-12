/**
 * LiveListing — server component đọc Supabase cho Module 1 (L1/L2/L4 + overview).
 */
import { Chip, KpiCard, KpiGrid, NoAccess, PageHeader, Panel, tableCls } from "@/components/ui";
import { readListings, readListingQueue } from "@/lib/data/listing";
import {
  mapListingRow,
  mapListingQueueItem,
  computeListingKpis,
  formatPrice,
  type ListingRaw,
} from "@/lib/data/listing-model";
import type { ListingListRow, ListingStatus } from "@/lib/types";

const statusTone: Record<ListingStatus, "green" | "amber" | "red" | "gray"> = {
  ACTIVE: "green",
  INACTIVE: "amber",
  STRANDED: "red",
  SUPPRESSED: "red",
};

const statusLabel: Record<ListingStatus, string> = {
  ACTIVE: "Active",
  INACTIVE: "Inactive",
  STRANDED: "Stranded",
  SUPPRESSED: "Bị ẩn (suppressed)",
};

/* ================================================================== */
/* Overview — /listing                                                  */
/* ================================================================== */

export async function LiveListingOverview() {
  let rawListings: ListingRaw[] = [];
  let rawQueue: ListingRaw[] = [];
  let failed = false;

  try {
    [rawListings, rawQueue] = await Promise.all([
      readListings(),
      readListingQueue(),
    ]);
  } catch {
    failed = true;
  }

  const allRows = rawListings.map(mapListingRow);
  const kpis = computeListingKpis(allRows);
  const queueItems = rawQueue.slice(0, 10).map(mapListingQueueItem);

  return (
    <>
      <div className="mb-3 text-sm font-bold text-accent-ink">
        SUPABASE · dữ liệu thật từ vexim_listings
      </div>
      <PageHeader
        title="Listing & Nội dung"
        sub={`${allRows.length} SKU · cập nhật từ Supabase`}
        desc="Nguồn: Listings Items API + notification LISTINGS_ITEM_ISSUES_CHANGE + report Merchant Listings."
      />
      <div className="mb-4 flex flex-wrap gap-2">
        {[
          ["/listing/list", "📋 Danh sách listing"],
          ["/listing/queue", "🚑 Hàng đợi inactive/stranded"],
        ].map(([href, label]) => (
          <a
            key={href}
            href={href}
            className="rounded-full border border-line bg-card px-4 py-1.5 text-[12.5px] font-bold text-muted transition hover:border-accent hover:bg-accent-soft hover:text-accent-ink"
          >
            {label}
          </a>
        ))}
      </div>
      {failed ? (
        <Panel title="Không tải được dữ liệu">
          <p role="alert">Không thể đọc Supabase. Kiểm tra migration 0012, quyền SELECT, RLS.</p>
        </Panel>
      ) : (
        <>
          <KpiGrid>
            {kpis.map((k) => (
              <KpiCard key={k.label} {...k} />
            ))}
          </KpiGrid>
          <Panel title="Hàng đợi xử lý hôm nay" hint="xếp theo severity issues">
            {queueItems.length === 0 ? (
              <p className="text-[13px] text-muted">
                Không có listing nào có vấn đề trong DB.
              </p>
            ) : (
              <table className={tableCls.table}>
                <thead>
                  <tr>
                    <th className={tableCls.th}>SKU / ASIN</th>
                    <th className={tableCls.th}>Shop</th>
                    <th className={tableCls.th}>Vấn đề</th>
                    <th className={tableCls.th}>Ưu tiên</th>
                  </tr>
                </thead>
                <tbody>
                  {queueItems.map((r) => (
                    <tr key={r.sku}>
                      <td className={`${tableCls.td} font-bold`}>
                        {r.sku} · {r.asin}
                      </td>
                      <td className={tableCls.td}>{r.shop}</td>
                      <td className={tableCls.td}>{r.cause}</td>
                      <td className={tableCls.td}>
                        <Chip tone={r.priority}>{r.priorityLabel}</Chip>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </>
      )}
    </>
  );
}

/* ================================================================== */
/* L1 — Danh sách listing                                              */
/* ================================================================== */

function chipHref(base: Record<string, string | undefined>, key: string, value: string) {
  const params = new URLSearchParams();
  const merged = { ...base, [key]: value === "all" ? undefined : value };
  for (const [k, v] of Object.entries(merged)) if (v) params.set(k, v);
  const qs = params.toString();
  return `/listing/list${qs ? `?${qs}` : ""}`;
}

export async function LiveListingList({
  filters,
}: {
  filters: {
    f: string;
    shop: string;
    sev: string;
    brand: string;
    q: string;
    sort: string;
  };
}) {
  let rawRows: ListingRaw[] = [];
  let failed = false;

  try {
    rawRows = await readListings();
  } catch {
    failed = true;
  }

  const allRows = rawRows.map(mapListingRow);

  // Áp dụng filter
  let rows = allRows.filter((r) => {
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

  const shops = [...new Set(allRows.map((r) => r.shop))];
  const brands = [...new Set(allRows.map((r) => r.brand))];

  const chip = (active: boolean) =>
    `rounded-full border px-3.5 py-1.5 text-[12.5px] font-bold transition ${
      active
        ? "border-accent bg-accent-soft text-accent-ink"
        : "border-line bg-card text-muted hover:border-accent"
    }`;

  const sp: Record<string, string | undefined> = {
    f: filters.f !== "all" ? filters.f : undefined,
    shop: filters.shop !== "all" ? filters.shop : undefined,
    sev: filters.sev !== "all" ? filters.sev : undefined,
    brand: filters.brand !== "all" ? filters.brand : undefined,
    q: filters.q || undefined,
    sort: filters.sort === "sku" ? "sku" : undefined,
  };

  return (
    <>
      <div className="mb-3 text-sm font-bold text-accent-ink">
        SUPABASE · dữ liệu thật từ vexim_listings
      </div>
      <PageHeader
        title="Danh sách listing"
        sub={`${allRows.length} SKU · cập nhật từ Supabase`}
        desc="Nguồn: report GET_MERCHANT_LISTINGS_ALL_DATA + notification LISTINGS_ITEM_STATUS_CHANGE / ISSUES_CHANGE."
      />

      {/* Tìm kiếm */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <form action="/listing/list" method="get" className="flex flex-1 items-center gap-2">
          {(["f", "shop", "sev", "brand", "sort"] as const).map((k) =>
            sp[k] ? <input key={k} type="hidden" name={k} value={sp[k]} /> : null,
          )}
          <input
            name="q"
            defaultValue={filters.q}
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
      </div>

      {/* Filter: trạng thái */}
      <div className="mb-2 flex flex-wrap gap-2">
        {(
          [
            ["all", "Tất cả", allRows.length],
            ["ACTIVE", "Active", allRows.filter((r) => r.status === "ACTIVE").length],
            ["INACTIVE", "Inactive", allRows.filter((r) => r.status === "INACTIVE").length],
            ["STRANDED", "Stranded", allRows.filter((r) => r.status === "STRANDED").length],
            ["SUPPRESSED", "Bị ẩn", allRows.filter((r) => r.status === "SUPPRESSED").length],
          ] as [string, string, number][]
        ).map(([key, label, count]) => (
          <a key={key} href={chipHref(sp, "f", key)} className={chip(filters.f === key)}>
            {label} · {count}
          </a>
        ))}
      </div>

      {/* Filter: shop / lỗi */}
      <div className="mb-4 flex flex-wrap gap-2">
        {[["all", "Mọi shop"], ...shops.map((s) => [s, `Shop ${s}`] as [string, string])].map(([key, label]) => (
          <a key={key} href={chipHref(sp, "shop", key)} className={chip(filters.shop === key)}>
            {label}
          </a>
        ))}
        <span className="mx-1 w-px self-stretch bg-line" />
        {(
          [["all", "Mọi lỗi"], ["error", "Có ERROR"], ["warning", "Có WARNING"], ["clean", "Sạch lỗi"]] as [string, string][]
        ).map(([key, label]) => (
          <a key={key} href={chipHref(sp, "sev", key)} className={chip(filters.sev === key)}>
            {label}
          </a>
        ))}
      </div>

      {failed ? (
        <Panel title="Không tải được dữ liệu">
          <p role="alert">Không thể đọc Supabase. Kiểm tra migration 0012, quyền SELECT, RLS.</p>
        </Panel>
      ) : (
        <>
          <Panel title={`${rows.length} SKU`} hint="issues đếm từ JSONB">
            <table className={tableCls.table}>
              <thead>
                <tr>
                  <th className={tableCls.th}>SKU / Tiêu đề</th>
                  <th className={tableCls.th}>ASIN</th>
                  <th className={tableCls.th}>Shop</th>
                  <th className={`${tableCls.th} text-right`}>Giá</th>
                  <th className={`${tableCls.th} text-right`}>Issues</th>
                  <th className={tableCls.th}>Trạng thái</th>
                  <th className={tableCls.th}>Cập nhật</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.sku}>
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
                    <td className={tableCls.tdNum}>{r.price}</td>
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
                    <td className={`${tableCls.td} text-[12px] text-soft`}>{r.updated}</td>
                  </tr>
                ))}
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={7} className={`${tableCls.td} text-center text-soft`}>
                      Không có SKU nào khớp bộ lọc.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </Panel>
          <Panel title="Phạm vi bản đọc">
            <p className="text-[13px] text-muted">
              Chưa có: brand, stock, owner, revenue 30d, ảnh thumbnail — cần bổ sung từ Catalog API,
              Inventory join, Orders join khi có dữ liệu đồng bộ.
            </p>
          </Panel>
        </>
      )}
    </>
  );
}

/* ================================================================== */
/* L2 — Chi tiết listing                                               */
/* ================================================================== */

export async function LiveListingDetail({ sku }: { sku: string }) {
  let rawRows: ListingRaw[] = [];
  let failed = false;

  try {
    rawRows = await readListings();
  } catch {
    failed = true;
  }

  const raw = rawRows.find((r) => r.sku === sku);

  if (failed) {
    return (
      <>
        <div className="mb-3 text-sm font-bold text-accent-ink">SUPABASE</div>
        <PageHeader title={`Listing — ${sku}`} sub="Lỗi tải dữ liệu" />
        <Panel title="Lỗi">
          <p role="alert">Không thể đọc Supabase.</p>
        </Panel>
      </>
    );
  }

  if (!raw) {
    return (
      <>
        <div className="mb-3 text-sm font-bold text-accent-ink">SUPABASE</div>
        <PageHeader title={`Listing — ${sku}`} sub="Không tìm thấy SKU" />
        <Panel title="Không tìm thấy">
          <p className="text-[13px] text-muted">
            SKU chưa có trong vexim_listings. Kiểm tra lại mã hoặc chờ worker đồng bộ.
          </p>
        </Panel>
      </>
    );
  }

  const issues = Array.isArray(raw.issues) ? raw.issues : [];
  const updatedAgo = timeAgoDetail(raw.updated_at);

  return (
    <>
      <div className="mb-3 text-sm font-bold text-accent-ink">
        SUPABASE · dữ liệu thật từ vexim_listings
      </div>
      <PageHeader
        title={`Listing — ${sku}`}
        sub={`${raw.asin ?? "—"} · ${raw.shop} · ${raw.status} · cập nhật ${updatedAgo}`}
        desc="Nguồn: getListingsItem (Listings Items API 2021-08-01) + getCatalogItem (Catalog API 2022-04-01)."
      />
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          {
            label: "Trạng thái",
            value: raw.status,
            sub: normalizeStatusLabel(raw.status),
          },
          {
            label: "Offer & Buy Box",
            value: raw.buy_box_won ? "Đang nắm Buy Box" : raw.buy_box_won === false ? "Không có Buy Box" : "Chưa có dữ liệu",
            sub: raw.buy_box_price ? `Giá box: $${raw.buy_box_price}` : "—",
          },
          { label: "Giá hiện tại", value: formatPrice(raw.price, raw.currency), sub: raw.currency ?? "USD" },
          {
            label: "Issues",
            value: `${raw.error_count} lỗi · ${raw.warning_count} cảnh báo`,
            sub: `${issues.length} issues tổng`,
          },
        ].map((k) => (
          <div key={k.label} className="rounded-[13px] border border-line bg-card px-4 py-3.5">
            <div className="text-[11.5px] font-bold uppercase tracking-wide text-soft">{k.label}</div>
            <div className="mt-0.5 text-[17px] font-extrabold tracking-tight">{k.value}</div>
            <div className="mt-0.5 truncate text-[11.5px] font-semibold text-soft">{k.sub}</div>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="Issues — từ DB" hint="issues JSONB array">
          {issues.length === 0 ? (
            <p className="text-[13px] text-muted">Không có issues.</p>
          ) : (
            <table className={tableCls.table}>
              <thead>
                <tr>
                  <th className={tableCls.th}>Severity</th>
                  <th className={tableCls.th}>Mã</th>
                  <th className={tableCls.th}>Nội dung</th>
                </tr>
              </thead>
              <tbody>
                {issues.map((i: { severity?: string; code?: string; message?: string; attributeNames?: string[]; enforcement?: string }, idx: number) => (
                  <tr key={idx}>
                    <td className={tableCls.td}>
                      <Chip tone={i.severity === "ERROR" ? "red" : i.severity === "WARNING" ? "amber" : "gray"}>
                        {i.severity ?? "—"}
                      </Chip>
                      {i.enforcement ? (
                        <div className="mt-1 text-[10.5px] font-bold text-red">{i.enforcement}</div>
                      ) : null}
                    </td>
                    <td className={`${tableCls.td} font-bold`}>{i.code ?? "—"}</td>
                    <td className={`${tableCls.td} text-[12.5px]`}>
                      {i.message ?? "—"}
                      {i.attributeNames ? (
                        <div className="mt-0.5 text-[11px] font-semibold text-soft">
                          attributeNames: {i.attributeNames.join(", ")}
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
        <Panel title="Chưa có trong DB" hint="đợi Catalog API + Orders join">
          <ul className="list-disc space-y-1.5 pl-5 text-[13px] text-muted">
            <li>Thuộc tính chi tiết (attributes theo product type) — cần getListingsItem với includedData: attributes</li>
            <li>Brand, điều kiện (condition) — cần Catalog API (getCatalogItem)</li>
            <li>Doanh thu 30 ngày — cần join orders theo SKU</li>
            <li>Lịch sử thay đổi — cần audit log liên kết listing</li>
          </ul>
        </Panel>
      </div>
    </>
  );
}

function timeAgoDetail(updatedAt: string): string {
  const now = new Date();
  const updated = new Date(updatedAt);
  const diffMs = now.getTime() - updated.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  if (diffHours < 1) return "vừa xong";
  if (diffHours < 24) return `${diffHours} giờ trước`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return "hôm qua";
  return `${diffDays} ngày trước`;
}

function normalizeStatusLabel(status: string): string {
  const s = status.toUpperCase();
  if (s === "ACTIVE") return "BUYABLE + DISCOVERABLE";
  if (s === "INACTIVE") return "Không active — kiểm tra tồn/offer";
  if (s === "STRANDED") return "Tồn kẹt tại FC — không bán được";
  if (s === "SUPPRESSED") return "Bị ẩn khỏi tìm kiếm";
  return status;
}

/* ================================================================== */
/* L4 — Hàng đợi inactive/stranded                                     */
/* ================================================================== */

export async function LiveListingQueue() {
  let rawRows: ListingRaw[] = [];
  let failed = false;

  try {
    rawRows = await readListingQueue();
  } catch {
    failed = true;
  }

  const queueItems = rawRows.map(mapListingQueueItem);
  const open = queueItems.length;
  const unassigned = queueItems.filter((r) => r.owner === "—").length;
  const highPriority = queueItems.filter((r) => r.priority === "red").length;

  return (
    <>
      <div className="mb-3 text-sm font-bold text-accent-ink">
        SUPABASE · dữ liệu thật từ vexim_listing_queue
      </div>
      <PageHeader
        title="Hàng đợi inactive / stranded — SOP-03"
        sub={`${open} SKU đang mở · ${unassigned} chưa gán`}
        desc="Nguồn: report GET_MERCHANT_LISTINGS_INACTIVE_DATA + GET_STRANDED_INVENTORY_UI_DATA + notification LISTINGS_ITEM_ISSUES_CHANGE."
      />
      {failed ? (
        <Panel title="Không tải được dữ liệu">
          <p role="alert">Không thể đọc Supabase.</p>
        </Panel>
      ) : (
        <>
          <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
            {[
              { label: "SKU đang mở", value: `${open}`, sub: "inactive + stranded + có issues", tone: "down" },
              { label: "Ưu tiên cao", value: `${highPriority}`, sub: "có ERROR", tone: "down" },
              { label: "Chưa gán", value: `${unassigned}`, sub: "trưởng phòng gán ngay", tone: unassigned > 0 ? "warn" : "up" },
            ].map((k) => (
              <div key={k.label} className="rounded-[13px] border border-line bg-card px-4 py-3.5">
                <div className="text-[11.5px] font-bold uppercase tracking-wide text-soft">{k.label}</div>
                <div className={`mt-0.5 text-[22px] font-extrabold tracking-tight ${
                  k.tone === "down" ? "text-red" : k.tone === "warn" ? "text-amber" : "text-green"
                }`}>
                  {k.value}
                </div>
                <div className="mt-0.5 text-[11.5px] font-semibold text-soft">{k.sub}</div>
              </div>
            ))}
          </div>
          <Panel title="Queue xử lý" hint="xếp theo severity issues">
            {queueItems.length === 0 ? (
              <p className="text-[13px] text-muted">Không có listing nào có vấn đề trong DB.</p>
            ) : (
              <table className={tableCls.table}>
                <thead>
                  <tr>
                    <th className={tableCls.th}>SKU / ASIN</th>
                    <th className={tableCls.th}>Shop</th>
                    <th className={tableCls.th}>Nguyên nhân (mã lỗi)</th>
                    <th className={tableCls.th}>Đề xuất sửa</th>
                    <th className={tableCls.th}>Ưu tiên</th>
                    <th className={tableCls.th}>Ai giữ</th>
                  </tr>
                </thead>
                <tbody>
                  {queueItems.map((r) => (
                    <tr key={r.sku}>
                      <td className={tableCls.td}>
                        <a href={`/listing/detail?sku=${r.sku}`} className="font-bold text-blue underline underline-offset-2">
                          {r.sku}
                        </a>
                        <div className="text-[11.5px] text-soft">{r.asin}</div>
                      </td>
                      <td className={tableCls.td}>{r.shop}</td>
                      <td className={`${tableCls.td} text-[12.5px]`}>
                        {r.cause}
                        <div className="mt-0.5 text-[11px] font-bold text-soft">{r.causeCode}</div>
                      </td>
                      <td className={`${tableCls.td} max-w-[260px] text-[12.5px]`}>{r.suggestion}</td>
                      <td className={tableCls.td}>
                        <Chip tone={r.priority}>{r.priorityLabel}</Chip>
                      </td>
                      <td className={`${tableCls.td} font-bold ${r.owner === "—" ? "text-red" : ""}`}>{r.owner}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </>
      )}
    </>
  );
}
