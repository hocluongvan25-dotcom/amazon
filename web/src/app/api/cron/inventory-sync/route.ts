/**
 * Cron API — được gọi bởi Vercel Cron mỗi 30 phút để đồng bộ tồn kho.
 * Protect bằng CRON_SECRET (header Authorization: Bearer <CRON_SECRET>).
 *
 * Ở DEMO MODE (không SP-API/DB credentials) endpoint vẫn trả 200 và chạy
 * với dữ liệu demo — không làm lỗi build preview trên Vercel.
 */
import { NextResponse } from "next/server";
import { runInventorySyncAll } from "@/lib/worker";
import { getSpApiConfig } from "@/lib/spapi/client";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function isAuthorized(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return process.env.NODE_ENV !== "production";
  const auth = req.headers.get("authorization");
  return auth === `Bearer ${expected}`;
}

async function run() {
  const buf: string[] = [];
  const res = await runInventorySyncAll({
    stdout: {
      write: (s: string) => {
        buf.push(s);
        return true;
      },
    },
  });
  return { res, log: buf.join("") };
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const { res, log } = await run();
    return NextResponse.json({
      ok: true,
      mode: res.mode,
      shopsProcessed: res.shopsProcessed,
      totalSkus: res.totalSkus,
      totalAlerts: res.totalAlerts,
      errors: res.errors,
      log,
      spapiConfigured: !!getSpApiConfig(),
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 },
    );
  }
}

export const POST = GET;
