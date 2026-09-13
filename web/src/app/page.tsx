import { redirect } from "next/navigation";
import { getAppSession } from "@/lib/auth/session";
import ViLanding from "@/components/landing/ViLanding";

export default async function Home() {
  const session = await getAppSession();
  // Nếu đã đăng nhập (supabase hoặc demo) → vào dashboard như cũ
  if (session) {
    redirect("/dashboard");
  }
  // Chưa đăng nhập → hiển thị landing tiếng Việt gắn trong hệ thống
  return <ViLanding />;
}
