/**
 * Module 8 — danh sách hồ sơ thẩm định R&D: /research
 */

import Link from "next/link";
import { Chip, NoAccess, PageHeader, tableCls } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import type { PersonaKey } from "@/lib/roles";
import { readAssessments } from "@/lib/data/research";
import {
  STATUS_LABEL,
  VERDICT_LABEL,
  VERDICT_TONE,
  shortDate,
  type AssessmentListRow,
} from "@/lib/data/research-model";

// G1 tạm cho ceo (chưa có persona analyst trong bộ 4 vai trò demo).
const ALLOWED: PersonaKey[] = ["ceo"];

const marginCls = (v: number | null): string => {
  if (v === null) return "text-soft";
  if (v >= 20) return "text-green font-bold";
  if (v >= 12) return "text-amber font-bold";
  return "text-red font-bold";
};

function Row({ r }: { r: AssessmentListRow }) {
  return (
    <tr className="hover:bg-[#f7f9fc]">
      <td className={tableCls.td}>
        <Link href={`/research/${r.id}`} className="font-bold text-[#234a7d] hover:underline">
          {r.code}
        </Link>
        <div className="text-[11.5px] text-soft">{STATUS_LABEL[r.status] ?? r.status}</div>
      </td>
      <td className={tableCls.td}>
        <div className="font-semibold">{r.title}</div>
        <div className="text-[11.5px] text-soft">{r.keywords?.join(", ") ?? ""}</div>
      </td>
      <td className={tableCls.td}>
        {r.verdict ? <Chip tone={VERDICT_TONE[r.verdict]}>{VERDICT_LABEL[r.verdict]}</Chip> : <Chip tone="gray">—</Chip>}
      </td>
      <td className={`${tableCls.tdNum} ${marginCls(r.pess_margin_pct)}`}>{r.pess_margin_pct === null ? "—" : `${r.pess_margin_pct.toFixed(1)}%`}</td>
      <td className={`${tableCls.tdNum} ${marginCls(r.base_margin_pct)}`}>{r.base_margin_pct === null ? "—" : `${r.base_margin_pct.toFixed(1)}%`}</td>
      <td className={tableCls.td}>{r.size_tier ? r.size_tier.replace(/_/g, " ") : "—"}</td>
      <td className={`${tableCls.tdNum} font-bold ${r.red_veto_count > 0 ? "text-red" : r.veto_count > 0 ? "text-amber" : "text-green"}`}>
        {r.red_veto_count > 0 ? `${r.red_veto_count} đỏ` : r.veto_count > 0 ? `${r.veto_count} cảnh báo` : "sạch"}
      </td>
      <td className={tableCls.td}>{r.analyst_name ?? "—"}</td>
      <td className={tableCls.td}>{shortDate(r.created_at)}</td>
    </tr>
  );
}

export default async function ResearchListPage() {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;
  const { rows, mode } = await readAssessments();

  return (
    <>
      <PageHeader
        title="Thẩm định R&D sản phẩm"
        sub="Module 8 · Product Research"
        desc="Hồ sơ what-if cho ngách sản phẩm mới: P&L 3 kịch bản, break-even ACOS, FBA size tier, scorecard 5 trụ với veto đỏ không gỡ được. G1 mới chạy được phần tài chính."
      />
      <div className="mb-3 flex items-center justify-between">
        <span className="text-[12.5px] font-semibold text-soft">
          {rows.length} hồ sơ{mode === "demo" ? " (dữ liệu minh họa DEMO)" : ""}
        </span>
        <Link
          href="/research/new"
          className="rounded-[10px] bg-[#1f3a5f] px-3.5 py-1.5 text-[12.5px] font-extrabold text-white"
        >
          + Hồ sơ what-if mới
        </Link>
      </div>
      <div className="overflow-x-auto rounded-[13px] border border-line bg-card">
        <table className={tableCls.table}>
          <thead>
            <tr>
              <th className={tableCls.th}>Mã / trạng thái</th>
              <th className={tableCls.th}>Ngách</th>
              <th className={tableCls.th}>Kết luận</th>
              <th className={`${tableCls.th} text-right`}>Biên bi quan</th>
              <th className={`${tableCls.th} text-right`}>Biên cơ sở</th>
              <th className={tableCls.th}>Size tier</th>
              <th className={`${tableCls.th} text-right`}>Veto</th>
              <th className={tableCls.th}>Chuyên viên</th>
              <th className={tableCls.th}>Tạo ngày</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Row key={r.id} r={r} />
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-8 text-center text-[13px] text-soft">
                  Chưa có hồ sơ nào. Bắt đầu bằng <Link href="/research/new" className="font-bold text-[#234a7d] underline">máy tính what-if</Link>.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
