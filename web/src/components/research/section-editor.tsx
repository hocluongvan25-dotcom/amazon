"use client";

/**
 * Module 8 G5 — canvas biên soạn MỘT section báo cáo.
 * TipTap: đậm / heading3 / bullet / link + 2 node khóa cứng (metricToken,
 * quoteChip). Tự động lưu 1,5s sau gõ; khóa bi quan 2 phút; regenerate kèm
 * diff; ký/bỏ ký từng phần. Khối số liệu KHÔNG nằm trong ProseMirror.
 */

import React, { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import {
  SECTION_REGISTRY,
  diffDocs,
  docHasContent,
  docWordCount,
  emptyDoc,
  type DiffSegment,
  type MetricToken,
  type QuoteToken,
  type SectionStatus,
  type TiptapDoc,
} from "@/lib/research/domain";
import type { ReportSectionRow } from "@/lib/data/research-report";
import { MetricTokenNode, QuoteChipNode } from "./tiptap-nodes";
import {
  lockSectionAction,
  regenerateSectionAction,
  saveSectionAction,
  verifySectionAction,
} from "@/app/(app)/research/report-actions";

type SaveState = "idle" | "saving" | "saved" | "error";

/** Metadata hồ sơ cho khối bìa — KHỐI DỮ LIỆU render bằng React, không gõ tay. */
export type ReportMeta = {
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

export function SectionEditor(props: {
  assessmentId: string;
  versionNo: number;
  sectionKey: string;
  row: ReportSectionRow | undefined;
  metrics: MetricToken[];
  quotes: QuoteToken[];
  /** false khi demo / version không phải draft / thiếu quyền */
  workflowEnabled: boolean;
  /** metadata cho khối bìa (khối DỮ LIỆU, không nằm trong ProseMirror) */
  meta?: ReportMeta;
  onActionResult: (ok: boolean, message: string) => void;
}) {
  const { assessmentId, versionNo, sectionKey, row, metrics, quotes, workflowEnabled, meta } = props;
  const def = SECTION_REGISTRY.find((s) => s.key === sectionKey)!;
  const initialDoc = row?.content ?? emptyDoc();
  const status: SectionStatus | "empty" = row?.status
    ? row.status
    : docHasContent(initialDoc)
      ? "drafted"
      : "empty";
  const signed = status === "verified";
  const editable = workflowEnabled && !signed;

  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [lockedBy, setLockedBy] = useState<string | null>(row?.lockActiveOther ? row.lockOwner : null);
  const [busy, startTransition] = useTransition();
  const [regen, setRegen] = useState<{
    doc: TiptapDoc;
    diff: DiffSegment[];
    missing: string[];
    runId: string | null;
    cost: number;
    model: string;
  } | null>(null);

  const dirtyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef<TiptapDoc>(initialDoc);
  const lockedMineRef = useRef(false);

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({ heading: { levels: [3] } }),
        Link.configure({ openOnClick: false, autolink: true, HTMLAttributes: { class: "text-blue-700 underline" } }),
        MetricTokenNode,
        QuoteChipNode,
      ],
      content: initialDoc as never,
      editable,
      editorProps: {
        attributes: {
          class:
            "min-h-[220px] max-w-none rounded-b-lg border border-t-0 border-slate-300 bg-white p-4 text-[15px] leading-relaxed prose prose-sm prose-slate focus:outline-none",
        },
      },
      onFocus: () => {
        if (!workflowEnabled || lockedMineRef.current) return;
        void lockSectionAction(assessmentId, versionNo, sectionKey, false).then((r) => {
          if (r.ok && r.mine) {
            lockedMineRef.current = true;
            setLockedBy(null);
          } else if (!r.mine) {
            setLockedBy(r.lockOwner ?? "người khác");
            editor?.setEditable(false);
          }
        });
      },
      onUpdate: ({ editor: ed }) => {
        if (!editable) return;
        dirtyRef.current = true;
        setSaveState("idle");
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          void flushSave(ed.getJSON() as TiptapDoc, "human", null);
        }, 1500);
      },
    },
    // remount khi section/version đổi (parent cũng đặt key)
    [sectionKey, versionNo],
  );

  useEffect(() => {
    editor?.setEditable(editable && !lockedBy);
  }, [editor, editable, lockedBy]);

  // heartbeat giữ khóa khi đang soát
  useEffect(() => {
    if (!workflowEnabled) return;
    const hb = setInterval(() => {
      if (lockedMineRef.current) {
        void lockSectionAction(assessmentId, versionNo, sectionKey, false);
      }
    }, 60_000);
    return () => clearInterval(hb);
  }, [workflowEnabled, assessmentId, versionNo, sectionKey]);

  // nhả khóa khi rời section
  useEffect(() => {
    return () => {
      if (lockedMineRef.current) {
        void lockSectionAction(assessmentId, versionNo, sectionKey, true);
      }
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flushSave = useCallback(
    async (doc: TiptapDoc, source: "human" | "ai" | "human_regen", runId: string | null) => {
      setSaveState("saving");
      const r = await saveSectionAction(assessmentId, versionNo, sectionKey, doc, source, runId);
      if (r.ok) {
        dirtyRef.current = false;
        lastSavedRef.current = doc;
        setSaveState("saved");
        setSavedAt(new Date().toLocaleTimeString("vi-VN"));
      } else {
        setSaveState("error");
        props.onActionResult(false, r.message);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [assessmentId, versionNo, sectionKey],
  );

  const words = editor ? docWordCount(editor.getJSON() as TiptapDoc) : docWordCount(initialDoc);

  const insertChip = (kind: "metric" | "quote") => {
    if (!editor) return;
    const list = kind === "metric" ? metrics : quotes;
    const labels = list.map((m) =>
      kind === "metric"
        ? `${(m as MetricToken).key} — ${(m as MetricToken).label}: ${(m as MetricToken).value}`
        : `${(m as QuoteToken).reviewId} (ASIN ${(m as QuoteToken).asin})`,
    );
    const pick = window.prompt(
      `Dán CHÍNH XÁC mã muốn chèn:\n${labels.slice(0, 30).join("\n")}${labels.length > 30 ? "\n…" : ""}`,
      labels[0]?.split(" — ")[0] ?? "",
    );
    if (!pick) return;
    if (kind === "metric") {
      const m = metrics.find((x) => x.key === pick.trim());
      if (!m) return props.onActionResult(false, `Không có mã số "${pick}" trong danh sách được phép.`);
      editor.chain().focus().insertContent({ type: "metricToken", attrs: m }).run();
    } else {
      const q = quotes.find((x) => x.reviewId === pick.trim());
      if (!q) return props.onActionResult(false, `Không thấy review "${pick}" trong kho câu trích đã thu.`);
      editor.chain().focus().insertContent({ type: "quoteChip", attrs: q }).run();
    }
  };

  const addLink = () => {
    if (!editor) return;
    const previous = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt("URL (https://…)", previous ?? "https://");
    if (url === null) return;
    if (url === "") editor.chain().focus().unsetLink().run();
    else editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  };

  const onRegenerate = () =>
    startTransition(async () => {
      const r = await regenerateSectionAction(assessmentId, versionNo, sectionKey);
      if (!r.ok || !r.doc) return props.onActionResult(false, r.message);
      const current = (editor?.getJSON() ?? lastSavedRef.current) as TiptapDoc;
      setRegen({
        doc: r.doc,
        diff: diffDocs(current, r.doc),
        missing: r.missingTokens ?? [],
        runId: r.llmRunId ?? null,
        cost: r.costUsd ?? 0,
        model: r.message,
      });
    });

  const acceptRegen = () =>
    startTransition(async () => {
      const reg = regen;
      if (!reg || !editor) return;
      editor.commands.setContent(reg.doc);
      const r = await saveSectionAction(assessmentId, versionNo, sectionKey, reg.doc, "human_regen", reg.runId);
      if (!r.ok) return props.onActionResult(false, r.message);
      lastSavedRef.current = reg.doc;
      setRegen(null);
      props.onActionResult(true, "Đã chấp nhận nháp AI; nhớ đọc lại và ký khi chịu trách nhiệm.");
    });

  const onVerify = (verify: boolean) =>
    startTransition(async () => {
      // lưu nốt phần đang gõ dở trước khi ký
      if (verify && dirtyRef.current && editor) {
        await flushSave(editor.getJSON() as TiptapDoc, "human", null);
      }
      const r = await verifySectionAction(assessmentId, versionNo, sectionKey, verify);
      props.onActionResult(r.ok, r.message);
    });

  const tb =
    "rounded px-2 py-1 text-[13px] font-medium disabled:opacity-40 hover:bg-slate-200 data-[active=true]:bg-slate-300";

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-semibold text-slate-800">
            {def.title}
            {def.required && <span className="ml-1 text-red-600">*</span>}
          </h3>
          <p className="truncate text-xs text-slate-500">{def.brief}</p>
        </div>
        <StatusPill status={status} />
        {row?.generatedModel && (
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500" title="Nguồn nội dung">
            {row.source} · {row.generatedModel}
          </span>
        )}
        {saveState === "saving" && <span className="text-xs text-slate-500">Đang lưu…</span>}
        {saveState === "saved" && <span className="text-xs text-green-700">Đã lưu {savedAt}</span>}
        {saveState === "error" && <span className="text-xs text-red-700">Lỗi lưu — xem thông báo</span>}
        <span className="text-xs text-slate-400">{words} từ</span>
      </div>

      {!def.narrative ? (
        <CoverBlock meta={meta} />
      ) : signed ? (
        <div className="space-y-3 p-4">
          <div className="flex items-center gap-2 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800">
            ✅ Đã ký bởi <b>{row?.verifiedName ?? "…"}</b>
            {row?.verifiedAt && ` lúc ${new Date(row.verifiedAt).toLocaleString("vi-VN")}`}. Chế độ chỉ đọc.
          </div>
          <SignedPreview doc={initialDoc} />
          {workflowEnabled && (
            <button
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50"
              disabled={busy}
              onClick={() => onVerify(false)}
            >
              Bỏ ký để sửa
            </button>
          )}
        </div>
      ) : (
        <>
          {lockedBy ? (
            <div className="m-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              🔒 <b>{lockedBy}</b> đang soát section này (khóa tự nhả sau 2 phút không hoạt động).
            </div>
          ) : null}

          {def.narrative && (
            <div className="flex flex-wrap items-center gap-1 rounded-t-lg border border-b-0 border-slate-300 bg-slate-100 px-2 py-1.5">
              <button
                type="button"
                className={tb}
                disabled={!editable}
                data-active={editor?.isActive("bold") ? true : undefined}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => editor?.chain().focus().toggleBold().run()}
              >
                <b>B</b>
              </button>
              <button
                type="button"
                className={tb}
                disabled={!editable}
                data-active={editor?.isActive("heading", { level: 3 }) ? true : undefined}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}
              >
                H3
              </button>
              <button
                type="button"
                className={tb}
                disabled={!editable}
                data-active={editor?.isActive("bulletList") ? true : undefined}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => editor?.chain().focus().toggleBulletList().run()}
              >
                • Danh sách
              </button>
              <button
                type="button"
                className={tb}
                disabled={!editable}
                onMouseDown={(e) => e.preventDefault()}
                onClick={addLink}
              >
                🔗 Link
              </button>
              <span className="mx-1 h-4 w-px bg-slate-300" />
              <button type="button" className={tb} disabled={!editable} onClick={() => insertChip("metric")}>
                🔢 Chèn số
              </button>
              <button type="button" className={tb} disabled={!editable} onClick={() => insertChip("quote")}>
                💬 Chèn trích dẫn
              </button>
              <span className="ml-auto flex items-center gap-2">
                {def.narrative && workflowEnabled && (
                  <button
                    type="button"
                    className="rounded border border-violet-300 bg-violet-50 px-2 py-1 text-[13px] text-violet-800 hover:bg-violet-100 disabled:opacity-40"
                    disabled={busy}
                    onClick={onRegenerate}
                    title="Sinh lại nháp bằng LLM — bạn phải xem diff rồi mới chấp nhận"
                  >
                    ✨ Soát nháp bằng AI
                  </button>
                )}
                {workflowEnabled && (
                  <button
                    type="button"
                    className="rounded bg-green-700 px-3 py-1 text-[13px] font-medium text-white hover:bg-green-800 disabled:opacity-40"
                    disabled={busy}
                    onClick={() => onVerify(true)}
                  >
                    ✍️ Ký section này
                  </button>
                )}
              </span>
            </div>
          )}

          <EditorContent editor={editor} />
        </>
      )}

      {regen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="max-h-[85vh] w-full max-w-3xl overflow-auto rounded-xl bg-white p-5 shadow-2xl">
            <h4 className="mb-1 text-base font-semibold">Soát bản nháp AI trước khi chấp nhận</h4>
            <p className="mb-3 text-xs text-slate-500">
              {regen.model} · chi phí ≈ ${regen.cost.toFixed(5)}. Chấp nhận là bạn xác nhận đã đọc; chip số/câu
              trích do máy khóa cứng, không sửa tay được.
            </p>
            {regen.missing.length > 0 && (
              <div className="mb-3 rounded-lg border border-red-300 bg-red-50 p-2 text-sm text-red-800">
                ⚠️ LLM nhắc token KHÔNG được cấp (đã bỏ, không nuốt âm thầm):{" "}
                {regen.missing.join(", ")}
              </div>
            )}
            <div className="space-y-0.5 rounded-lg border border-slate-200 p-3 font-mono text-[13px]">
              {regen.diff.map((op, i) => (
                <div
                  key={i}
                  className={
                    op.type === "same"
                      ? "text-slate-500"
                      : op.type === "added"
                        ? "bg-green-50 text-green-800"
                        : "bg-red-50 text-red-700 line-through"
                  }
                >
                  {op.type === "same" ? "  " : op.type === "added" ? "+ " : "− "}
                  {op.text}
                </div>
              ))}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button className="rounded border px-4 py-2 text-sm hover:bg-slate-50" onClick={() => setRegen(null)}>
                Bỏ
              </button>
              <button
                className="rounded bg-violet-700 px-4 py-2 text-sm font-medium text-white hover:bg-violet-800"
                disabled={busy}
                onClick={acceptRegen}
              >
                Chấp nhận, thay nội dung
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: SectionStatus | "empty" }) {
  const map: Record<SectionStatus | "empty", { label: string; cls: string }> = {
    empty: { label: "Chưa viết", cls: "bg-slate-100 text-slate-600" },
    drafted: { label: "Nháp", cls: "bg-blue-50 text-blue-700 border border-blue-200" },
    in_review: { label: "Đang duyệt", cls: "bg-blue-100 text-blue-800" },
    verified: { label: "Đã ký", cls: "bg-green-100 text-green-800" },
  };
  const m = map[status];
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${m.cls}`}>{m.label}</span>;
}

/** Khối BÌA: dữ liệu máy sinh, render React thuần, không đưa vào ProseMirror. */
function CoverBlock({ meta }: { meta?: ReportMeta }) {
  if (!meta) {
    return <div className="p-4 text-sm text-slate-500">Không có metadata hồ sơ.</div>;
  }
  const rows: [string, string][] = [
    ["Mã hồ sơ", meta.code],
    ["Trạng thái hồ sơ", meta.status],
    ["Chuyên viên phụ trách", meta.analystName ?? "—"],
    ["Kết luận engine", meta.verdictLabel],
    ["Phiên bản engine", meta.engineVersion],
    ["Ngày tạo hồ sơ", new Date(meta.createdAt).toLocaleDateString("vi-VN")],
    ["Số liệu hiệu lực tới", meta.dataExpiresAt ? new Date(meta.dataExpiresAt).toLocaleDateString("vi-VN") : "—"],
    ["Bộ sinh nháp narrative", meta.llmLabel],
  ];
  return (
    <div className="p-6">
      <div className="rounded-xl border-2 border-slate-800 p-8">
        <div className="text-center text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
          VEXIM R&amp;D — Báo cáo thẩm định sản phẩm
        </div>
        <h2 className="mt-3 text-center text-2xl font-bold text-slate-900">{meta.title}</h2>
        <dl className="mx-auto mt-6 grid max-w-xl grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3 border-b border-dotted border-slate-300 pb-1">
              <dt className="text-slate-500">{k}</dt>
              <dd className="text-right font-medium text-slate-800">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-6 text-center text-xs text-slate-500">
          Mọi con số trong báo cáo là chip khóa cứng lấy từ engine tại ngày chụp version; câu trích dẫn khách
          hàng truy nguyên được về review gốc. Văn bản narrative do chuyên viên hiệu đính và ký từng phần.
        </p>
      </div>
    </div>
  );
}

/** Xem trước văn bản + chip cho section đã ký (ProseMirror tắt sửa). */
function SignedPreview({ doc }: { doc: TiptapDoc }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
      <ReadOnlyDoc doc={doc} />
    </div>
  );
}

function ReadOnlyDoc({ doc }: { doc: TiptapDoc }) {
  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({ heading: { levels: [3] } }),
        Link,
        MetricTokenNode,
        QuoteChipNode,
      ],
      content: doc as never,
      editable: false,
      editorProps: { attributes: { class: "prose prose-sm max-w-none focus:outline-none" } },
    },
    [doc],
  );
  useEffect(() => () => editor?.destroy(), [editor]);
  return <EditorContent editor={editor} />;
}
