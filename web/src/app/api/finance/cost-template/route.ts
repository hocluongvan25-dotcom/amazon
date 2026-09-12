/**
 * GET /api/finance/cost-template
 *
 * Tải file template CSV để nhập giá vốn hàng loạt (Đợt A — gỡ chặn F3/F4/P1).
 *
 * Nội dung đến từ `COST_TEMPLATE_CSV` (một nguồn duy nhất): các dòng bắt đầu bằng
 * `#` là hướng dẫn — parser bỏ qua, còn người mở bằng Excel/Numbers thì đọc được
 * ngay trên đầu file. Middleware đã đòi phiên đăng nhập; ở đây kiểm tra lại để
 * không trả file cho request không phiên (401 rõ ràng, không redirect HTML).
 */
import { NextResponse } from "next/server";

import { getAppSession } from "@/lib/auth/session";
import { costTemplateFilename, COST_TEMPLATE_CSV } from "@/lib/data/cost-model";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getAppSession();
  if (!session) {
    return NextResponse.json({ error: "Chưa đăng nhập" }, { status: 401 });
  }

  // BOM để Excel nhận UTF-8 (dòng ghi chú có dấu tiếng Việt)
  const body = `\uFEFF${COST_TEMPLATE_CSV}\n`;

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${costTemplateFilename()}"`,
      "Cache-Control": "no-store",
    },
  });
}
