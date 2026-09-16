/**
 * Module 8 G6 — bản in/PDF: /research/[id]/report?kind=exec|full
 * Render server thuần (không TipTap): cùng bộ số engine + section đã duyệt,
 * khổ A4, watermark bảo mật, In → Lưu PDF. Không thêm dependency PDF.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { NoAccess } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import type { PersonaKey } from "@/lib/roles";
import { readAssessmentDetail, readCollectionData, type CompetitorRowView } from "@/lib/data/research";
import { readPainData } from "@/lib/data/research-pain";
import { readPrintData } from "@/lib/data/research-report";
import { readBsrHistory } from "@/lib/data/research-seasonality";
import { analyzeConcentration, type CompetitorInput } from "@/lib/research/domain";
import { PrintReport } from "@/components/research/print-report";
import { PrintToolbar } from "@/components/research/print-toolbar";
import { STATUS_LABEL, shortDate } from "@/lib/data/research-model";
import "./print.css";

// Khách (client) chỉ được xem bản ĐÃ phát hành; nội bộ thấy mọi trạng thái.
const ALLOWED: PersonaKey[] = ["ceo"];

export default async function ResearchReportPrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ kind?: string }>;
}) {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;

  const { id } = await params;
  const { kind: rawKind } = await searchParams;
  const kind: "exec" | "full" = rawKind === "exec" ? "exec" : "full";

  const [detail, collection, pain, report] = await Promise.all([
    readAssessmentDetail(id),
    readCollectionData(id),
    readPainData(id),
    readPrintData(id),
  ]);
  if (!detail || !collection || !report || !pain) notFound();
  const bsr = await readBsrHistory(id, collection.competitors).catch(() => null);

  const competitors: CompetitorRowView[] = collection.competitors;
  const input: CompetitorInput[] = competitors.map((c) => ({
    asin: c.asin,
    parentAsin: c.parent_asin,
    brand: c.brand,
    isSponsored: c.is_sponsored,
    position: c.position,
    price: c.price,
    rating: c.rating,
    ratingsTotal: c.ratings_total,
    estUnitsMonth: c.est_units_month,
    estRevenueMonth: c.est_revenue_month,
    isAmazon1p: !!c.is_amazon_1p,
  }));
  const concentration = analyzeConcentration(input);

  const { row, result } = detail;

  return (
    <>
      <PrintToolbar assessmentId={id} kind={kind} isDraft={report.isDraft} versionNo={report.version.versionNo} />
      <div className="pr-backdrop">
        <div id="print-root">
          {/* watermark + header/footer lặp mọi trang giấy khi in */}
          <div className="pr-watermark" aria-hidden />
          <div className="pr-running-head">
            <span>VEXIM R&amp;D — BÁO CÁO THẨM ĐỊNH SẢN PHẨM</span>
            <span>
              {row.code} · v{report.version.versionNo} · {STATUS_LABEL[row.status] ?? row.status}
            </span>
          </div>
          <div className="pr-running-foot">
            <span>TÀI LIỆU BẢO MẬT — VEXIM · {shortDate(new Date().toISOString())}</span>
            <span>{kind === "exec" ? "Bản tóm tắt điều hành" : "Bản đầy đủ"}</span>
          </div>

          <PrintReport
            kind={kind}
            meta={{
              title: row.title,
              code: row.code,
              status: STATUS_LABEL[row.status] ?? row.status,
              analystName: row.analyst_name ?? null,
              createdAt: row.created_at,
              engineVersion: result.engineVersion,
              dataExpiresAt: row.data_expires_at,
              collectedAt: shortDate(new Date().toISOString()),
              llmLabel: report.llm.configured
                ? `${report.llm.providerName}/${report.llm.model}`
                : "mock-llm (nháp minh họa)",
            }}
            report={report}
            result={result}
            competitors={competitors}
            concentration={concentration}
            pain={pain.items.length ? pain : null}
            bsrPoints={bsr?.points ?? []}
          />
        </div>
      </div>
      {report.isDraft && (
        <div style={{ maxWidth: "210mm", margin: "0 auto 20px" }}>
          <Link href={`/research/${id}/editor`} style={{ fontSize: 13 }}>
            ← Bản NHÁP chưa duyệt — quay lại canvas để ký &amp; gửi duyệt
          </Link>
        </div>
      )}
    </>
  );
}
