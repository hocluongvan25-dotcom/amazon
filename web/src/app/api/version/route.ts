/**
 * GET /api/version — verify deployment đang chạy code nào.
 *
 * Nằm trong BYPASS_AUTH_PATHS nên gọi được KHÔNG cần cookie:
 *   curl https://veximops.com/api/version
 *
 * FIX 09/2026: trước đây hardcode commit "ee1fcc1" + copy tay bypassPaths
 * → deploy mới vẫn báo commit cũ, không verify được gì. Nay:
 *   - commit đọc từ VERCEL_GIT_COMMIT_SHA (Vercel inject lúc build)
 *   - bypassPaths import trực tiếp từ cùng module middleware dùng
 *     → response luôn phản ánh đúng code đang chạy.
 */
import { NextResponse } from "next/server";

import { BYPASS_AUTH_PATHS, PUBLIC_PATHS } from "@/lib/config/auth-paths";

export const dynamic = "force-dynamic";

export async function GET() {
  const sha = (process.env.VERCEL_GIT_COMMIT_SHA ?? "").trim();
  return NextResponse.json({
    commit: sha ? sha.slice(0, 7) : "(local/unknown — VERCEL_GIT_COMMIT_SHA not set)",
    commitFull: sha || null,
    branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
    vercelEnv: process.env.VERCEL_ENV ?? null,
    productionUrl: process.env.VERCEL_PROJECT_PRODUCTION_URL ?? null,
    expectedProductionDomain: "veximops.com",
    hasOauthBypass: BYPASS_AUTH_PATHS.some((p) => p === "/api/oauth"),
    bypassPaths: BYPASS_AUTH_PATHS,
    publicPaths: PUBLIC_PATHS,
    redirectUriEnv: (process.env.AMAZON_SP_API_REDIRECT_URI ?? "").trim() || "(not set)",
    timestamp: new Date().toISOString(),
  });
}
