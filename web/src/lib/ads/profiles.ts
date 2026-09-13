/**
 * Profile Ads API — `GET /v2/profiles` và cách CHỌN profileId cho một shop.
 *
 * Vì sao phải chọn cẩn thận: profileId quyết định dữ liệu của TÀI KHOẢN QUẢNG CÁO
 * nào được ghi vào shop đó. Chọn sai (ví dụ lấy profile US cho shop UK) là số liệu
 * PPC của hai thị trường trộn vào nhau — sai mà KHÔNG ai nhìn thấy. Nên nguyên tắc
 * ở đây là: KHÔNG ĐOÁN. Không khớp rõ ràng → trả null kèm lý do, để cron ghi cảnh
 * báo và con người xử lý, thay vì âm thầm ghi dữ liệu sai.
 *
 * Amazon trả về (v2): MẢNG trơn các profile
 *   { profileId, countryCode, currencyCode, timezone,
 *     accountInfo: { id, type: "seller"|"vendor"|"author", name, marketplaceStringId },
 *     dailyBudget: { amount, currencyCode } }
 * RPC 0020 đọc được cả nested lẫn phẳng nên đẩy nguyên raw lên + chèn isDefault/source.
 */

export type AdsProfileRaw = Record<string, unknown>;

export type AdsProfile = {
  profileId: string;
  countryCode: string | null;
  currencyCode: string | null;
  timezone: string | null;
  accountId: string | null;
  accountType: string | null;
  accountName: string | null;
  marketplaceId: string | null;
  dailyBudget: number | null;
  dailyBudgetCurrency: string | null;
  isDefault: boolean;
  raw: AdsProfileRaw;
};

/** Marketplace của shop ( Seller Central) → mã quốc gia của profile Ads. */
export const MARKETPLACE_COUNTRY: Record<string, string> = {
  ATVPDKIKX0DER: "US", // Mỹ
  A2EUQ1WTGCTBG2: "CA", // Canada
  A1AM78C64UM0Y8: "MX", // Mexico
  A2Q3Y263D00KWC: "BR", // Brazil
  A1PA6795UKMFR9: "DE", // Đức
  A1F83G8C2ARO7P: "GB", // Anh
  A13V1IB3VIYZZH: "FR", // Pháp
  A1VC38T7YXB528: "JP", // Nhật
  A39IBJ37TRP1C6: "AU", // Úc
  A21TJRUUN4KGV: "IN", // Ấn Độ
  APJ6JRA9NG5V4: "IT", // Ý
  A1RKKUPIHCS9HS: "ES", // Tây Ban Nha
  A1805IZSGTT6HS: "NL", // Hà Lan
  A33AVAJ2PDY3EV: "TR", // Thổ Nhĩ Kỳ
  A17E79C6D8DWNP: "SA", // Ả Rập Xê Út
  A2VIGQ35RCS4UG: "AE", // UAE
  AAK2BHW1L3KTT: "SE", // Thuỵ Điển
};

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function bool(v: unknown): boolean {
  return v === true || v === "true" || v === 1 || v === "1";
}

export function countryFromMarketplace(marketplaceId: string | null | undefined): string | null {
  const id = str(marketplaceId)?.toUpperCase();
  if (!id) return null;
  return MARKETPLACE_COUNTRY[id] ?? null;
}

/** Amazon có thể trả mảng trơn, {profiles: […]}, hoặc null. */
export function normalizeProfileList(res: unknown): AdsProfileRaw[] {
  if (Array.isArray(res)) return res.filter((x) => x && typeof x === "object") as AdsProfileRaw[];
  if (res && typeof res === "object") {
    const rec = res as Record<string, unknown>;
    if (Array.isArray(rec.profiles)) return rec.profiles.filter((x) => x && typeof x === "object") as AdsProfileRaw[];
  }
  return [];
}

export function normalizeProfile(raw: AdsProfileRaw): AdsProfile | null {
  const profileId = str(raw.profileId ?? raw.id);
  if (!profileId) return null;
  const accountInfo = (raw.accountInfo && typeof raw.accountInfo === "object"
    ? (raw.accountInfo as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const dailyBudget = (raw.dailyBudget && typeof raw.dailyBudget === "object"
    ? (raw.dailyBudget as Record<string, unknown>)
    : null) as Record<string, unknown> | null;

  return {
    profileId,
    countryCode: str(raw.countryCode)?.toUpperCase() ?? null,
    currencyCode: str(raw.currencyCode ?? raw.currency) ?? null,
    timezone: str(raw.timezone) ?? null,
    accountId: str(accountInfo.id ?? raw.accountId) ?? null,
    accountType: str(accountInfo.type ?? raw.accountType)?.toLowerCase() ?? null,
    accountName: str(accountInfo.name ?? raw.accountName) ?? null,
    marketplaceId: str(accountInfo.marketplaceStringId ?? raw.marketplaceStringId ?? raw.marketplace)?.toUpperCase() ?? null,
    dailyBudget: num(dailyBudget ? (dailyBudget.amount ?? dailyBudget.budget) : (raw.dailyBudget ?? raw.amount)),
    dailyBudgetCurrency: str(dailyBudget?.currencyCode ?? raw.dailyBudgetCurrencyCode) ?? null,
    isDefault: bool(raw.isDefault),
    raw,
  };
}

export function normalizeProfiles(res: unknown): AdsProfile[] {
  return normalizeProfileList(res)
    .map(normalizeProfile)
    .filter((p): p is AdsProfile => p !== null);
}

export type PickProfileInput = {
  /** Ép dùng đúng profileId này (env AMAZON_ADS_PROFILE_ID / cột ads_account_id). */
  profileId?: string | null;
  /** Marketplace của shop (từ connections.seller_accounts). */
  marketplaceId?: string | null;
  /** Mã quốc gia nếu biết sẵn (ưu tiên hơn suy từ marketplace). */
  countryCode?: string | null;
  /** seller | vendor | author — mặc định seller. */
  accountType?: string | null;
};

export type ProfileDecision = {
  profile: AdsProfile | null;
  /** Vì sao chọn (hoặc vì sao KHÔNG chọn) — ghi vào log/DB, không để người dùng đoán. */
  reason: string;
  candidates: number;
  warnings: string[];
};

export function pickProfile(profiles: AdsProfile[], input: PickProfileInput = {}): ProfileDecision {
  const warnings: string[] = [];
  if (profiles.length === 0) {
    return {
      profile: null,
      reason:
        "GET /v2/profiles trả 0 profile — token Ads chưa gắn tài khoản quảng cáo nào " +
        "(hoặc sai vùng: profile EU/FE không xuất hiện khi gọi host NA).",
      candidates: 0,
      warnings,
    };
  }

  // 1. Ép theo profileId (người vận hành đã chốt) — không khớp thì DỪNG, không chọn bừa.
  const forced = str(input.profileId);
  if (forced) {
    const hit = profiles.find((p) => p.profileId === forced);
    if (!hit) {
      return {
        profile: null,
        reason: `profileId ${forced} không nằm trong ${profiles.length} profile của token này (${profiles
          .map((p) => `${p.profileId}/${p.countryCode ?? "?"}`)
          .join(", ")}).`,
        candidates: profiles.length,
        warnings,
      };
    }
    return {
      profile: hit,
      reason: `dùng profileId đã ép: ${hit.profileId} (${hit.countryCode ?? "?"}, ${hit.accountType ?? "?"}).`,
      candidates: profiles.length,
      warnings,
    };
  }

  // 2. Lọc theo loại tài khoản (VEXIM là seller; vendor/author dùng attribution 14d).
  const wantType = (input.accountType ?? "seller").toLowerCase();
  let pool = profiles.filter((p) => (p.accountType ?? "").toLowerCase() === wantType);
  if (pool.length === 0) {
    warnings.push(
      `Không có profile type='${wantType}' trong ${profiles.length} profile (${profiles
        .map((p) => p.accountType ?? "?")
        .join(", ")}) — xét tất cả. Kiểm tra attribution window: vendor/author dùng 14d, không phải 7d.`,
    );
    pool = profiles;
  }

  // 3. Khớp quốc gia: ưu tiên countryCode cho trước, không thì suy từ marketplace của shop.
  const country = (str(input.countryCode) ?? countryFromMarketplace(input.marketplaceId))?.toUpperCase() ?? null;
  const marketplace = str(input.marketplaceId)?.toUpperCase() ?? null;

  if (marketplace) {
    const byMarket = pool.filter((p) => p.marketplaceId === marketplace);
    if (byMarket.length === 1) {
      return {
        profile: byMarket[0],
        reason: `khớp marketplaceStringId ${marketplace} → profile ${byMarket[0].profileId}.`,
        candidates: profiles.length,
        warnings,
      };
    }
    if (byMarket.length > 1) {
      const chosen = byMarket.find((p) => p.isDefault) ?? byMarket[0];
      warnings.push(
        `Có ${byMarket.length} profile cùng marketplace ${marketplace} → dùng ${chosen.profileId}` +
          `${chosen.isDefault ? " (isDefault)" : " (profile đầu tiên)"}. Số liệu có thể thiếu phần còn lại.`,
      );
      return {
        profile: chosen,
        reason: `nhiều profile cùng marketplace ${marketplace}; chọn ${chosen.profileId}.`,
        candidates: profiles.length,
        warnings,
      };
    }
  }

  if (country) {
    const byCountry = pool.filter((p) => p.countryCode === country);
    if (byCountry.length === 1) {
      return {
        profile: byCountry[0],
        reason: `khớp countryCode ${country} → profile ${byCountry[0].profileId}.`,
        candidates: profiles.length,
        warnings,
      };
    }
    if (byCountry.length > 1) {
      const chosen = byCountry.find((p) => p.isDefault) ?? byCountry[0];
      warnings.push(
        `Có ${byCountry.length} profile cùng quốc gia ${country} → dùng ${chosen.profileId}. ` +
          `Nếu shop chạy nhiều tài khoản quảng cáo, phải chốt profileId thủ công.`,
      );
      return {
        profile: chosen,
        reason: `nhiều profile cùng countryCode ${country}; chọn ${chosen.profileId}.`,
        candidates: profiles.length,
        warnings,
      };
    }
  }

  // 4. Không khớp gì: chỉ dám dùng khi token có DUY NHẤT một profile.
  if (profiles.length === 1) {
    const only = profiles[0];
    warnings.push(
      `Shop${country ? ` ở ${country}` : ""} nhưng token chỉ có 1 profile: ${only.profileId} ` +
        `(${only.countryCode ?? "?"}, ${only.accountType ?? "?"}) — dùng luôn. Kiểm tra lại nếu thấy số liệu lạ.`,
    );
    return {
      profile: only,
      reason: `chỉ có 1 profile (${only.profileId}) nên dùng nó.`,
      candidates: 1,
      warnings,
    };
  }

  return {
    profile: null,
    reason:
      `Không xác định được profile cho shop${country ? ` (${country})` : ""}: token có ${profiles.length} profile ` +
      `(${profiles.map((p) => `${p.profileId}/${p.countryCode ?? "?"}/${p.accountType ?? "?"}`).join(", ")}) ` +
      `và KHÔNG cái nào khớp. Không đoán — hãy chốt profileId (AMAZON_ADS_PROFILE_ID hoặc cột ads_account_id).`,
    candidates: profiles.length,
    warnings,
  };
}

/**
 * Đẩy nguyên raw profile lên RPC (0020 đọc được cả nested accountInfo/dailyBudget),
 * chèn thêm `isDefault` (profile được chọn) và `source` để biết dữ liệu từ đâu.
 */
export function toProfileRpcRows(
  profiles: AdsProfile[],
  opts: { pickedProfileId?: string | null; source?: string } = {},
): AdsProfileRaw[] {
  return profiles.map((p) => ({
    ...p.raw,
    profileId: p.profileId,
    isDefault: opts.pickedProfileId ? p.profileId === opts.pickedProfileId : p.isDefault,
    source: opts.source ?? "ads_api",
  }));
}
