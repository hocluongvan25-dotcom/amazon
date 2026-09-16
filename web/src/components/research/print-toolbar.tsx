"use client";

/** Thanh công cụ trang in: chọn template exec/full và mở hộp thoại In/PDF. */
import Link from "next/link";

export function PrintToolbar(props: {
  assessmentId: string;
  kind: "exec" | "full";
  isDraft: boolean;
  versionNo: number;
}) {
  const { assessmentId, kind, isDraft, versionNo } = props;
  const cls = (k: string) => (k === kind ? "pr-tb-active" : "");
  return (
    <div className="pr-toolbar">
      <Link href={`/research/${assessmentId}/editor`}>← Về Report Canvas</Link>
      <span style={{ opacity: 0.5 }}>|</span>
      <Link href={`/research/${assessmentId}/report?kind=exec`} className={cls("exec")}>
        Bản tóm tắt điều hành
      </Link>
      <Link href={`/research/${assessmentId}/report?kind=full`} className={cls("full")}>
        Bản đầy đủ
      </Link>
      <span className="pr-tb-note">
        v{versionNo}
        {isDraft ? " · NHÁP — chưa duyệt" : " · bản đã duyệt"}
      </span>
      <button
        type="button"
        className="pr-primary"
        style={{ marginLeft: "auto" }}
        onClick={() => window.print()}
      >
        🖨️ In / Lưu PDF
      </button>
      <span className="pr-tb-note">Khổ A4 · chọn “Save as PDF” · bật “Background graphics” để thấy chip màu &amp; watermark</span>
    </div>
  );
}
