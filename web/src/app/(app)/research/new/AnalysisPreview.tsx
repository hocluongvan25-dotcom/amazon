"use client";

/**
 * Module 8 G1 — BƯỚC 2/2: trang PHÂN TÍCH riêng, chiếm trọn bề ngang.
 * Đọc nháp từ sessionStorage do trang /research/new gửi sang, chạy engine
 * thuần và trình bày kết quả; nút Lưu gọi server action → RPC (hoặc báo demo).
 */

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Chip, Panel } from "@/components/ui";
import { computeAssessment, validateAssumptions, type AssessmentResult } from "@/lib/research/domain";
import { formToAssumptions, type ResearchFormRaw } from "@/lib/data/research-model";
import { saveAssessmentAction, type SaveAssessmentState } from "../actions";
import { ResearchResultView } from "../ResearchResultView";
import { clearDraft, loadDraft } from "@/lib/research/new-form";

export function AnalysisPreview({ canSave }: { canSave: boolean }) {
  const router = useRouter();
  const [draft, setDraft] = useState<ResearchFormRaw | null>(null);
  const [missing, setMissing] = useState(false);
  const [state, setState] = useState<SaveAssessmentState | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    const d = loadDraft();
    if (!d) {
      setMissing(true);
      return;
    }
    setDraft(d);
  }, []);

  const { errors, result } = useMemo<{ errors: string[]; result: AssessmentResult | null }>(() => {
    if (!draft) return { errors: [], result: null };
    const a = formToAssumptions(draft);
    const e = validateAssumptions(a);
    return { errors: e, result: e.length ? null : computeAssessment(a) };
  }, [draft]);

  const save = () => {
    if (!draft) return;
    startTransition(async () => {
      const r = await saveAssessmentAction(draft);
      setState(r);
      if (r.ok && r.id) {
        clearDraft();
        router.push(`/research/${r.id}`);
      }
    });
  };

  if (missing) {
    return (
      <Panel title="Chưa có số liệu nháp">
        <p className="mb-3 text-[13px] text-soft">
          Trang phân tích chỉ hiển thị sau khi đã nhập giả định ở bước 1. Nháp lưu trong trình duyệt
          (sessionStorage) và sẽ mất nếu đóng tab.
        </p>
        <Link
          href="/research/new"
          className="inline-block rounded-[10px] bg-[#1f3a5f] px-4 py-2 text-[13px] font-extrabold text-white"
        >
          ← Về trang nhập liệu
        </Link>
      </Panel>
    );
  }

  if (!draft) {
    return <p className="text-[13px] text-soft">Đang tải nháp…</p>;
  }

  return (
    <>
      {errors.length > 0 ? (
        <Panel title="Giả định chưa hợp lệ">
          <ul className="mb-3 list-disc space-y-1 pl-5 text-[13px] text-[#8a5602]">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
          <Link
            href="/research/new"
            className="inline-block rounded-[10px] border border-[#1f3a5f] px-4 py-2 text-[13px] font-extrabold text-[#1f3a5f]"
          >
            ← Quay lại sửa
          </Link>
        </Panel>
      ) : result ? (
        <ResearchResultView result={result} />
      ) : null}

      <div className="sticky bottom-0 z-10 -mx-6 mt-2 border-t border-line bg-white/95 px-6 py-3 backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Link
            href="/research/new"
            className="rounded-[10px] border border-line bg-white px-4 py-2 text-[13px] font-extrabold text-soft"
          >
            ← Quay lại chỉnh sửa
          </Link>
          <div className="flex items-center gap-3">
            {state ? <Chip tone={state.ok ? "green" : "amber"}>{state.message}</Chip> : null}
            <button
              type="button"
              disabled={!!errors.length || pending || !canSave}
              onClick={save}
              title={!canSave ? "DEMO MODE: chưa nối Supabase nên không lưu được" : undefined}
              className="rounded-[10px] bg-[#1f3a5f] px-5 py-2 text-[13px] font-extrabold text-white hover:bg-[#274b78] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {pending ? "Đang lưu…" : "Lưu hồ sơ thẩm định"}
            </button>
          </div>
        </div>
        {!canSave && (
          <p className="mt-1.5 text-right text-[11.5px] font-semibold text-amber">
            DEMO MODE: phân tích đầy đủ nhưng không lưu hồ sơ.
          </p>
        )}
      </div>
    </>
  );
}
