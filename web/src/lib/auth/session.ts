import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { PERSONAS, type PersonaKey } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";

export type Session = {
  mode: "demo" | "supabase";
  persona: PersonaKey;
  userId?: string;
  email?: string;
};

/**
 * Lấy phiên hiện tại:
 * - DEMO MODE: cookie demo_role (4 persona theo wireframe đã duyệt)
 * - SUPABASE MODE: Supabase Auth user → map vai trò từ iam (hiện mặc định
 *   persona ceo; TODO Tier 1: query iam.user_profiles + role_assignments)
 */
export async function getAppSession(): Promise<Session | null> {
  const cookieStore = await cookies();
  const demo = cookieStore.get("demo_role")?.value as PersonaKey | undefined;
  if (demo && demo in PERSONAS) {
    return { mode: "demo", persona: demo };
  }

  const supabase = await createClient();
  if (supabase) {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      // TODO Tier 1: đọc vai trò thật từ iam.role_assignments theo user.id
      return {
        mode: "supabase",
        persona: "ceo",
        userId: user.id,
        email: user.email ?? undefined,
      };
    }
  }
  return null;
}

export async function requireSession(): Promise<Session> {
  const session = await getAppSession();
  if (!session) redirect("/login");
  return session;
}
