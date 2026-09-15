/**
 * Module 8 G1 — BƯỚC 2/2: trang PHÂN TÍCH what-if riêng:
 * /research/new/phan-tich. Nháp do trang bước 1 gửi qua sessionStorage.
 */

import Link from "next/link";
import { PageHeader, NoAccess } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import type { PersonaKey } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";
import { AnalysisPreview } from "../AnalysisPreview";

const ALLOWED: PersonaKey[] = ["ceo"];

export default async function ResearchAnalysisPage() {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;
  const db = await createClient();
  const canSave = !!db;

  return (
    <>
      <div className="mb-2">
        <Link href="/research/new" className="text-[12.5px] font-bold text-soft hover:text-ink">
          ← Quay lại trang nhập liệu
        </Link>
      </div>
      <PageHeader
        title="Kết quả phân tích what-if"
        sub="Bước 2/2 · Tài chính G1"
        desc="Engine tính ngay từ giả định ở bước 1 (P&L 3 kịch bản, 5 trụ điểm, veto đỏ, lộ trình test). Duyệt xong bấm Lưu để tạo hồ sơ; các trụ cạnh tranh/nhu cầu/khác biệt sẽ điền ở G2–G4."
      />
      {!canSave && (
        <div className="mb-4 rounded-[13px] border-2 border-dashed border-amber/60 bg-amber-soft px-4 py-3 text-[12.5px] text-[#8a5602]">
          <b>DEMO MODE:</b> kết quả phân tích hiển thị đầy đủ để duyệt quy trình,
          nhưng nút lưu không hoạt động vì chưa cấu hình Supabase. Khi triển khai thật,
          ghi dữ liệu qua RPC <code>vexim_research_create_assessment</code> (cần vai trò analyst/dept_lead).
        </div>
      )}
      <AnalysisPreview canSave={canSave} />
    </>
  );
}
