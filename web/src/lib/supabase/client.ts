"use client";

import { createBrowserClient } from "@supabase/ssr";

/**
 * Supabase client cho trình duyệt (browser).
 * Trả về null khi chưa cấu hình (DEMO MODE) — caller phải kiểm tra.
 */
export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  return createBrowserClient(url, anonKey);
}
