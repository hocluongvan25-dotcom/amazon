import { Chip, KpiCard, KpiGrid, PageHeader, Panel, tableCls } from "@/components/ui";
import { getLiveHealth } from "@/lib/data/health";
import { healthTone, rateText } from "@/lib/data/health-model";

export async function LiveHealth({ violations = false }: { violations?: boolean }) {
  const result = await getLiveHealth();
  return <>
    <PageHeader title={violations ? "Chi tiết vấn đề tài khoản" : "Vận hành & Account Health"}
      sub="SUPABASE · dữ liệu trong phạm vi RLS của bạn"
      desc="Sức khỏe tài khoản bán hàng: điểm vi phạm và chỉ số hiệu suất so với ngưỡng Amazon yêu cầu — phát hiện rủi ro trước khi tài khoản bị ảnh hưởng." />
    <div className="mb-4 flex gap-4 text-sm text-accent-ink"><a href="/health">Sức khỏe theo shop</a><a href="/health/violations">Vấn đề đang mở</a></div>
    {!result.ok ? <Panel title="Không tải được dữ liệu"><p role="alert">Không thể đọc Account Health từ Supabase. Hãy kiểm tra migration 0010/0011, quyền SELECT và RLS hoặc tải lại trang. Không sử dụng dữ liệu demo thay thế.</p></Panel> : <>
      <KpiGrid>
        <KpiCard label="Shop có snapshot" value={String(new Set(result.snapshots.map(s => s.seller_account_id)).size)} sub="Trong phạm vi được phép đọc" />
        <KpiCard label="Shop / marketplace xanh" value={String(result.snapshots.filter(s => s.tone === "green").length)} sub="Snapshot mới nhất mỗi marketplace" />
        <KpiCard label="Shop / marketplace vàng, đỏ" value={String(result.snapshots.filter(s => ["amber", "red"].includes(s.tone ?? "")).length)} sub="Cần theo dõi theo SOP-08" tone="warn" />
        <KpiCard label="Nhóm vấn đề mở" value={String(result.issues.length)} sub={`${new Set(result.issues.map(i => i.seller_account_id)).size} shop bị ảnh hưởng; không phải số case`} />
      </KpiGrid>
      {violations ? <Panel title="Nhóm vấn đề đang mở" hint="Critical → High → Medium → Low">
        {!result.issues.length ? <p>Chưa có vấn đề mở trong dữ liệu bạn được phép đọc. Điều này không xác nhận tài khoản đã khỏe hoặc đã được đồng bộ.</p> : <div className="overflow-x-auto"><table className={tableCls.table}>
          <thead><tr>{["Vi phạm", "Mức độ", "Shop / marketplace", "Số lỗi", "Kỳ báo cáo từ", "Trạng thái", "Case"].map(h => <th key={h} className={tableCls.th}>{h}</th>)}</tr></thead>
          <tbody>{result.issues.map(i => <tr key={i.id}>
            <td className={tableCls.td}>{i.label}</td><td className={tableCls.td}><Chip tone={i.severity === "Critical" || i.severity === "High" ? "red" : i.severity === "Medium" ? "amber" : "gray"}>{i.severity}</Chip></td>
            <td className={tableCls.td}>{i.shop} · {i.marketplace_id}</td><td className={tableCls.td}>{i.defects_count}</td><td className={tableCls.td}>{i.reporting_from ?? "—"}</td><td className={tableCls.td}>{i.status ?? "—"}</td><td className={tableCls.td}>{i.case_id ?? "Chưa gán"}</td>
          </tr>)}</tbody></table></div>}
      </Panel> : <Panel title="Snapshot mới nhất theo shop / marketplace">
        {!result.snapshots.length ? <p>Chưa có snapshot trong phạm vi của bạn. Cần đồng bộ báo cáo Account Health; không hiển thị số liệu demo.</p> : <div className="overflow-x-auto"><table className={tableCls.table}>
          <thead><tr>{["Shop / marketplace", "AHR", "ODR", "Late ship", "Trạng thái", "Ngày báo cáo", "Thu thập (UTC)"].map(h => <th key={h} className={tableCls.th}>{h}</th>)}</tr></thead>
          <tbody>{result.snapshots.map(s => <tr key={`${s.seller_account_id}:${s.marketplace_id}`}>
            <td className={tableCls.td}>{s.shop} · {s.marketplace_id}</td><td className={tableCls.td}>{s.score ?? "—"}</td><td className={tableCls.td}>{rateText(s.rates, "orderDefectRate")}</td><td className={tableCls.td}>{rateText(s.rates, "lateShipmentRate")}</td><td className={tableCls.td}><Chip tone={healthTone(s.tone)}>{s.account_status ?? "Chưa rõ"}</Chip></td><td className={tableCls.td}>{s.day}</td><td className={tableCls.td}>{s.captured_at}</td>
          </tr>)}</tbody></table></div>}
      </Panel>}
      <Panel title="Lưu ý vận hành"><p>Chỉ đọc; appeal thực hiện trên Seller Central theo SOP-08. Chỉ số thiếu hiển thị “—”, không quy về 0. Tác vụ quá hạn chưa nối dữ liệu thật trong màn này.</p></Panel>
    </>}
  </>;
}
