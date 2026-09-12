import { Chip, NoAccess, PageHeader, Panel, tableCls } from "@/components/ui";
import { LiveListingDetail } from "@/components/listing/LiveListing";
import { requireSession } from "@/lib/auth/session";
import { listingDetails, listingList } from "@/lib/data/mock";
import type { PersonaKey } from "@/lib/roles";

const ALLOWED: PersonaKey[] = ["ceo"];

export default async function ListingDetailPage({
  searchParams,
}: {
  searchParams: Promise<{ sku?: string }>;
}) {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;

  const { sku } = await searchParams;

  // Supabase mode
  if (session.mode === "supabase") {
    return <LiveListingDetail sku={sku ?? ""} />;
  }

  // Demo mode
  const detail = sku ? listingDetails[sku] : undefined;
  const row = listingList.find((r) => r.sku === sku);

  return (
    <>
      <div className="mb-3 text-sm font-bold text-amber">DEMO · Dữ liệu minh họa</div>
      <PageHeader
        title={`Listing — ${sku ?? ""}`}
        sub={detail ? `${detail.asin} · Shop ${detail.shop} · ${detail.productType} · ${detail.conditionType}` : "Không tìm thấy SKU"}
        desc="Nguồn: getListingsItem (Listings Items API 2021-08-01, includedData: summaries, attributes, issues, offers) + getCatalogItem (Catalog API 2022-04-01)."
      />
      {detail && row ? (
        <>
          <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                label: "Trạng thái (status flags)",
                value: detail.statusFlags.length ? detail.statusFlags.join(" · ") : "— (không hiển thị)",
                sub: "BUYABLE / DISCOVERABLE theo Listings Items API",
              },
              {
                label: "Offer & Buy Box",
                value: detail.offer.buyBox ? "Đang nắm Buy Box" : "Không có Buy Box",
                sub: `${detail.offer.offerCount} offer · giá ${detail.offer.price}`,
              },
              { label: "Doanh thu 30 ngày", value: detail.revenue30d, sub: "theo SKU (Orders API tổng hợp)" },
              {
                label: "Issues",
                value: `${detail.issues.filter((i) => i.severity === "ERROR").length} lỗi · ${detail.issues.filter((i) => i.severity === "WARNING").length} cảnh báo`,
                sub: `cập nhật ${row.updated}`,
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
            <Panel title={`Thuộc tính hiện có — product type ${detail.productType}`} hint="attributes theo schema Amazon">
              <table className={tableCls.table}>
                <tbody>
                  {detail.attributes.map((a) => (
                    <tr key={a.name}>
                      <td className={`${tableCls.td} w-2/5 font-bold`}>{a.name}</td>
                      <td className={`${tableCls.td} text-[12.5px]`}>{a.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>

            <div className="flex flex-col gap-4">
              <Panel title="Issues — đúng mã lỗi Amazon" hint="getListingsItem · includedData: issues">
                <table className={tableCls.table}>
                  <thead>
                    <tr>
                      <th className={tableCls.th}>Severity</th>
                      <th className={tableCls.th}>Mã</th>
                      <th className={tableCls.th}>Nội dung / thuộc tính liên quan</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.issues.map((i, idx) => (
                      <tr key={idx}>
                        <td className={tableCls.td}>
                          <Chip tone={i.severity === "ERROR" ? "red" : i.severity === "WARNING" ? "amber" : "gray"}>
                            {i.severity}
                          </Chip>
                          {i.enforcement ? (
                            <div className="mt-1 text-[10.5px] font-bold text-red">{i.enforcement}</div>
                          ) : null}
                        </td>
                        <td className={`${tableCls.td} font-bold`}>{i.code}</td>
                        <td className={`${tableCls.td} text-[12.5px]`}>
                          {i.message}
                          <div className="mt-0.5 text-[11px] font-semibold text-soft">
                            attributeNames: {i.attributeNames.join(", ")}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Panel>

              <Panel title="Lịch sử thay đổi" hint="audit nội bộ + sự kiện Amazon">
                <table className={tableCls.table}>
                  <tbody>
                    {detail.history.map((h, i) => (
                      <tr key={i}>
                        <td className={`${tableCls.td} w-32 text-[12px] text-soft`}>{h.time}</td>
                        <td className={`${tableCls.td} w-32 text-[12.5px] font-bold`}>{h.actor}</td>
                        <td className={`${tableCls.td} text-[12.5px]`}>{h.change}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Panel>
            </div>
          </div>
          <p className="mt-3 text-[11.5px] font-semibold text-soft">
            Sửa nội dung: thực hiện tại Seller Central (Đợt 1) — trình soạn L3 + patchListingsItem mở khóa Đợt 2
            theo SOP-03: Draft → Trưởng phòng duyệt → Publish.
          </p>
        </>
      ) : (
        <Panel title="Không tìm thấy SKU">
          <p className="px-4 py-6 text-[13px] text-soft">
            Chưa có dữ liệu chi tiết cho SKU này trong DEMO MODE. Thử{" "}
            <a href="/listing/detail?sku=XMO-950-BLK" className="font-bold text-blue underline underline-offset-2">
              XMO-950-BLK
            </a>{" "}
            hoặc{" "}
            <a href="/listing/detail?sku=VPN-220" className="font-bold text-blue underline underline-offset-2">
              VPN-220
            </a>
            .
          </p>
        </Panel>
      )}
    </>
  );
}
