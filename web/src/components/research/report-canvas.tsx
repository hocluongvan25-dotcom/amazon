"use client";

/**
 * Module 8 G5 — wrapper tắt SSR cho ReportWorkspace (TipTap/ProseMirror cần
 * DOM khi khởi tạo editor).
 */

import dynamic from "next/dynamic";

const Workspace = dynamic(() => import("./report-workspace").then((m) => m.ReportWorkspace), {
  ssr: false,
  loading: () => (
    <div className="rounded-xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
      Đang nạp trình soạn báo cáo…
    </div>
  ),
});

import type { ReportWorkspaceProps } from "./report-workspace";

export function ReportCanvas(props: ReportWorkspaceProps) {
  return <Workspace {...props} />;
}
