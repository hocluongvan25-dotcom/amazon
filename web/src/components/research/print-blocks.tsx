/**
 * Module 8 G6 — các KHỐI DỮ LIỆU render bằng React thuần cho bản in (không
 * thuộc ProseMirror). Số lấy thẳng từ snapshot engine — khớp 100% những gì
 * khách xem trên web; không có đường gõ tay.
 */

import React from "react";
import {
  computeSeasonality,
  restockAdvice,
  summarizeBsr,
  type AssessmentResult,
  type BsrPoint,
  type ConcentrationResult,
} from "@/lib/research/domain";
import type { PainData } from "@/lib/data/research-pain";
import type { CompetitorRowView } from "@/lib/data/research";
import type { VetoAckRow } from "@/lib/data/research-report";

const NA = "chưa đủ cơ sở";
const usd = (n: number | null | undefined, d = 2): string =>
  typeof n === "number" && Number.isFinite(n)
    ? `$${n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`
    : NA;
const usd0 = (n: number | null | undefined) => usd(n, 0);
const pct = (n: number | null | undefined, d = 1): string =>
  typeof n === "number" && Number.isFinite(n) ? `${n.toFixed(d)}%` : NA;
const num = (n: number | null | undefined): string =>
  typeof n === "number" && Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : NA;

export function BlockTitle({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="pr-block-title">
      <span aria-hidden>▦ </span>
      {children}
      <span className="pr-block-title-note"> · số liệu máy tính, khóa cứng</span>
    </h4>
  );
}

/* ------------------------------ SCORECARD ------------------------------- */

export function PrintScorecard({ result }: { result: AssessmentResult }) {
  const sc = result.scorecard;
  return (
    <div className="pr-block">
      <BlockTitle>Bảng điểm 5 trụ & kết luận engine</BlockTitle>
      <table className="pr-table">
        <thead>
          <tr>
            <th>Trụ</th>
            <th className="pr-num">Điểm</th>
            <th>Độ tin cậy</th>
            <th>Lý do</th>
          </tr>
        </thead>
        <tbody>
          {sc.pillars.map((p) => (
            <tr key={p.pillar}>
              <td>{p.label}</td>
              <td className="pr-num">{p.score === null ? NA : `${p.score}/10`}</td>
              <td>{p.confidence ?? NA}</td>
              <td>{p.reason}</td>
            </tr>
          ))}
          <tr className="pr-total">
            <td>
              <b>Điểm tổng có trọng số</b>
            </td>
            <td className="pr-num">
              <b>{sc.overallScore === null ? NA : `${sc.overallScore.toFixed(1)}/10`}</b>
            </td>
            <td colSpan={2}>
              <b>{sc.verdictLabel}</b>
            </td>
          </tr>
        </tbody>
      </table>
      {sc.vetoes.length > 0 && (
        <div className="pr-veto-list">
          {sc.vetoes.map((v) => (
            <div key={v.code} className={`pr-veto pr-veto-${v.severity}`}>
              <b>[{v.severity === "red" ? "VETO ĐỎ" : "CẢNH BÁO"}] {v.title}</b>
              <div>{v.detail}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------------------- SỐ TIỀN GIÁM ĐỐC -------------------------- */

export function PrintMoney({ result }: { result: AssessmentResult }) {
  const s = result.financial.scenarios;
  const r = result.roadmap;
  const rows: [string, string][] = [
    ["Giá bán (bi quan / cơ sở / lạc quan)", `${usd(s.pessimistic.price, 2)} / ${usd(s.base.price, 2)} / ${usd(s.optimistic.price, 2)}`],
    ["Biên lợi nhuận ròng (bi quan / cơ sở / lạc quan)", `${pct(s.pessimistic.netMarginPct)} / ${pct(s.base.netMarginPct)} / ${pct(s.optimistic.netMarginPct)}`],
    ["Phí FBA/đơn (size tier)", `${usd(result.financial.currentPackaging.fbaFee)} — ${result.financial.currentPackaging.tierLabel}`],
    ["ACOS hòa vốn", pct(s.base.breakEvenAcosPct)],
    ["Số lượng lô test đề xuất", r.testOrderQty === null ? NA : `${num(r.testOrderQty)} đơn`],
    ["Vốn hàng lô test", usd0(r.lotCapital)],
    ["Ngân sách quảng cáo test", `${usd0(r.adsBudgetPerDay)}/ngày × ${r.adsTestDays} ngày = ${usd0(r.adsTestSpend)}`],
    ["Mức lỗ tối đa nếu fail", usd0(r.maxLossAmount)],
  ];
  return (
    <div className="pr-block">
      <BlockTitle>Số tiền giám đốc cần biết</BlockTitle>
      <table className="pr-table pr-kv">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <th>{k}</th>
              <td className="pr-num">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* -------------------------------- P&L ----------------------------------- */

export function PrintPnl({ result }: { result: AssessmentResult }) {
  const s = result.financial.scenarios;
  const order = [
    ["pessimistic", "Bi quan", s.pessimistic],
    ["base", "Cơ sở", s.base],
    ["optimistic", "Lạc quan", s.optimistic],
  ] as const;
  return (
    <div className="pr-block">
      <BlockTitle>P&amp;L 3 kịch bản (trên 1 đơn vị)</BlockTitle>
      <table className="pr-table">
        <thead>
          <tr>
            <th>Chỉ tiêu</th>
            {order.map(([, label]) => (
              <th key={label} className="pr-num">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {([
            ["Giá bán", (x: (typeof s)["base"]) => usd(x.price)],
            ["Landed cost (COGS + inbound)", (x: (typeof s)["base"]) => usd(x.landedCost)],
            ["Phí referral", (x: (typeof s)["base"]) => usd(x.referralFee)],
            ["Phí FBA", (x: (typeof s)["base"]) => usd(x.fbaFee)],
            ["PPC/đơn", (x: (typeof s)["base"]) => (x.ppcPerOrder === null ? NA : usd(x.ppcPerOrder))],
            ["Dự phòng hoàn hàng", (x: (typeof s)["base"]) => usd(x.returnReserve)],
            ["Lợi nhuận ròng/đơn", (x: (typeof s)["base"]) => usd(x.netProfit)],
            ["Biên lợi nhuận ròng", (x: (typeof s)["base"]) => pct(x.netMarginPct)],
          ] as [string, (x: (typeof s)["base"]) => string][]).map(([label, fn]) => (
            <tr key={label}>
              <th>{label}</th>
              {order.map(([key, , x]) => (
                <td key={key} className="pr-num">
                  {fn(x)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {result.financial.monthly.length > 0 && (
        <>
          <BlockTitle>Mô phỏng tháng theo đơn lượng (kịch bản cơ sở)</BlockTitle>
          <table className="pr-table">
            <thead>
              <tr>
                <th className="pr-num">Đơn/tháng</th>
                <th className="pr-num">Doanh thu</th>
                <th className="pr-num">Lợi nhuận ròng</th>
                <th className="pr-num">Quảng cáo</th>
              </tr>
            </thead>
            <tbody>
              {result.financial.monthly.map((m) => (
                <tr key={m.unitsPerMonth}>
                  <td className="pr-num">{num(m.unitsPerMonth)}</td>
                  <td className="pr-num">{usd0(m.revenue)}</td>
                  <td className="pr-num">{usd0(m.netProfit)}</td>
                  <td className="pr-num">{m.adSpend === null ? NA : usd0(m.adSpend)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {result.financial.warnings.length > 0 && (
        <p className="pr-note">Cảnh báo engine: {result.financial.warnings.join("; ")}.</p>
      )}
    </div>
  );
}

/* ----------------------------- ĐÓNG GÓI --------------------------------- */

export function PrintPackaging({ result }: { result: AssessmentResult }) {
  const cur = result.financial.currentPackaging;
  const storage = result.financial.storage;
  return (
    <div className="pr-block">
      <BlockTitle>Size tier &amp; phương án đóng gói</BlockTitle>
      <table className="pr-table pr-kv">
        <tbody>
          <tr><th>Size tier hiện tại</th><td>{cur.tierLabel}</td></tr>
          <tr><th>Khối lượng tính phí</th><td>{cur.billableWeightLb.toFixed(2)} lb</td></tr>
          <tr><th>Thể tích</th><td>{storage.cubicFeet.toFixed(3)} ft³ · giả định {storage.monthsAssumed} tháng lưu kho</td></tr>
          <tr><th>Phí lưu kho/tháng (thấp–cao điểm)</th><td>{usd(storage.lowPerMonth)} – {usd(storage.peakPerMonth)}</td></tr>
        </tbody>
      </table>
      {result.financial.packagingSuggestions.filter((p) => p.savingPerUnit !== null && p.savingPerUnit! < 0).length > 0 && (
        <table className="pr-table">
          <thead>
            <tr><th>Phương án</th><th>Tier</th><th className="pr-num">Khối lượng (lb)</th><th className="pr-num">FBA/đơn</th><th className="pr-num">Tiết kiệm/đơn</th></tr>
          </thead>
          <tbody>
            {result.financial.packagingSuggestions
              .filter((p) => p.savingPerUnit !== null && p.savingPerUnit! < 0)
              .slice(0, 5)
              .map((p) => (
                <tr key={p.label}>
                  <td>{p.label}</td>
                  <td>{p.tierLabel}</td>
                  <td className="pr-num">{p.billableWeightLb.toFixed(2)}</td>
                  <td className="pr-num">{usd(p.fbaFee)}</td>
                  <td className="pr-num pr-good">{usd(p.savingPerUnit)}/đơn{p.savingPerYear !== null ? ` · ${usd0(p.savingPerYear)}/năm` : ""}</td>
                </tr>
              ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/* ------------------------------ ĐỐI THỦ --------------------------------- */

export function PrintCompetitors({ competitors }: { competitors: CompetitorRowView[] }) {
  const rows = competitors.filter((c) => !c.is_sponsored).slice(0, 12);
  return (
    <div className="pr-block">
      <BlockTitle>Top đối thủ organic (snapshot Rainforest)</BlockTitle>
      <table className="pr-table pr-compact">
        <thead>
          <tr>
            <th className="pr-num">#</th>
            <th>Thương hiệu / ASIN</th>
            <th className="pr-num">Giá</th>
            <th className="pr-num">★</th>
            <th className="pr-num">Số review</th>
            <th className="pr-num">Đơn/tháng</th>
            <th className="pr-num">Doanh thu/tháng</th>
            <th>1P</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.asin}>
              <td className="pr-num">{c.position}</td>
              <td>
                <b>{c.brand ?? "—"}</b>
                <span className="pr-muted"> · {c.asin}</span>
              </td>
              <td className="pr-num">{usd(c.price)}</td>
              <td className="pr-num">{c.rating === null ? NA : c.rating.toFixed(1)}</td>
              <td className="pr-num">{num(c.ratings_total)}</td>
              <td className="pr-num">{num(c.est_units_month)}</td>
              <td className="pr-num">{usd0(c.est_revenue_month)}</td>
              <td>{c.is_amazon_1p ? "⚠️ Amazon" : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* --------------------------- TẬP TRUNG THỊ TRƯỜNG ----------------------- */

export function PrintConcentration({ c }: { c: ConcentrationResult }) {
  const metricLabel = c.metric === "revenue" ? "% doanh thu" : c.metric === "units" ? "% sản lượng" : NA;
  return (
    <div className="pr-block">
      <BlockTitle>Tập trung thị trường (CR3/CR5/HHI)</BlockTitle>
      <table className="pr-table pr-kv">
        <tbody>
          <tr><th>Số ASIN organic / sponsored</th><td>{c.organicCount} / {c.sponsoredCount}</td></tr>
          <tr><th>Tỉ lệ vị trí quảng cáo</th><td>{pct(c.sponsoredSharePct)}</td></tr>
          <tr><th>CR3 / CR5</th><td>{pct(c.cr3Pct)} / {pct(c.cr5Pct)}</td></tr>
          <tr><th>HHI (0–10.000)</th><td>{c.hhi === null ? NA : Math.round(c.hhi).toLocaleString("en-US")}</td></tr>
          <tr><th>Tổng sản lượng/doanh thu tháng ước lượng</th><td>{num(c.totalEstUnitsMonth)} đơn / {usd0(c.totalEstRevenueMonth)}</td></tr>
          <tr><th>Amazon 1P trong organic / top 3</th><td>{c.amazon1p.productCount} ASIN ({pct(c.amazon1p.organicSharePct)}){c.amazon1p.inTop3 ? " · CÓ trong top 3" : ""}</td></tr>
          <tr><th>Độ phủ ước lượng sales</th><td>{pct(c.salesCoveragePct, 0)}</td></tr>
        </tbody>
      </table>
      <table className="pr-table pr-compact">
        <thead>
          <tr><th>Thương hiệu</th><th className="pr-num">Số ASIN</th><th className="pr-num">Vị trí tốt nhất</th><th className="pr-num">Thị phần{metricLabel !== NA ? ` (${metricLabel})` : ""}</th></tr>
        </thead>
        <tbody>
          {c.brands.slice(0, 8).map((b) => (
            <tr key={b.brand}>
              <td>{b.brand}</td>
              <td className="pr-num">{b.productCount}</td>
              <td className="pr-num">{b.topPosition}</td>
              <td className="pr-num">{pct(c.metric === "revenue" ? b.revenueSharePct : b.unitSharePct)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------ PAIN G4 --------------------------------- */

export function PrintPain({ pain }: { pain: PainData | null }) {
  if (!pain || pain.items.length === 0) {
    return (
      <div className="pr-block">
        <BlockTitle>Điểm đau khách hàng (G4)</BlockTitle>
        <p className="pr-missing">— Chưa chạy phân tích review: chưa đủ cơ sở —</p>
      </div>
    );
  }
  const must = pain.items.filter((i) => i.priority === "must").slice(0, 8);
  return (
    <div className="pr-block">
      <BlockTitle>3 cụm điểm đau &amp; hạng mục “must fix”</BlockTitle>
      <table className="pr-table pr-compact">
        <thead>
          <tr><th>Cụm</th><th className="pr-num">% review</th><th className="pr-num">Số review</th><th className="pr-num">★ TB</th></tr>
        </thead>
        <tbody>
          {pain.clusters.map((cl) => (
            <tr key={cl.code}>
              <td>{cl.label}</td>
              <td className="pr-num">{pct(cl.sharePct, 0)}</td>
              <td className="pr-num">{cl.reviewCount}</td>
              <td className="pr-num">{cl.avgStars === null ? NA : cl.avgStars.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table className="pr-table pr-compact">
        <thead>
          <tr><th>Hạng mục must-fix</th><th className="pr-num">Tần suất</th><th>Yêu cầu với xưởng</th><th>Tiêu chí nghiệm thu</th></tr>
        </thead>
        <tbody>
          {must.map((i) => (
            <tr key={i.itemKey}>
              <td><b>{i.title}</b></td>
              <td className="pr-num">{i.frequency} ({pct(i.frequencyPct, 0)})</td>
              <td>{i.factoryRequirement ?? "—"}</td>
              <td>{i.acceptanceStandard ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ----------------------------- MÙA VỤ BSR ------------------------------- */

export function PrintSeasonality({ points }: { points: BsrPoint[] }) {
  const season = points.length ? computeSeasonality(points) : null;
  const advice = points.length ? restockAdvice(points, { leadWeeks: 8 }) : null;
  const monthName = (m: number | null) =>
    m === null ? "—" : ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"][m - 1];

  const byAsin = new Map<string, import("@/lib/research/domain").BsrPoint[]>();
  for (const p of points) {
    const arr = byAsin.get(p.asin) ?? [];
    arr.push(p);
    byAsin.set(p.asin, arr);
  }
  const top = [...byAsin.entries()]
    .map(([asin, pts]) => ({ asin, t: summarizeBsr(pts) }))
    .sort((a, b) => (a.t.latestBsr ?? 1e9) - (b.t.latestBsr ?? 1e9))
    .slice(0, 8);

  return (
    <div className="pr-block">
      <BlockTitle>Lịch sử BSR &amp; mùa vụ (dữ liệu Rainforest tích lũy / Keepa)</BlockTitle>
      {!season ? (
        <p className="pr-missing">— Chưa đủ cơ sở nhận diện mùa vụ (cần ≥12 điểm trải ≥8 tuần) —</p>
      ) : (
        <table className="pr-table pr-kv">
          <tbody>
            <tr><th>Tháng cao điểm / chậm nhất</th><td>tháng {monthName(season.peakMonth)} / tháng {monthName(season.troughMonth)}</td></tr>
            <tr><th>Độ sâu mùa vụ (BSR đỉnh/đáy)</th><td>{season.peakTroughRatio === null ? "—" : `${(season.peakTroughRatio * 100).toFixed(0)}%`} · độ tin cậy {season.confidence} ({season.yearsCovered} năm)</td></tr>
            {advice && <tr><th>Khuyến nghị chốt đơn xưởng (lead 8 tuần)</th><td>tháng {monthName(advice.orderByMonth)}</td></tr>}
          </tbody>
        </table>
      )}
      <table className="pr-table pr-compact">
        <thead>
          <tr><th>ASIN</th><th className="pr-num">BSR hiện tại</th><th className="pr-num">TB 30 ngày</th><th className="pr-num">TB 90 ngày</th><th className="pr-num">Số điểm</th></tr>
        </thead>
        <tbody>
          {top.map(({ asin, t }) => (
            <tr key={asin}>
              <td>{asin}</td>
              <td className="pr-num">{t.latestBsr === null ? "—" : Math.round(t.latestBsr).toLocaleString("en-US")}</td>
              <td className="pr-num">{t.medianBsr30d === null ? "—" : Math.round(t.medianBsr30d).toLocaleString("en-US")}</td>
              <td className="pr-num">{t.medianBsr90d === null ? "—" : Math.round(t.medianBsr90d).toLocaleString("en-US")}</td>
              <td className="pr-num">{t.points}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------ ROADMAP --------------------------------- */

export function PrintRoadmap({ result }: { result: AssessmentResult }) {
  const r = result.roadmap;
  return (
    <div className="pr-block">
      <BlockTitle>Mốc quyết định (gates) &amp; kill-criteria</BlockTitle>
      <table className="pr-table">
        <thead>
          <tr><th className="pr-num">Tuần</th><th>Chỉ tiêu cần đạt</th></tr>
        </thead>
        <tbody>
          {r.gates.map((g) => (
            <tr key={g.week}>
              <td className="pr-num">T+{g.week}</td>
              <td>
                <ul className="pr-plain">
                  {g.metrics.map((m) => <li key={m}>{m}</li>)}
                </ul>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="pr-kill">
        <b>DỪNG CUỘC nếu:</b>
      </p>
      <ul className="pr-kill-list">
        {r.killCriteria.map((k) => <li key={k}>✗ {k}</li>)}
      </ul>
      {r.notes.length > 0 && <p className="pr-note">{r.notes.join(" · ")}</p>}
    </div>
  );
}

/* ------------------------------- VETO ----------------------------------- */

export function PrintVetoAcks({
  result,
  acks,
}: {
  result: AssessmentResult;
  acks: VetoAckRow[];
}) {
  const reds = result.scorecard.vetoes.filter((v) => v.severity === "red");
  if (reds.length === 0) {
    return (
      <div className="pr-block">
        <BlockTitle>Sổ đăng ký rủi ro &amp; veto</BlockTitle>
        <p className="pr-good">Không có veto đỏ ở phiên bản engine này.</p>
      </div>
    );
  }
  return (
    <div className="pr-block">
      <BlockTitle>Veto đỏ &amp; biên bản nhìn nhận</BlockTitle>
      <table className="pr-table">
        <thead>
          <tr><th>Mã cờ</th><th>Diễn giải</th><th>Đã nhìn nhận</th></tr>
        </thead>
        <tbody>
          {reds.map((v) => {
            const ack = acks.find((a) => a.ruleCode === v.code);
            return (
              <tr key={v.code}>
                <td><b>{v.code}</b></td>
                <td>{v.title} — {v.detail}</td>
                <td>
                  {ack ? (
                    <span className="pr-good">
                      ✓ {ack.acknowledgedName ?? "—"}
                      {ack.createdAt ? ` · ${new Date(ack.createdAt).toLocaleDateString("vi-VN")}` : ""}
                      {ack.note ? ` — “${ack.note}”` : ""}
                    </span>
                  ) : (
                    <span className="pr-bad">CHƯA nhìn nhận — không được duyệt</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------ KÝ TÊN ---------------------------------- */

export function PrintSignoff({
  analystName,
}: {
  analystName: string | null;
}) {
  const lines = [
    ["Chuyên viên R&D soạn nháp & số liệu", analystName ?? "............................"],
    ["Trưởng phòng R&D hiệu đính & ký từng phần", "............................"],
    ["Trưởng phòng vận hành nhìn nhận veto", "............................"],
    ["Giám đốc phê duyệt phát hành", "............................"],
  ] as const;
  return (
    <div className="pr-block pr-signoff">
      <BlockTitle>Bảng ký tên</BlockTitle>
      <div className="pr-signoff-grid">
        {lines.map(([role, name]) => (
          <div key={role} className="pr-signoff-cell">
            <div className="pr-signoff-line">{name}</div>
            <div className="pr-signoff-role">{role}</div>
            <div className="pr-signoff-date">Ngày …… tháng …… năm 20…</div>
          </div>
        ))}
      </div>
      <p className="pr-note">
        Bản in này trích số khóa cứng từ engine và câu trích truy gốc review Amazon tại ngày chụp version;
        narrative do con người hiệu đính và ký từng phần. Mọi thay đổi sau ký đều tạo version mới.
      </p>
    </div>
  );
}
