/**
 * Gọi RPC Supabase bằng service_role (server-only) — dùng chung cho các luồng
 * Module 0 cần quyền server (đồng bộ tên shop · thêm/xoá shop · callback OAuth).
 *
 * NGUYÊN TẮC (bài học từ sự cố 12/09/2026, xem migration 0008):
 *   • CHỈ gọi RPC trong schema `public` — path `/rest/v1/rpc/<fn>`.
 *   • KHÔNG bao giờ gọi `/rest/v1/connections.xxx` (PostgREST trả PGRST205 vì
 *     không hiểu cú pháp "schema.table").
 *   • Service role key chỉ tồn tại ở server; không trả về client.
 *
 * `fetchFn` injectable ⇒ test được toàn bộ luồng mà không cần Supabase thật.
 */

export type RpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status: number | null };

export function supabaseAdminConfig(): { url: string; key: string } | null {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) return null;
  return { url, key };
}

export async function adminRpc<T = unknown>(
  fn: string,
  body: Record<string, unknown>,
  fetchFn: typeof fetch = fetch,
): Promise<RpcResult<T>> {
  const cfg = supabaseAdminConfig();
  if (!cfg) {
    return {
      ok: false,
      error: "Chưa cấu hình NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY",
      status: null,
    };
  }
  let res: Response;
  try {
    res = await fetchFn(`${cfg.url}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: cfg.key,
        Authorization: `Bearer ${cfg.key}`,
      },
      body: JSON.stringify(body ?? {}),
      cache: "no-store",
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), status: null };
  }

  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) {
    // PostgREST bọc lỗi PL/pgSQL trong { message, code, details, hint }
    if (typeof data === "object" && data !== null) {
      const row = data as { message?: unknown; hint?: unknown; details?: unknown };
      const message = typeof row.message === "string" ? row.message : `HTTP ${res.status}`;
      const hint = typeof row.hint === "string" ? row.hint : "";
      return { ok: false, error: hint ? `${message} — ${hint}` : message, status: res.status };
    }
    return { ok: false, error: `HTTP ${res.status}: ${String(data).slice(0, 200)}`, status: res.status };
  }

  return { ok: true, data: data as T };
}

/** RPC chưa tồn tại (migration chưa chạy) — để caller nói đúng việc cần làm. */
export function isMissingRpcError(error: string, status: number | null): boolean {
  return status === 404 || /PGRST202|PGRST205|does not exist|schema cache/i.test(error);
}
