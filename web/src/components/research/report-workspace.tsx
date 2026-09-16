"use client";

/**
 * Module 8 G5 — khung làm việc Report Canvas: danh sách section + trạng thái
 * ký, panel veto đỏ (chỉ ack, không gỡ), nút quy trình (submit / request
 * changes / approve), lịch sử version bất biến.
 */

import React, { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  REQUIRED_SECTIONS,
  SECTION_REGISTRY,
  checkRequiredSections,
  docHasContent,
  type MetricToken,
  type QuoteToken,
} from "@/lib/research/domain";
import type { ReportData, ReportSectionRow, VetoAckRow } from "@/lib/data/research-report";
import { SectionEditor } from "./section-editor";
import {
  ackVetoAction,
  approveReportAction,
  generateAllDraftsAction,
  openDraftAction,
  requestChangesAction,
  submitReportAction,
} from "@/app/(app)/research/report-actions";

type VetoLite = { code: string; severity: "red" | "warning"; title: string; detail: string };

export type ReportWorkspaceProps = {
  assessmentId: string;
  report: ReportData;
  metrics: MetricToken[];
  quotes: QuoteToken[];
  vetoes: VetoLite[];
  meta: ReportMetaLike;
};

type ReportMetaLike = {
  title: string;
  code: string;
  status: string;
  analystName: string | null;
  createdAt: string;
  engineVersion: string;
  dataExpiresAt: string | null;
  verdictLabel: string;
  llmLabel: string;
};

export function ReportWorkspace(props: ReportWorkspaceProps) {
  const { assessmentId, report, metrics, quotes, vetoes } = props;
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [generating, setGenerating] = useState(false);

  const draftVersion = report.versions.find((v) => v.versionNo === report.draftVersionNo) ?? null;
  const draftStatus = draftVersion?.status ?? null;
  const workflowEnabled = report.mode === "supabase" && draftStatus === "draft";

  const sections = report.sections;
  const statusByKey = Object.fromEntries(
    Object.entries(sections).map(([k, r]) => [
      k,
      r && docHasContent(r.content) ? r.status : undefined,
    ]),
  );
  const requiredCheck = checkRequiredSections(statusByKey);
  const verifiedCount = REQUIRED_SECTIONS.length - requiredCheck.missing.length;
  const redVetoes = vetoes.filter((v) => v.severity === "red");
  const ackedCodes = new Set(report.acks.map((a: VetoAckRow) => a.ruleCode));
  const redAllAcked = redVetoes.every((v) => ackedCodes.has(v.code));

  const done = (r: { ok: boolean; message: string }) => {
    setNotice({ ok: r.ok, text: r.message });
    router.refresh();
  };

  const scrollTo = (key: string) => {
    document.getElementById(`sec-${key}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="space-y-4">
      {report.mode === "demo" && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          <b>DEMO:</b> đây là bản nháp minh họa bằng mock LLM. Mọi chip số/câu trích đều khóa cứng; chế độ
          ký/gửi duyệt/lưu tắt. Tạo hồ sơ thật để dùng quy trình đầy đủ.
        </div>
      )}
      {notice && (
        <div
          className={`rounded-lg px-4 py-2 text-sm ${notice.ok ? "bg-green-50 text-green-800 border border-green-200" : "bg-red-50 text-red-800 border border-red-200"}`}
          role="status"
        >
          {notice.text}
          <button className="ml-2 text-xs underline" onClick={() => setNotice(null)}>
            ẩn
          </button>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        {/* ------------------------------ CỘT TRÁI ------------------------------ */}
        <aside className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-semibold text-slate-700">Tiến độ ký</span>
              <span className="text-sm font-bold text-slate-800">
                {verifiedCount}/{REQUIRED_REQUIRED}
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded bg-slate-100">
              <div
                className="h-full bg-green-600"
                style={{ width: `${(verifiedCount / REQUIRED_REQUIRED) * 100}%` }}
              />
            </div>
            <ul className="mt-3 space-y-1">
              {SECTION_REGISTRY.map((def) => {
                const row: ReportSectionRow | undefined = sections[def.key];
                const st: string =
                  row?.status === "verified" ? "verified" : row && docHasContent(row.content) ? "drafted" : "empty";
                const icon = st === "verified" ? "✅" : st === "drafted" ? "✏️" : "⬜";
                return (
                  <li key={def.key}>
                    <button
                      onClick={() => scrollTo(def.key)}
                      className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[13px] text-slate-700 hover:bg-slate-100"
                    >
                      <span>{icon}</span>
                      <span className="flex-1 truncate">
                        {def.title}
                        {def.required && <span className="text-red-600"> *</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {requiredCheck.missing.length > 0 && draftStatus === "draft" && (
              <p className="mt-2 rounded bg-red-50 px-2 py-1 text-[11px] text-red-700">
                Chưa đủ chữ ký: {requiredCheck.missing.join(", ")}
              </p>
            )}
          </div>

          {/* Veto đỏ */}
          {redVetoes.length > 0 && (
            <div className="rounded-xl border border-red-200 bg-white p-3 shadow-sm">
              <h3 className="mb-2 text-sm font-semibold text-red-800">⛔ Cờ veto đỏ — không gỡ được</h3>
              <p className="mb-2 text-[11px] text-slate-500">
                Văn bản không xóa được cờ; trưởng phòng chỉ xác nhận đã nhìn thấy trước khi duyệt.
              </p>
              <ul className="space-y-2">
                {redVetoes.map((v) => {
                  const ack = report.acks.find((a) => a.ruleCode === v.code);
                  return (
                    <li key={v.code} className="rounded-lg border border-red-200 bg-red-50 p-2 text-[12px]">
                      <div className="font-semibold text-red-900">{v.title}</div>
                      <div className="text-red-800/80">{v.detail}</div>
                      {ack ? (
                        <div className="mt-1 text-[11px] text-green-800">
                          Đã nhìn nhận bởi {ack.acknowledgedName ?? "…"}
                          {ack.createdAt && ` · ${new Date(ack.createdAt).toLocaleString("vi-VN")}`}
                        </div>
                      ) : (
                        <button
                          disabled={!workflowEnabled && draftStatus !== "in_review"}
                          className="mt-1 rounded border border-red-400 px-2 py-0.5 text-[12px] text-red-800 hover:bg-red-100 disabled:opacity-40"
                          onClick={() =>
                            startTransition(async () => {
                              const note = window.prompt(`Ghi chú khi nhìn nhận cờ "${v.title}" (tùy chọn)`, "") ?? "";
                              done(
                                await ackVetoAction(
                                  assessmentId,
                                  report.draftVersionNo ?? 1,
                                  v.code,
                                  note,
                                ),
                              );
                            })
                          }
                        >
                          Xác nhận đã thấy
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {/* Lịch sử version */}
          <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
            <h3 className="mb-2 text-sm font-semibold text-slate-700">Lịch sử version</h3>
            {report.versions.length === 0 && <p className="text-xs text-slate-500">Chưa có bản nháp nào.</p>}
            <ul className="space-y-1.5">
              {report.versions.map((v) => (
                <li key={v.versionNo} className="rounded-lg bg-slate-50 p-2 text-[12px]">
                  <div className="flex items-center justify-between">
                    <b>v{v.versionNo}</b>
                    <VersionBadge status={v.status} />
                  </div>
                  <div className="text-slate-500">
                    {v.createdName ? `${v.createdName} · ` : ""}
                    {new Date(v.createdAt).toLocaleString("vi-VN")}
                  </div>
                  {v.changeNote && <div className="mt-0.5 italic text-slate-600">“{v.changeNote}”</div>}
                  {v.approverName && <div className="text-green-700">Duyệt bởi {v.approverName}</div>}
                  {v.hasSnapshot && <div className="text-[10px] text-slate-400">đã chụp snapshot bất biến</div>}
                </li>
              ))}
            </ul>
          </div>
        </aside>

        {/* ------------------------------ CỘT PHẢI ----------------------------- */}
        <section className="space-y-4">
          {!draftVersion && report.mode === "supabase" && (
            <div className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center">
              <p className="mb-3 text-sm text-slate-600">Chưa có bản nháp nào cho hồ sơ này.</p>
              <button
                className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-800"
                disabled={busy}
                onClick={() => startTransition(async () => done(await openDraftAction(assessmentId)))}
              >
                Mở bản nháp v1
              </button>
            </div>
          )}

          {draftVersion && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
              <span className="text-sm font-semibold">Bản nháp v{draftVersion.versionNo}</span>
              <VersionBadge status={draftStatus ?? "draft"} large />
              <span className="text-xs text-slate-500">
                LLM: {report.llm.configured ? report.llm.model : `${report.llm.model} (mock — chưa cấu hình key)`}
              </span>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <Link
                  href={`/research/${assessmentId}/report?kind=exec`}
                  target="_blank"
                  className="rounded border border-slate-300 px-3 py-1.5 text-[13px] text-slate-700 hover:bg-slate-50"
                  title="Bản tóm tắt điều hành — In ra PDF khổ A4"
                >
                  🖨️ Bản in (exec)
                </Link>
                <Link
                  href={`/research/${assessmentId}/report?kind=full`}
                  target="_blank"
                  className="rounded border border-slate-300 px-3 py-1.5 text-[13px] text-slate-700 hover:bg-slate-50"
                  title="Bản đầy đủ — In ra PDF khổ A4"
                >
                  🖨️ Bản in (full)
                </Link>
                {draftStatus === "draft" && (
                  <>
                    <button
                      className="rounded border border-violet-300 bg-violet-50 px-3 py-1.5 text-[13px] text-violet-800 hover:bg-violet-100 disabled:opacity-40"
                      disabled={busy || generating}
                      onClick={() =>
                        startTransition(async () => {
                          setGenerating(true);
                          const r = await generateAllDraftsAction(assessmentId, draftVersion.versionNo);
                          setGenerating(false);
                          done(r);
                        })
                      }
                    >
                      ✨ AI soát nháp các khối trống
                    </button>
                    <button
                      className="rounded bg-blue-700 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-blue-800 disabled:opacity-40"
                      disabled={busy || requiredCheck.missing.length > 0}
                      title={requiredCheck.missing.length ? "Còn section chưa ký" : "Chụp snapshot bất biến và gửi duyệt"}
                      onClick={() => startTransition(async () => done(await submitReportAction(assessmentId)))}
                    >
                      Gửi trưởng phòng duyệt
                    </button>
                  </>
                )}
                {draftStatus === "in_review" && (
                  <>
                    <button
                      className="rounded border border-amber-400 bg-amber-50 px-3 py-1.5 text-[13px] text-amber-900 hover:bg-amber-100 disabled:opacity-40"
                      disabled={busy}
                      onClick={() =>
                        startTransition(async () => {
                          const note = window.prompt("Nội dung cần chỉnh sửa (ghi vào lịch sử version):", "") ?? "";
                          done(await requestChangesAction(assessmentId, note));
                        })
                      }
                    >
                      Yêu cầu chỉnh sửa
                    </button>
                    <button
                      className="rounded bg-green-700 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-green-800 disabled:opacity-40"
                      disabled={busy || (redVetoes.length > 0 && !redAllAcked)}
                      title={
                        redVetoes.length > 0 && !redAllAcked
                          ? "Phải xác nhận đã nhìn thấy mọi cờ veto đỏ"
                          : "Phê duyệt & chốt hồ sơ"
                      }
                      onClick={() => startTransition(async () => done(await approveReportAction(assessmentId)))}
                    >
                      Phê duyệt báo cáo
                    </button>
                  </>
                )}
                {(draftStatus === "approved" || draftStatus === "published") && (
                  <span className="text-sm font-medium text-green-700">Báo cáo đã phê duyệt — bản chốt bất biến.</span>
                )}
                {draftStatus === "changes_requested" && (
                  <span className="text-sm text-amber-800">Đã yêu cầu sửa — một bản nháp mới đang được mở.</span>
                )}
              </div>
            </div>
          )}

          {SECTION_REGISTRY.map((def) => (
            <div key={def.key} id={`sec-${def.key}`} className="scroll-mt-4">
              <SectionEditor
                assessmentId={assessmentId}
                versionNo={report.draftVersionNo ?? 1}
                sectionKey={def.key}
                row={sections[def.key]}
                metrics={metrics}
                quotes={quotes}
                workflowEnabled={workflowEnabled}
                meta={props.meta}
                onActionResult={(ok, message) => setNotice({ ok, text: message })}
              />
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}

const REQUIRED_REQUIRED = REQUIRED_SECTIONS.length;

function VersionBadge({ status, large }: { status: string; large?: boolean }) {
  const map: Record<string, string> = {
    draft: "bg-slate-100 text-slate-700",
    in_review: "bg-blue-100 text-blue-800",
    changes_requested: "bg-amber-100 text-amber-900",
    approved: "bg-green-100 text-green-800",
    published: "bg-green-200 text-green-900",
    stale: "bg-slate-200 text-slate-500",
  };
  const label: Record<string, string> = {
    draft: "Nháp",
    in_review: "Đang duyệt",
    changes_requested: "Yêu cầu sửa",
    approved: "Đã duyệt",
    published: "Đã phát hành",
    stale: "Cũ",
  };
  return (
    <span className={`rounded-full px-2 py-0.5 font-medium ${large ? "text-xs" : "text-[10px]"} ${map[status] ?? ""}`}>
      {label[status] ?? status}
    </span>
  );
}
