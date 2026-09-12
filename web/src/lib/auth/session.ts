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
 * - SUPABASE MODE (đã cấu hình URL + anon key): chỉ nhận user từ
 *   supabase.auth.getUser(). KHÔNG tin cookie demo_role — cookie đó có thể
 *   còn sót từ lúc thử DEMO trên production.
 * - DEMO MODE (chưa cấu hình Supabase): cookie demo_role (4 persona theo
 *   wireframe đã duyệt).
 * - Vai trò UI hiện mặc định persona ceo; TODO Tier 1: query iam.user_profiles
 *   + role_assignments.
 */
export async function getAppSession(): Promise<Session | null> {
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
    return null;
  }

  const cookieStore = await cookies();
  const demo = cookieStore.get("demo_role")?.value as PersonaKey | undefined;
  if (demo && demo in PERSONAS) {
    return { mode: "demo", persona: demo };
  }
  return null;
}

export async function requireSession(): Promise<Session> {
  const session = await getAppSession();
  if (!session) redirect("/login");
  return session;
}
