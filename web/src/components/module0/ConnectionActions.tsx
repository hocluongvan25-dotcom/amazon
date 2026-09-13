"use client";

/**
 * ConnectionActions — phần tương tác của /module0/connect (Module 0).
 *
 * Hai việc mà server component không làm được:
 *  1. `CopyField`: copy link authorize có chữ ký để GỬI CHỦ SHOP. Chủ shop không có
 *     tài khoản VEXIM nên không thể tự vào trang này — người vận hành copy link,
 *     gửi qua kênh bảo mật, chủ shop bấm → Amazon → callback ghi token vào ĐÚNG shop
 *     đó (chữ ký phủ service+shop nên không tráo đích được).
 *  2. `ImportTokenForm`: nạp refresh token có sẵn (VEXIM đang giữ
 *     AMAZON_ADS_REFRESH_TOKEN) vào shop, khỏi cần đi qua màn hình consent.
 *
 * Không component nào nhận token từ server: form chỉ GỬI lên, và kết quả trả về
 * không chứa secret.
 */
import { useState, type FormEvent } from "react";

import type { OAuthService } from "@/lib/oauth/state.ts";

/* ------------------------------------------------------------------ */
/* Copy link                                                          */
/* ------------------------------------------------------------------ */
export function CopyField({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // clipboard bị chặn (http không bảo mật / quyền trình duyệt) → chọn text để copy tay
      const el = document.getElementById(`cf-${value.length}-${value.slice(-6)}`) as HTMLInputElement | null;
      el?.focus();
      el?.select();
      setCopied(false);
    }
  }

  return (
    <span className="flex items-center gap-1.5">
      <input
        id={`cf-${value.length}-${value.slice(-6)}`}
        readOnly
        value={value}
        aria-label={label ?? "Link authorize"}
        className="w-full min-w-[180px] rounded-md border border-line bg-[#f7f9fc] px-2 py-1 font-mono text-[11px] text-muted"
        onFocus={(e) => e.currentTarget.select()}
      />
      <button
        type="button"
        onClick={copy}
        className="shrink-0 rounded-md border border-line bg-white px-2 py-1 text-[11px] font-extrabold text-accent-ink hover:bg-[#f2f6ff]"
      >
        {copied ? "Đã copy" : "Copy"}
      </button>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Nạp refresh token có sẵn                                           */
/* ------------------------------------------------------------------ */
type Result =
  | { kind: "ok"; text: string; detail?: string }
  | { kind: "err"; text: string; detail?: string }
  | null;

export function ImportTokenForm({
  shops,
  services,
  envToken,
}: {
  shops: { id: string; name: string }[];
  services: OAuthService[];
  envToken: Record<string, boolean>;
}) {
  const [service, setService] = useState<OAuthService>(services[0] ?? "ads");
  const [shop, setShop] = useState(shops[0]?.id ?? "");
  const [source, setSource] = useState<"env" | "manual">(envToken[services[0] ?? "ads"] ? "env" : "manual");
  const [token, setToken] = useState("");
  // Profile Ads (Amazon-Advertising-API-Scope). Chỉ CẦN khi một shop có nhiều tài
  // khoản Ads / nhiều thị trường mà cron không tự chốt được — để trống thì hệ
  // thống tự chọn theo marketplaceStringId của shop.
  const [adsProfileId, setAdsProfileId] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>(null);

  function pickService(next: OAuthService) {
    setService(next);
    setSource(envToken[next] ? "env" : "manual");
    setResult(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!shop) {
      setResult({ kind: "err", text: "Chưa chọn shop." });
      return;
    }
    if (source === "manual" && token.trim().startsWith("Atza|")) {
      setResult({
        kind: "err",
        text: "Đây là ACCESS token (Atza|…) — chỉ sống 1 giờ nên vô dụng cho cron.",
        detail: "Cần REFRESH token, thường bắt đầu bằng Atzr|…",
      });
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/amazon/oauth/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          service,
          shop,
          source,
          ...(source === "manual" ? { refreshToken: token.trim() } : {}),
          // lưu vào connections.oauth_tokens.ads_account_id — sync.ts dùng để ÉP profileId
          ...(service === "ads" && adsProfileId.trim() ? { adsAccountId: adsProfileId.trim() } : {}),
        }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      if (!res.ok || body.ok !== true) {
        setResult({
          kind: "err",
          text: String(body.error ?? `Lỗi ${res.status}`),
          detail: body.hint ? String(body.hint) : undefined,
        });
        return;
      }
      const days = body.daysToReauth === null || body.daysToReauth === undefined ? "?" : String(body.daysToReauth);
      setResult({
        kind: "ok",
        text: `Đã lưu token ${service === "ads" ? "Ads API" : "SP-API"} cho shop đã chọn (đã mã hoá AES-256-GCM).`,
        detail: `Hạn re-authorize: ${String(body.reauthorizeAt ?? "?").slice(0, 10)} · còn ${days} ngày. Hệ thống tự nhắc trước 30 ngày.`,
      });
      if (source === "manual") setToken("");
    } catch (err) {
      setResult({
        kind: "err",
        text: "Không gọi được /api/amazon/oauth/import.",
        detail: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  if (shops.length === 0) {
    return (
      <p className="text-[13px] text-muted">
        Chưa có shop nào trong <code>connections.seller_accounts</code> mà bạn được quyền thấy — không có đích để
        nạp token.
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-[11.5px] font-bold uppercase tracking-wide text-soft">
          Dịch vụ
          <select
            value={service}
            onChange={(e) => pickService(e.target.value as OAuthService)}
            className="rounded-md border border-line bg-white px-2 py-1.5 text-[13px] font-semibold text-ink normal-case tracking-normal"
          >
            {services.map((s) => (
              <option key={s} value={s}>
                {s === "ads" ? "Ads API (PPC)" : "SP-API (đơn · kho · phí)"}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-[11.5px] font-bold uppercase tracking-wide text-soft">
          Shop
          <select
            value={shop}
            onChange={(e) => setShop(e.target.value)}
            className="rounded-md border border-line bg-white px-2 py-1.5 text-[13px] font-semibold text-ink normal-case tracking-normal"
          >
            {shops.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-[11.5px] font-bold uppercase tracking-wide text-soft">
          Nguồn token
          <select
            value={source}
            onChange={(e) => setSource(e.target.value as "env" | "manual")}
            disabled={!envToken[service]}
            className="rounded-md border border-line bg-white px-2 py-1.5 text-[13px] font-semibold text-ink normal-case tracking-normal disabled:bg-[#f2f4f8] disabled:text-muted"
          >
            <option value="env" disabled={!envToken[service]}>
              {envToken[service]
                ? `Biến môi trường (${service === "ads" ? "AMAZON_ADS_REFRESH_TOKEN" : "AMAZON_LWA_REFRESH_TOKEN"})`
                : "Biến môi trường — chưa đặt"}
            </option>
            <option value="manual">Dán token</option>
          </select>
        </label>
      </div>

      {source === "manual" ? (
        <label className="flex flex-col gap-1 text-[11.5px] font-bold uppercase tracking-wide text-soft">
          Refresh token (Atzr|…)
          <textarea
            value={token}
            onChange={(e) => setToken(e.target.value)}
            rows={2}
            spellCheck={false}
            autoComplete="off"
            placeholder="Atzr|IwEBI… — chỉ dán khi nhận qua kênh bảo mật"
            className="w-full rounded-md border border-line bg-white px-2 py-1.5 font-mono text-[12px] normal-case tracking-normal text-ink"
          />
        </label>
      ) : (
        <p className="text-[12.5px] text-muted">
          Token đọc thẳng từ biến môi trường trên server — không đi qua trình duyệt, không hiện ra màn hình.
        </p>
      )}

      {service === "ads" ? (
        <label className="flex flex-col gap-1 text-[11.5px] font-bold uppercase tracking-wide text-soft">
          Profile ID Ads (không bắt buộc)
          <input
            value={adsProfileId}
            onChange={(e) => setAdsProfileId(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            inputMode="numeric"
            placeholder="vd 1234567890 — để trống thì hệ thống tự chọn theo marketplace của shop"
            className="w-full rounded-md border border-line bg-white px-2 py-1.5 font-mono text-[12px] normal-case tracking-normal text-ink"
          />
          <span className="text-[11.5px] font-medium normal-case tracking-normal text-soft">
            Chỉ điền khi shop có NHIỀU tài khoản Ads (nhiều thị trường) và trang Quảng cáo báo “không chốt được
            profileId”. Đây là giá trị header <code>Amazon-Advertising-API-Scope</code>, lấy từ{" "}
            <code>GET /v2/profiles</code> — điền sai thì cron sẽ dừng và báo, không ghi nhầm số liệu.
          </span>
        </label>
      ) : null}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={busy || (source === "manual" && token.trim().length < 20)}
          className="rounded-md bg-accent-ink px-3 py-1.5 text-[13px] font-extrabold text-white disabled:opacity-50"
        >
          {busy ? "Đang lưu…" : "Lưu token vào DB (đã mã hoá)"}
        </button>
        <span className="text-[11.5px] text-soft">
          Ghi đè token cũ của cùng (shop · dịch vụ) — mỗi cặp chỉ có MỘT dòng.
        </span>
      </div>

      {result ? (
        <div
          className={`rounded-md border px-3 py-2 text-[12.5px] ${
            result.kind === "ok"
              ? "border-[#bfe6d3] bg-[#f2fbf7] text-[#0b7a55]"
              : "border-[#f2c9c9] bg-[#fdf4f4] text-[#a01717]"
          }`}
        >
          <div className="font-extrabold">{result.text}</div>
          {result.detail ? <div className="mt-0.5 font-medium">{result.detail}</div> : null}
        </div>
      ) : null}
    </form>
  );
}
