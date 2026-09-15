/**
 * Webhook Rainforest Collections (Module 8 G2).
 *
 * Rainforest gọi POST khi 1 collection chạy xong. Ta KHÔNG tin số trong
 * payload kết quả (nó chỉ báo hiệu); phải GET lại kết quả collection bằng
 * RainforestClient rồi parse qua hàm thuần parseProductCollectionResults.
 *
 * Xác thực bằng shared secret đặt trong URL callback
 * (?secret=RAINFOREST_WEBHOOK_SECRET) — route nằm trong bypassPaths của
 * middleware (không đòi cookie phiên). Ghi DB bằng service_role qua RPC
 * migration 0026 (không dùng phiên người dùng).
 */
import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { RainforestClient } from "@/lib/intelligence";
import {
  SupabaseResearchPort,
  applyCompetitionScoring,
  parseProductCollectionResults,
} from "@/lib/worker";

export const dynamic = "force-dynamic";

type WebhookBody = {
  collection?: { id?: string; status?: string };
  collection_id?: string;
  status?: string;
};

export async function POST(req: Request) {
  const secret = new URL(req.url).searchParams.get("secret");
  if (!process.env.RAINFOREST_WEBHOOK_SECRET || secret !== process.env.RAINFOREST_WEBHOOK_SECRET) {
    return NextResponse.json({ ok: false, error: "Sai webhook secret" }, { status: 401 });
  }

  const apiKey = process.env.RAINFOREST_API_KEY;
  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!apiKey || !sbUrl || !sbKey) {
    return NextResponse.json(
      { ok: false, error: "Thiếu RAINFOREST_API_KEY hoặc thông tin Supabase service role" },
      { status: 500 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as WebhookBody;
  const collectionId = body.collection?.id ?? body.collection_id;
  const status = body.collection?.status ?? body.status;
  if (!collectionId) {
    return NextResponse.json({ ok: false, error: "thiếu collection id" }, { status: 400 });;
  }
  if (status && !["complete", "completed", "done", "ready"].includes(String(status).toLowerCase())) {
    // Collection chưa xong (queued/running/failed partial) — không xử lý, trả 200.
    return NextResponse.json({ ok: true, skipped: true, status });
  }

  const sb = createClient(sbUrl, sbKey, { auth: { persistSession: false } });
  const { data: run, error: findErr } = await sb
    .schema("research")
    .from("collection_runs")
    .select("id, assessment_id, kind, status")
    .eq("external_id", collectionId)
    .in("status", ["running", "queued"])
    .maybeSingle();

  if (findErr) return NextResponse.json({ ok: false, error: findErr.message }, { status: 500 });
  if (!run) {
    // Không phải collection của hệ thống (hoặc đã xử lý) — nhận cho webhook ngừng retry.
    return NextResponse.json({ ok: true, matched: false });
  }

  const port = new SupabaseResearchPort(sb);
  try {
    const client = new RainforestClient({ apiKey });
    const resultJson = await client.getCollection(collectionId);
    const rows = parseProductCollectionResults(resultJson, "rainforest");

    const { rows: written } = await port.upsertCompetitors(run.id, rows);

    const credits =
      (resultJson as { collection?: { credits?: number; credits_used?: number } }).collection?.credits ??
      (resultJson as { collection?: { credits_used?: number } }).collection?.credits_used ??
      rows.length * 3;

    await port.finishRun({
      runId: run.id,
      status: rows.length ? "done" : "no_data",
      creditsUsed: Number(credits) || 0,
      externalId: collectionId,
    });

    // G3: chấm trụ cạnh tranh từ snapshot SERP + collection vừa về.
    let scoring: { scored: boolean; message: string } | null = null;
    try {
      scoring = await applyCompetitionScoring(run.assessment_id, port);
    } catch (e) {
      scoring = { scored: false, message: `chấm tập trung lỗi: ${(e as Error).message}` };
    }

    return NextResponse.json({ ok: true, rows: written, scoring });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    try {
      await sb.rpc("vexim_research_worker_finish_run", {
        p_run_id: run.id,
        p_status: "failed",
        p_credits_used: 0,
        p_external_id: collectionId,
        p_error: message.slice(0, 500),
        p_raw: null,
      });
    } catch {
      // đã ở nhánh lỗi; không che mất thông báo gốc
    }
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
