/**
 * Module 8 G1 — BƯỚC 1/2: trang nhập giả định what-if: /research/new
 * Kết quả phân tích ở trang riêng /research/new/phan-tich.
 */

import Link from "next/link";
import { PageHeader, NoAccess } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import type { PersonaKey } from "@/lib/roles";
import { NewResearchForm } from "./NewResearchForm";

// G1 chưa có vai trò analyst trong persona demo → tạm gắn ceo như kế hoạch.
const ALLOWED: PersonaKey[] = ["ceo"];

export default async function NewResearchPage() {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;

  return (
    <>
      <div className="mb-2">
        <Link href="/research" className="text-[12.5px] font-bold text-soft transition hover:text-ink active:opacity-60">
          ← Danh sách hồ sơ thẩm định
        </Link>
      </div>
      <PageHeader
        title="Hồ sơ thẩm định ngách mới"
        sub="Bước 1/2 · Nhập giả định"
        desc="Điền giả định theo 4 mục (ngách, giá & chi phí, đóng gói & rủi ro, velocity). Sang bước 2 để xem phân tích what-if; engine chạy ngay trên trình duyệt, chưa tốn credit Rainforest. Phí FBA US theo bảng 2026 ƯỚC LƯỢNG — con số chuẩn lấy ở SP-API Product Fees."
      />
      <NewResearchForm />
    </>
  );
}
