import type { Metadata } from "next";
import { Suspense } from "react";
import ConfirmClient from "./ConfirmClient";

export const metadata: Metadata = {
  title: "Xác thực email — VEXIM Ops",
  description: "Xác thực token từ email Supabase.",
};

export default function ConfirmPage() {
  return (
    <Suspense fallback={
      <div className="flex min-h-screen items-center justify-center bg-bg px-4">
        <div className="rounded-2xl border border-line bg-card p-7 shadow-sm">
          <p className="text-[13px] text-muted">Đang tải trang xác thực…</p>
        </div>
      </div>
    }>
      <ConfirmClient />
    </Suspense>
  );
}
