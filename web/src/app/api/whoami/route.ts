/**
 * GET /api/whoami
 *
 * Endpoint chẩn đoán phiên đăng nhập — KHÔNG trả secret (cookie value,
 * anon key, service role). Dùng để xem production đang thấy cookie nào,
 * getUser() ra gì, và iam.my_profile có query được không.
 *
 * Middleware whitelist path này (không redirect /login) để chẩn đoán được
 * cả trường hợp CHƯA đăng nhập — nếu bị đá về /login thì không biết vì sao.
 */
import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { getAppSession } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

function supabaseHost(): string | null {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!raw) return null;
  try {
    return new URL(raw).host;
  } catch {
    return "(url không hợp lệ)";
  }
}

export async function GET() {
  const cookieStore = await cookies();
  const headerStore = await headers();
  const cookieNames = cookieStore.getAll().map((c) => c.name);
  const demoRole = cookieStore.get("demo_role")?.value ?? null;

  const supabase = await createClient();

  let authUser: { id: string; email: string | null } | null = null;
  let authError: string | null = null;
  let profile: unknown = null;
  let profileError: string | null = null;

  if (supabase) {
    const { data, error } = await supabase.auth.getUser();
    if (error) authError = error.message;
    if (data.user) {
      authUser = { id: data.user.id, email: data.user.email ?? null };
      const { data: row, error: pErr } = await supabase
        .schema("iam").from("my_profile")
        .select("id,display_name,email,role,department,vexim_employee")
        .maybeSingle();
      if (pErr) profileError = pErr.message;
      else profile = row;
    }
  }

  let appSession: Awaited<ReturnType<typeof getAppSession>> = null;
  let appSessionError: string | null = null;
  try {
    appSession = await getAppSession();
  } catch (e) {
    appSessionError = e instanceof Error ? e.message : String(e);
  }

  return NextResponse.json({
    ok: true,
    now: new Date().toISOString(),
    middleware: {
      sawRequestHeader: headerStore.get("x-vexim-middleware") === "1",
    },
    env: {
      nodeEnv: process.env.NODE_ENV ?? null,
      vercelEnv: process.env.VERCEL_ENV ?? null,
      supabaseUrlConfigured: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
      supabaseAnonKeyConfigured: !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      supabaseServiceRoleConfigured: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      supabaseHost: supabaseHost(),
    },
    cookies: {
      names: cookieNames,
      hasDemoRole: demoRole !== null,
      demoRole,
      hasSupabaseAuthCookie: cookieNames.some((n) => n.startsWith("sb-")),
    },
    auth: {
      supabaseClientCreated: supabase !== null,
      user: authUser,
      error: authError,
    },
    appSession: appSession
      ? {
          mode: appSession.mode,
          persona: appSession.persona,
          userId: appSession.userId ?? null,
          email: appSession.email ?? null,
        }
      : null,
    appSessionError,
    profile,
    profileError,
    notes: [
      "Không trả cookie value / API key.",
      "session.ts hiện hardcode persona='ceo' cho mọi user Supabase (TODO map iam.role_assignments).",
    ],
  });
}
