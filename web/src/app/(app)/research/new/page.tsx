/**
 * Module 8 G1 — trang máy tính what-if: /research/new
 */

import Link from "next/link";
import { PageHeader, NoAccess } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import type { PersonaKey } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";
import { ResearchCalculator } from "../ResearchCalculator";

// G1 chưa có vai trò analyst trong persona demo → tạm gắn ceo như kế hoạch.
const ALLOWED: PersonaKey[] = ["ceo"];

export default async function NewResearchPage() {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;
  const db = await createClient();
  const canSave = !!db;

  return (
    <>
      <div className="mb-2">
        <Link href="/research" className="text-[12.5px] font-bold text-soft hover:text-ink">
          ← Danh sách hồ sơ thẩm định
        </Link>
      </div>
      <PageHeader
        title="Hồ sơ thẩm định ngách mới"
        sub="Module 8 · G1 — máy tính what-if tài chính"
        desc="Nhập giả định theo kịch bản; engine chạy ngay không cần khóa API. Phí FBA US theo bảng 2026 ƯỚC LƯỢNG — con số chuẩn lấy ở SP-API Product Fees. Các trụ cạnh tranh/nhu cầu/khác biệt sẽ điền ở G2–G4."
      />
      {!canSave && (
        <div className="mb-4 rounded-[13px] border-2 border-dashed border-amber/60 bg-amber-soft px-4 py-3 text-[12.5px] text-[#8a5602]">
          <b>DEMO MODE:</b> máy tính chạy đầy đủ trên trình duyệt để duyệt quy trình,
          nhưng nút lưu không hoạt động vì chưa cấu hình Supabase. Khi triển khai thật,
          ghi dữ liệu qua RPC <code>vexim_research_create_assessment</code> (cần vai trò analyst/dept_lead).
        </div>
      )}
      <ResearchCalculator canSave={canSave} />
    </>
  );
}
