/**
 * Job — ÁP DỤNG thay đổi đã duyệt lên Amazon Ads (Module 5 phần 3).
 *
 * Đây là CHỖ DUY NHẤT trong hệ thống được phép cầm quyền ghi lên tài khoản quảng
 * cáo của VEXIM. Vì vậy mọi luật dưới đây đều là luật cứng, không phải "có thì tốt":
 *
 *   1. CHỈ GHI CÁI ĐÃ ĐƯỢC NGƯỜI DUYỆT. Job không tự nghĩ ra giá trị, không tự
 *      đoán ngưỡng: nó `claim` những dòng `approved` mà DB (0021) đã chốt. Ngưỡng
 *      >30%/ngày phải qua trưởng phòng PPC TRƯỚC đó (SOP-05 bước 4) — nếu job
 *      thấy một dòng vượt ngưỡng còn `pending_approval` thì đó là việc của UI,
 *      không phải việc của job.
 *   2. AMAZON PHẢI XÁC NHẬN. HTTP 200 kèm `[{code:"INVALID_ARGUMENT"}]` là
 *      THẤT BẠI. Chỉ khi mọi phần tử trả về SUCCESS mới ghi `applied` — ghi
 *      "thành công" khi Amazon từ chối là cách nhanh nhất để mất niềm tin vào log.
 *   3. THẤT BẠI THÌ KHÔNG GHI CỤC BỘ. `record(false)` giữ nguyên giá trị cũ trong
 *      `ads.campaigns/targets` (nếu không, A1/A2 hiển thị số chưa từng tồn tại).
 *   4. 429/5xx = CHUYỆN TẠM THỜI ⇒ `release` (applying → approved) để lần chạy sau
 *      thử tiếp; quá `maxAttempts` mới đánh dấu thất bại để người xem xử lý.
 *   5. TOKEN HẾT HẠN = RE-AUTHORIZE, KHÔNG PHẢI LỖI TẠM (Module 0 · SOP-11):
 *      dừng cả shop ngay lần lỗi đầu, đánh dấu `needsReauth` — thử lại 5 lần chỉ
 *      làm chậm cron và đốt hạn mức.
 *
 * KHÔNG có đường tắt nào khác gọi Ads API ở chiều ghi: giữ đúng một cửa để audit
 * (`iam.audit_logs`) luôn có dấu vết "ai · khi nào · trước/sau · Amazon trả gì".
 */
import type { AdsChangeRow, DbAdapter } from "../db/adapter.ts";
import { AdsApiRequestError, type AdsClient, type AdsWriteOutcome } from "../amazon/ads.ts";

export type AdsApplyShop = {
  id: string;
  displayName: string;
};

export type AdsApplyChangeOutcome = {
  changeId: string;
  label: string;
  action: string;
  outcome: "applied" | "failed" | "released" | "skipped";
  message: string;
  keywordId: string | null;
};

export type AdsApplyShopResult = {
  shopId: string;
  shopName: string;
  action: "applied" | "idle" | "skipped" | "failed";
  claimed: number;
  applied: number;
  failed: number;
  released: number;
  needsReauth: boolean;
  message: string;
  changes: AdsApplyChangeOutcome[];
  errors: string[];
};

export type AdsApplyResult = {
  shopsProcessed: number;
  claimed: number;
  applied: number;
  failed: number;
  released: number;
  needsReauth: string[];
  results: AdsApplyShopResult[];
  errors: { shopId: string; changeId: string; error: string }[];
};

export type AdsApplyOptions = {
  db: DbAdapter;
  shops: AdsApplyShop[];
  /** null = chưa cấu hình credential Ads → job báo `skipped` kèm hướng dẫn */
  clientFor?: (shop: AdsApplyShop) => AdsClient | null;
  limit?: number;
  /** true = KHÔNG claim, KHÔNG gọi Amazon (chỉ xem sẽ làm gì) */
  dryRun?: boolean;
  /** số lần thử tối đa trước khi đánh dấu thất bại (mặc định 5) */
  maxAttempts?: number;
  log?: (s: string) => void;
  now?: Date;
};

const DEFAULT_MAX_ATTEMPTS = 5;

function firstFailure(outcome: AdsWriteOutcome): string {
  const bad = outcome.items.filter((i) => !i.ok);
  if (outcome.items.length === 0) {
    return "Amazon trả HTTP 200 nhưng KHÔNG có phần tử kết quả nào ⇒ không có bằng chứng đã ghi.";
  }
  return bad
    .slice(0, 3)
    .map((i) => `${i.code}${i.description ? `: ${i.description}` : ""}`)
    .join(" · ");
}

/** Số tiền/bid gửi Amazon — sai kiểu thì DỪNG, không gửi `NaN` lên tài khoản thật. */
function positiveNumber(change: AdsChangeRow): number | null {
  const raw = change.afterValue?.value;
  const n = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Gọi đúng endpoint v3 cho một yêu cầu. Tách riêng để test khoá được từng nhánh
 * (đổi sai endpoint ở đây là sai ngân sách thật).
 */
async function applyOne(client: AdsClient, change: AdsChangeRow): Promise<AdsWriteOutcome> {
  const profileId = change.adsProfileId;

  if (change.action === "set_budget") {
    const budget = positiveNumber(change);
    if (budget === null) throw new Error(`ngân sách mới không hợp lệ (${change.afterValue?.value})`);
    return client.updateCampaigns(profileId, [{ campaignId: change.entityKey, budget }]);
  }

  if (change.action === "set_bid") {
    const bid = positiveNumber(change);
    if (bid === null) throw new Error(`bid mới không hợp lệ (${change.afterValue?.value})`);
    return client.updateKeywords(profileId, [{ keywordId: change.entityKey, bid }]);
  }

  if (change.action === "set_state") {
    const state = String(change.afterValue?.value ?? "").toUpperCase();
    if (state !== "ENABLED" && state !== "PAUSED") {
      throw new Error(`trạng thái mới không hợp lệ (${change.afterValue?.value})`);
    }
    return change.entityType === "campaign"
      ? client.updateCampaigns(profileId, [{ campaignId: change.entityKey, state }])
      : client.updateKeywords(profileId, [{ keywordId: change.entityKey, state }]);
  }

  if (change.action === "add_negative_exact" || change.action === "add_negative_phrase") {
    const keywordText = String(change.afterValue?.value ?? "").trim();
    if (keywordText === "") throw new Error("negative keyword rỗng");
    return client.createNegativeKeywords(profileId, [
      {
        campaignId: change.campaignId,
        adGroupId: change.adGroupId || null,
        keywordText,
        matchType: change.action === "add_negative_phrase" ? "NEGATIVE_PHRASE" : "NEGATIVE_EXACT",
      },
    ]);
  }

  throw new Error(`hành động không hỗ trợ: ${change.action}`);
}

export async function runAdsApply(opts: AdsApplyOptions): Promise<AdsApplyResult> {
  const log = opts.log ?? (() => {});
  const dryRun = opts.dryRun === true;
  const limit = opts.limit ?? 20;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  const results: AdsApplyShopResult[] = [];
  const errors: AdsApplyResult["errors"] = [];
  let claimed = 0;
  let applied = 0;
  let failed = 0;
  let released = 0;

  for (const shop of opts.shops) {
    const out: AdsApplyShopResult = {
      shopId: shop.id,
      shopName: shop.displayName,
      action: "idle",
      claimed: 0,
      applied: 0,
      failed: 0,
      released: 0,
      needsReauth: false,
      message: "",
      changes: [],
      errors: [],
    };

    const client = opts.clientFor?.(shop) ?? null;
    if (!client) {
      out.action = "skipped";
      out.message =
        "chưa cấu hình credential Amazon Ads (AMAZON_ADS_CLIENT_ID / _SECRET / _REFRESH_TOKEN) " +
        "nên KHÔNG gửi thay đổi nào lên Amazon. Không phải lỗi dữ liệu.";
      results.push(out);
      log(`[ads-apply] ··· ${shop.displayName}: ${out.message}\n`);
      continue;
    }

    if (dryRun) {
      out.action = "skipped";
      out.message = "DRY-RUN: không claim, không gọi Amazon (không ghi gì).";
      results.push(out);
      log(`[ads-apply] ${shop.displayName}: ${out.message}\n`);
      continue;
    }

    let queue: AdsChangeRow[] = [];
    try {
      queue = await opts.db.claimAdsChanges(shop.id, limit);
    } catch (e) {
      const msg = (e as Error).message.split("\n")[0];
      out.action = "failed";
      out.errors.push(msg);
      errors.push({ shopId: shop.id, changeId: "", error: msg });
      results.push(out);
      continue;
    }

    out.claimed = queue.length;
    claimed += queue.length;

    if (queue.length === 0) {
      out.message = "không có yêu cầu nào đang chờ ghi.";
      results.push(out);
      continue;
    }

    for (const change of queue) {
      const label = change.entityLabel || change.entityKey;
      const base = { changeId: change.changeId, label, action: change.action, keywordId: null };

      // Thiếu ads_profile_id ⇒ KHÔNG đoán profile (ghi sai marketplace là sai tiền).
      if (!change.adsProfileId) {
        const msg = "yêu cầu không có ads_profile_id — chạy `worker:ads-sync` cho shop này trước.";
        out.changes.push({ ...base, outcome: "failed", message: msg });
        out.failed++;
        failed++;
        await opts.db
          .recordAdsChange({ changeId: change.changeId, ok: false, error: msg })
          .catch((e) => out.errors.push((e as Error).message.split("\n")[0]));
        log(`[ads-apply] ✗ ${label}: ${msg}\n`);
        continue;
      }

      try {
        const outcome = await applyOne(client, change);

        if (outcome.ok) {
          const keywordId = outcome.items.find((i) => i.id)?.id ?? null;
          const rec = await opts.db.recordAdsChange({
            changeId: change.changeId,
            ok: true,
            api: {
              ok: true,
              codes: outcome.items.map((i) => i.code),
              keywordId,
            },
          });
          out.changes.push({
            ...base,
            outcome: "applied",
            keywordId: rec.keywordId ?? keywordId,
            message: rec.mirrored ? "Amazon đã nhận · cập nhật cục bộ + audit log." : "Amazon đã nhận.",
          });
          out.applied++;
          applied++;
          log(`[ads-apply] ✓ ${label}: ${change.action} → Amazon nhận.\n`);
          continue;
        }

        const msg = `Amazon TỪ CHỐI: ${firstFailure(outcome)}`;
        await opts.db.recordAdsChange({
          changeId: change.changeId,
          ok: false,
          api: { ok: false, items: outcome.items },
          error: msg,
        });
        out.changes.push({ ...base, outcome: "failed", message: msg });
        out.failed++;
        failed++;
        errors.push({ shopId: shop.id, changeId: change.changeId, error: msg });
        log(`[ads-apply] ✗ ${label}: ${msg}\n`);
      } catch (e) {
        const err = e as AdsApiRequestError;
        const msg = err.message.split("\n")[0];

        if (err instanceof AdsApiRequestError && err.isAuthError) {
          // Token hỏng KHÔNG phải lỗi của yêu cầu ⇒ TRẢ LẠI hàng đợi (kể cả những
          // dòng đã claim trong lượt này), để sau khi authorize lại ở Module 0
          // chúng tự chạy tiếp — người dùng KHÔNG phải duyệt lại từ đầu.
          const hint =
            "Token Amazon Ads hết hạn/không đủ quyền ⇒ vào Module 0 · Kết nối shop để authorize lại " +
            "(SOP-11). Các yêu cầu vẫn nằm trong hàng đợi, không mất.";
          const remaining = queue.slice(queue.indexOf(change));
          for (const r of remaining) {
            await opts.db
              .releaseAdsChange(r.changeId, `${hint} (${msg})`)
              .catch((e2) => out.errors.push((e2 as Error).message.split("\n")[0]));
            out.changes.push({
              changeId: r.changeId,
              label: r.entityLabel || r.entityKey,
              action: r.action,
              outcome: "released",
              keywordId: null,
              message: hint,
            });
            out.released++;
            released++;
          }
          out.needsReauth = true;
          errors.push({ shopId: shop.id, changeId: change.changeId, error: msg });
          log(`[ads-apply] 🔑 ${shop.displayName}: ${hint}\n`);
          break; // dừng cả shop — thử tiếp chỉ đốt hạn mức
        }

        const transient = err instanceof AdsApiRequestError ? err.isThrottled : true;

        if (transient && change.attempts < maxAttempts) {
          const why = err instanceof AdsApiRequestError && err.isThrottled
            ? "Amazon báo giới hạn tốc độ (429)"
            : `lỗi tạm thời (${msg})`;
          await opts.db
            .releaseAdsChange(change.changeId, `${why} — thử lại lần chạy sau (lần ${change.attempts}/${maxAttempts}).`)
            .catch((e2) => out.errors.push((e2 as Error).message.split("\n")[0]));
          out.changes.push({ ...base, outcome: "released", message: `${why} — trả lại hàng đợi.` });
          out.released++;
          released++;
          log(`[ads-apply] ↺ ${label}: ${why} — trả lại hàng đợi (lần ${change.attempts}/${maxAttempts}).\n`);
          continue;
        }

        const finalMsg =
          `${msg}${transient ? ` (đã thử ${change.attempts}/${maxAttempts} lần)` : ""}`;
        await opts.db
          .recordAdsChange({ changeId: change.changeId, ok: false, error: finalMsg })
          .catch((e2) => out.errors.push((e2 as Error).message.split("\n")[0]));
        out.changes.push({ ...base, outcome: "failed", message: finalMsg });
        out.failed++;
        failed++;
        errors.push({ shopId: shop.id, changeId: change.changeId, error: finalMsg });
        log(`[ads-apply] ✗ ${label}: ${finalMsg}\n`);
      }
    }

    out.action = out.failed > 0 ? "failed" : out.applied > 0 ? "applied" : "idle";
    out.message =
      `${out.applied} áp dụng · ${out.failed} thất bại · ${out.released} trả lại hàng đợi`;
    results.push(out);
  }

  return {
    shopsProcessed: opts.shops.length,
    claimed,
    applied,
    failed,
    released,
    needsReauth: results.filter((r) => r.needsReauth).map((r) => r.shopName),
    results,
    errors,
  };
}
