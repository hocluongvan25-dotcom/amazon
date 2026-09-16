/**
 * Module 8 G6 — lắp ráp BẢN IN A4 từ snapshot engine + các section narrative
 * đã duyệt. Hai template từ cùng một bộ số:
 *  - exec: bìa + kết luận + 5 trụ + số tiền giám đốc + gates/kill + veto + ký
 *  - full: toàn bộ section theo registry, xen khối dữ liệu máy tính.
 */

import React from "react";
import { SECTION_REGISTRY } from "@/lib/research/domain";
import type { AssessmentResult, ConcentrationResult } from "@/lib/research/domain";
import type { PainData } from "@/lib/data/research-pain";
import type { CompetitorRowView } from "@/lib/data/research";
import type { PrintReportData } from "@/lib/data/research-report";
import { PrintDoc } from "./print-doc";
import {
  PrintCompetitors,
  PrintConcentration,
  PrintMoney,
  PrintPackaging,
  PrintPain,
  PrintPnl,
  PrintRoadmap,
  PrintScorecard,
  PrintSignoff,
  PrintVetoAcks,
} from "./print-blocks";

export type PrintMeta = {
  title: string;
  code: string;
  status: string;
  analystName: string | null;
  createdAt: string;
  engineVersion: string;
  dataExpiresAt: string | null;
  collectedAt: string;
  llmLabel: string;
};

export function PrintReport(props: {
  kind: "exec" | "full";
  meta: PrintMeta;
  report: PrintReportData;
  result: AssessmentResult;
  competitors: CompetitorRowView[];
  concentration: ConcentrationResult;
  pain: PainData | null;
}) {
  const { kind, meta, report, result, competitors, concentration, pain } = props;
  const sec = (key: string) => report.sections[key];

  const Narrative = ({ k, pageBreak = false }: { k: string; pageBreak?: boolean }) => {
    const def = SECTION_REGISTRY.find((s) => s.key === k);
    const row = sec(k);
    return (
      <section className={`pr-section${pageBreak ? " pr-new-page" : ""}`}>
        <h2 className="pr-h2">{def?.title ?? k}</h2>
        <PrintDoc doc={row?.content ?? null} />
      </section>
    );
  };

  const Cover = (
    <section className="pr-page pr-cover">
      <div className="pr-cover-brand">VEXIM CO., LTD — PHÒNG R&amp;D SẢN PHẨM</div>
      <div className="pr-cover-kind">BÁO CÁO THẨM ĐỊNH SẢN PHẨM{kind === "exec" ? " — BẢN TÓM TẮT ĐIỀU HÀNH" : " ĐẦY ĐỦ"}</div>
      <h1 className="pr-cover-title">{meta.title}</h1>
      <dl className="pr-cover-meta">
        <div><dt>Mã hồ sơ</dt><dd><b>{meta.code}</b></dd></div>
        <div><dt>Phiên bản in</dt><dd>v{report.version.versionNo} ({versionLabelVi(report.version.status)})</dd></div>
        <div><dt>Kết luận engine</dt><dd>{result.scorecard.verdictLabel}</dd></div>
        <div><dt>Điểm tổng 5 trụ</dt><dd>{result.scorecard.overallScore === null ? "chưa đủ cơ sở" : `${result.scorecard.overallScore.toFixed(1)}/10`}</dd></div>
        <div><dt>Chuyên viên</dt><dd>{meta.analystName ?? "—"}</dd></div>
        <div><dt>Ngày số liệu</dt><dd>{meta.collectedAt}</dd></div>
        <div><dt>Số liệu hiệu lực tới</dt><dd>{meta.dataExpiresAt ? meta.dataExpiresAt.slice(0, 10) : "—"}</dd></div>
        <div><dt>Engine</dt><dd>{meta.engineVersion}</dd></div>
        <div><dt>Bộ soát nháp narrative</dt><dd>{meta.llmLabel}</dd></div>
      </dl>
      <div className="pr-cover-verdict">
        <div className="pr-cover-verdict-label">Khuyến nghị máy</div>
        <div className="pr-cover-verdict-value">{result.scorecard.verdictLabel}</div>
      </div>
      <div className="pr-cover-foot">
        Tài liệu bảo mật — chỉ dùng nội bộ VEXIM và khách hàng được phát hành.<br />
        Mọi con số là chip khóa cứng từ engine; câu trích khách hàng truy nguyên về review gốc Amazon.
      </div>
    </section>
  );

  const SignPage = (
    <section className="pr-page pr-new-page">
      <Narrative k="appendix_signoff" />
      <PrintSignoff analystName={meta.analystName} />
    </section>
  );

  if (kind === "exec") {
    return (
      <div className="pr-stack">
        {Cover}
        <section className="pr-page">
          <Narrative k="exec_verdict" />
          <PrintScorecard result={result} />
        </section>
        <section className="pr-page pr-new-page">
          <PrintMoney result={result} />
          <Narrative k="roadmap_gates" />
          <PrintRoadmap result={result} />
        </section>
        <section className="pr-page pr-new-page">
          <Narrative k="risk_register" />
          <PrintVetoAcks result={result} acks={report.acks} />
          <Narrative k="appendix_method" />
        </section>
        {SignPage}
      </div>
    );
  }

  return (
    <div className="pr-stack">
      {Cover}

      <section className="pr-page">
        <Narrative k="exec_verdict" />
        <PrintScorecard result={result} />
      </section>

      <section className="pr-page pr-new-page">
        <h2 className="pr-part">PHẦN A — TÀI CHÍNH</h2>
        <Narrative k="fin_assumptions" />
        <Narrative k="fin_pnl" />
        <PrintPnl result={result} />
        <Narrative k="fin_scale" />
        <PrintPackaging result={result} />
        <Narrative k="fin_packaging" />
      </section>

      <section className="pr-page pr-new-page">
        <h2 className="pr-part">PHẦN B — THỊ TRƯỜNG</h2>
        <Narrative k="mkt_definition" />
        <Narrative k="mkt_toplist" />
        <PrintCompetitors competitors={competitors} />
        <Narrative k="mkt_share" />
        <PrintConcentration c={concentration} />
        <Narrative k="mkt_structure" />
        <Narrative k="mkt_conclusion" />
      </section>

      <section className="pr-page pr-new-page">
        <h2 className="pr-part">PHẦN C — KHÁCH HÀNG &amp; R&amp;D</h2>
        <Narrative k="rd_method" />
        <Narrative k="rd_clusters" />
        <PrintPain pain={pain} />
        <Narrative k="rd_pain_top" />
        <Narrative k="rd_specsheet" />
        <Narrative k="rd_priority" />
      </section>

      <section className="pr-page pr-new-page">
        <h2 className="pr-part">PHẦN D — LỘ TRÌNH KIỂM CHỨNG</h2>
        <Narrative k="roadmap_phase0" />
        <Narrative k="roadmap_order" />
        <Narrative k="roadmap_ads" />
        <Narrative k="roadmap_gates" />
        <PrintRoadmap result={result} />
        <Narrative k="roadmap_cashflow" />
        <PrintMoney result={result} />
      </section>

      <section className="pr-page pr-new-page">
        <h2 className="pr-part">PHẦN E — RỦI RO &amp; PHỤ LỤC</h2>
        <Narrative k="risk_register" />
        <PrintVetoAcks result={result} acks={report.acks} />
        <Narrative k="appendix_method" />
        <Narrative k="appendix_limits" />
        <Narrative k="appendix_glossary" />
      </section>

      {SignPage}
    </div>
  );
}

function versionLabelVi(status: string): string {
  const map: Record<string, string> = {
    draft: "NHÁP",
    in_review: "ĐANG DUYỆT",
    changes_requested: "YÊU CẦU SỬA",
    approved: "ĐÃ DUYỆT",
    published: "ĐÃ PHÁT HÀNH",
    stale: "CŨ",
  };
  return map[status] ?? status;
}
