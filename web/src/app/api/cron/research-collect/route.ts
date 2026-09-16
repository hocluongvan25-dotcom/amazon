/**
 * Cron API Module 8 G2 — xử lý hàng đợi thu thập Rainforest.
 *
 *   GET /api/cron/research-collect?kinds=serp,products,reviews&max=5
 *
 * Protect bằng CRON_SECRET (Authorization: Bearer <CRON_SECRET>). Cron KHÔNG
 * ngồi chờ: mỗi lần chạy nhận tối đa `max` run (mặc định 5) để nằm trong
 * trần 60s của Vercel Hobby; hàng còn lại để lượt sau. Reviews nhiều trang
 * nên chạy bằng CLI `npm run worker:research-collect` nếu cần quét một lèo.
 *
 * Thiếu RAINFOREST_API_KEY: provider là mock (chỉ nên xảy ra ở dev — không
 * ghi DB thật vì cổng Supabase vẫn thật; nếu lo lắng, không xếp hàng khi chưa
 * có key). Thiếu SUPABASE_*: runner tự về no-op và báo mode=demo.
 */
import { NextResponse } from "next/server";
import { runResearchCollect } from "@/lib/worker";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json(
      {
        error: "CRON_SECRET chưa được cấu hình trên Vercel.",
        hint: "Project Settings → Environment Variables → thêm CRON_SECRET rồi redeploy.",
      },
      { status: 500 },
    );
  }
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "Sai hoặc thiếu Bearer CRON_SECRET." }, { status: 401 });
  }

  const url = new URL(req.url);
  // 'analyze' nằm trong danh sách mặc định: lượt phân tích LLM cũng phải được
  // cron nhặt — không thì chỉ có nút "Chạy ngay" trên web xử lý được nó.
  const kinds = (url.searchParams.get("kinds") ?? "serp,products,reviews,analyze")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  const maxParam = Number(url.searchParams.get("max"));
  const max = Number.isFinite(maxParam) && maxParam > 0 ? maxParam : 5;

  const result = await runResearchCollect({
    kinds,
    max,
    log: (line) => console.log(line),
  });
  return NextResponse.json(result);
}
