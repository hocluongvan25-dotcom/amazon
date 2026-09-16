/**
 * Module 8 G5 — Report Canvas: /research/[id]/editor
 * Trang biên soạn báo cáo narrative (TipTap), tách khỏi trang phân tích.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { NoAccess, PageHeader } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import type { PersonaKey } from "@/lib/roles";
import { readAssessmentDetail } from "@/lib/data/research";
import { readReportData, loadNarrativeContext } from "@/lib/data/research-report";
import { ReportCanvas } from "@/components/research/report-canvas";
import { STATUS_LABEL, shortDate } from "@/lib/data/research-model";

// Các server action canvas gọi LLM thật: "✨ AI soát nháp các khối trống" nháp
// ~25 khối narrative (3 khối song song/đợt) — cần trần 60s như trang chi tiết,
// mặc định Vercel 10s sẽ cắt giữa chừng.
export const maxDuration = 60;

const ALLOWED: PersonaKey[] = ["ceo"];

export default async function ReportEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;

  const { id } = await params;
  const [detail, report] = await Promise.all([
    readAssessmentDetail(id),
    readReportData(id),
  ]);
  if (!detail || !report) notFound();

  // Ngữ cảnh chip (không gọi LLM, chỉ bóc từ snapshot engine + pain G4).
  let metrics: Awaited<ReturnType<typeof loadNarrativeContext>>["metrics"] = [];
  let quotes: Awaited<ReturnType<typeof loadNarrativeContext>>["quotes"] = [];
  try {
    const ctx = await loadNarrativeContext(id);
    metrics = ctx.metrics;
    quotes = ctx.quotes;
  } catch {
    // thiếu dữ liệu thu thập → editor vẫn mở, panel chèn chip rỗng
  }

  const { row, result } = detail;

  return (
    <>
      <div className="mb-2">
        <Link href={`/research/${id}`} className="text-[12.5px] font-bold text-soft transition hover:text-ink active:opacity-60">
          ← Về trang phân tích {row.code}
        </Link>
      </div>
      <PageHeader
        title={`Báo cáo R&D — ${row.title}`}
        sub={`${row.code} · ${STATUS_LABEL[row.status] ?? row.status} · ${row.analyst_name ?? ""} · tạo ${shortDate(row.created_at)}`}
        desc="Số khóa cứng từ engine, câu trích truy gốc review; ký từng phần trước khi gửi duyệt."
      />
      <ReportCanvas
        assessmentId={id}
        report={report}
        metrics={metrics}
        quotes={quotes}
        vetoes={result.scorecard.vetoes.map((v) => ({
          code: v.code,
          severity: v.severity,
          title: v.title,
          detail: v.detail,
        }))}
        meta={{
          title: row.title,
          code: row.code,
          status: STATUS_LABEL[row.status] ?? row.status,
          analystName: row.analyst_name ?? null,
          createdAt: row.created_at,
          engineVersion: result.engineVersion,
          dataExpiresAt: row.data_expires_at,
          verdictLabel: result.scorecard.verdictLabel,
          llmLabel: report.llm.configured
            ? `${report.llm.providerName}/${report.llm.model}`
            : "mock-llm (nháp minh họa; chưa gắn LLM_API_KEY)",
        }}
      />
    </>
  );
}
