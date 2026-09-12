/**
 * Typed client Listings Items API v2021-08-01 — getListingsItem (ĐỌC).
 * Đầu vào của màn L1 (trạng thái), L2 (thuộc tính + issues), L4 (queue lỗi).
 * Kiểu theo reference chính thức:
 *   GET /listings/2021-08-01/items/{sellerId}/{sku}
 *   ?marketplaceIds=...&includedData=summaries,attributes,issues,offers,...
 *   &issueLocale=en_US
 * includedData enum: summaries | attributes | issues | offers |
 *   fulfillmentAvailability | procurement (mặc định: summaries).
 * Rate limit: 5 req/s · burst 10 (worker retry 429 theo Retry-After).
 *
 * Lưu ý thực tế đã ghi nhận: summaries[].itemName CÓ THỂ null → type optional.
 *
 * Đợt 2 (L3) bổ sung WRITE + schema:
 *   • PUT   /listings/2021-08-01/items/{sellerId}/{sku}?marketplaceIds=...
 *   • PATCH /listings/2021-08-01/items/{sellerId}/{sku}?marketplaceIds=...
 *     PATCH = JSON Patch (RFC 6902), thao tác ở mức TOÀN BỘ thuộc tính:
 *     [{op:"replace", path:"/attributes/item_name", value:[{value,...}]}]
 *     • Seller: `put` THAY product facts + GỘP (merge) sales terms
 *     • Sửa listing đang tồn tại: dùng `patch`, KHÔNG dùng `put`
 *   • GET   /listings/2021-08-01/restrictions  → kiểm tra hạn chế danh mục
 *     (bắt buộc trước khi publish ASIN đã tồn tại; rỗng = không hạn chế)
 *   • GET   /definitions/2020-09-01/productTypes/{productType} → schema JSON
 *     (form động theo product type; requirements=LISTING|LISTING_PRODUCT_ONLY|
 *      LISTING_OFFER_ONLY)
 * Kết quả submit: {sku, status: ACCEPTED|INVALID, submissionId, issues[]}.
 * `marketplaceIds` LUÔN là query param — không đặt trong body.
 * Body không có field nào khác ngoài productType / patches / attributes.
 */
import { LwaTokenManager } from "./lwa.ts";

export type ItemSummary = {
  marketplaceId?: string;
  asin?: string;
  productType?: string;
  conditionType?: string;
  /** BUYABLE / DISCOVERABLE — rỗng nếu không áp dụng */
  status?: string[];
  itemName?: string | null; // đã có issue thực tế: null dù listing tồn tại
  createdDate?: string;
  lastUpdatedDate?: string;
  mainImage?: { link?: string; height?: number; width?: number };
};

export type ItemIssue = {
  code?: string; // mã máy đọc được, vd "8541", "90220"
  message?: string;
  severity?: "ERROR" | "WARNING" | "INFO";
  attributeNames?: string[];
  categories?: string[]; // vd MISSING_ATTRIBUTE
  enforcements?: {
    actions?: string[]; // vd LISTING_SUPPRESSED, SEARCH_SUPPRESSED
    exemption?: { status?: string; exemptionType?: string };
  };
};

export type FulfillmentAvailability = {
  fulfillmentChannelCode?: string;
  quantity?: number;
};

export type ListingsItem = {
  sku: string;
  summaries?: ItemSummary[];
  attributes?: Record<string, unknown[]>;
  issues?: ItemIssue[];
  offers?: unknown[];
  fulfillmentAvailability?: FulfillmentAvailability[];
  procurement?: unknown[];
};

/* ------------------------------------------------------------------ */
/* Kiểu cho WRITE + restrictions + product type definitions            */
/* ------------------------------------------------------------------ */

export type ListingIssue = {
  code: string;
  message: string;
  severity: "ERROR" | "WARNING" | "INFO";
  attributeNames?: string[];
  categories?: string[];
};

/** Phản hồi putListingsItem / patchListingsItem */
export type ListingSubmission = {
  sku: string;
  /** ACCEPTED = Amazon nhận để xử lý; INVALID = bị từ chối ngay */
  status: "ACCEPTED" | "INVALID" | string;
  submissionId: string;
  issues?: ListingIssue[];
};

/** Một patch JSON Patch (RFC 6902) — chỉ add/replace/delete ở gốc /attributes */
export type JsonPatchOperation = {
  op: "add" | "replace" | "delete";
  path: string;
  value?: unknown;
};

export type ListingsRestrictionReason = {
  message?: string;
  reasonCode?: "APPROVAL_REQUIRED" | "ASIN_NOT_FOUND" | "NOT_ELIGIBLE" | string;
  links?: { resource?: string; verb?: string; title?: string; type?: string }[];
};

export type ListingsRestriction = {
  marketplaceId?: string;
  conditionType?: string;
  reasons?: ListingsRestrictionReason[];
};

export type ListingsRestrictionsResponse = {
  restrictions?: ListingsRestriction[];
};

/** Meta-schema mở rộng của Amazon cho JSON Schema 2019-09 (chỉ trường cần) */
export type ProductTypeDefinition = {
  meta?: { schemaVersion?: string; productType?: string };
  schema?: {
    link?: { resource?: string; verb?: string };
    checksum?: string;
  };
  requirements?: string;
  requirementsEnforced?: string;
  propertyGroups?: Record<string, unknown>;
  locale?: string;
};

export const LISTINGS_REQUIREMENTS = [
  "LISTING",
  "LISTING_PRODUCT_ONLY",
  "LISTING_OFFER_ONLY",
] as const;

export type ListingsRequirements = (typeof LISTINGS_REQUIREMENTS)[number];

export const LISTINGS_INCLUDED_DATA = [
  "summaries",
  "attributes",
  "issues",
  "offers",
  "fulfillmentAvailability",
] as const;

export class ListingsItemsClient {
  private readonly host: string;
  private readonly lwa: LwaTokenManager;
  private readonly fetchFn: typeof fetch;

  constructor(opts: { host: string; lwa: LwaTokenManager; fetchFn?: typeof fetch }) {
    this.host = opts.host;
    this.lwa = opts.lwa;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  async getListingsItem(params: {
    sellerId: string;
    sku: string;
    marketplaceId: string;
    includedData?: readonly string[];
    issueLocale?: string;
  }): Promise<ListingsItem> {
    const token = await this.lwa.getAccessToken();
    const url = new URL(
      `${this.host}/listings/2021-08-01/items/${encodeURIComponent(params.sellerId)}/${encodeURIComponent(params.sku)}`,
    );
    url.searchParams.set("marketplaceIds", params.marketplaceId);
    url.searchParams.set(
      "includedData",
      (params.includedData ?? LISTINGS_INCLUDED_DATA).join(","),
    );
    if (params.issueLocale) url.searchParams.set("issueLocale", params.issueLocale);

    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await this.fetchFn(url.toString(), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 429) {
        const waitMs = Number(res.headers.get("retry-after") ?? 1) * 1000;
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      if (res.status === 404) {
        throw new Error(`getListingsItem 404: SKU "${params.sku}" không tồn tại`);
      }
      if (!res.ok) {
        throw new Error(`getListingsItem HTTP ${res.status}: ${await res.text()}`);
      }
      return (await res.json()) as ListingsItem;
    }
    throw new Error("getListingsItem: vượt số lần retry (429)");
  }

  /* ---------------------------------------------------------------- */
  /* Schema + kiểm tra hạn chế (phục vụ L3 trước khi publish)         */
  /* ---------------------------------------------------------------- */

  /**
   * Kiểm tra hạn chế danh mục — Listings Restrictions API v2021-08-01.
   * Không hạn chế → `restrictions: []` (KHÔNG phải lỗi).
   * reasonCode: APPROVAL_REQUIRED (có link xin duyệt) | ASIN_NOT_FOUND | NOT_ELIGIBLE.
   */
  async getListingsRestrictions(params: {
    sellerId: string;
    asin: string;
    marketplaceId: string;
    conditionType?: string;
    /** một số SDK đặt tên issueLocale — reference dùng reasonLocale */
    reasonLocale?: string;
  }): Promise<ListingsRestrictionsResponse> {
    const url = new URL(`${this.host}/listings/2021-08-01/restrictions`);
    url.searchParams.set("asin", params.asin);
    url.searchParams.set("sellerId", params.sellerId);
    url.searchParams.set("marketplaceIds", params.marketplaceId);
    if (params.conditionType) url.searchParams.set("conditionType", params.conditionType);
    if (params.reasonLocale) url.searchParams.set("reasonLocale", params.reasonLocale);
    return this.requestJson<ListingsRestrictionsResponse>(url.toString(), { method: "GET" }, "getListingsRestrictions");
  }

  /**
   * Lấy định nghĩa product type (Product Type Definitions API 2020-09-01) để
   * dựng form động. `requirements` quyết định schema trả về:
   *   LISTING (sản phẩm + offer) | LISTING_PRODUCT_ONLY | LISTING_OFFER_ONLY.
   * Với LISTING_OFFER_ONLY phải truyền `productTypeVersion` nếu biết, và có thể
   * cần `sellerId` để lấy thuộc tính riêng của seller.
   */
  async getDefinitionsProductType(params: {
    productType: string;
    marketplaceId: string;
    requirements: ListingsRequirements;
    locale: string;
    sellerId?: string;
    productTypeVersion?: string;
  }): Promise<ProductTypeDefinition> {
    const url = new URL(
      `${this.host}/definitions/2020-09-01/productTypes/${encodeURIComponent(params.productType)}`,
    );
    url.searchParams.set("marketplaceIds", params.marketplaceId);
    url.searchParams.set("requirements", params.requirements);
    url.searchParams.set("locale", params.locale);
    if (params.sellerId) url.searchParams.set("sellerId", params.sellerId);
    if (params.productTypeVersion) url.searchParams.set("productTypeVersion", params.productTypeVersion);
    return this.requestJson<ProductTypeDefinition>(url.toString(), { method: "GET" }, "getDefinitionsProductType");
  }

  /** Gợi ý product type từ tên/keyword (bước đầu luồng tạo listing mới) */
  async searchDefinitionsProductTypes(params: {
    marketplaceId: string;
    keywords: string[];
    locale?: string;
  }): Promise<{ productTypes?: { name?: string; marketplaceId?: string; displayName?: string }[] }> {
    const url = new URL(`${this.host}/definitions/2020-09-01/productTypes`);
    url.searchParams.set("marketplaceIds", params.marketplaceId);
    url.searchParams.set("keywords", params.keywords.join(","));
    url.searchParams.set("keywordsEnforced", "REQUIRED");
    url.searchParams.set("locale", params.locale ?? "en_US");
    url.searchParams.set("itemName", params.keywords[0] ?? "");
    return this.requestJson(url.toString(), { method: "GET" }, "searchDefinitionsProductTypes");
  }

  /* ---------------------------------------------------------------- */
  /* Ghi (L3 publish)                                                 */
  /* ---------------------------------------------------------------- */

  /**
   * PATCH — sửa listing ĐANG tồn tại. Không dùng cho tạo mới.
   * `marketplaceIds` là query param; body chỉ gồm productType + patches.
   */
  async patchListingsItem(params: {
    sellerId: string;
    sku: string;
    marketplaceId: string;
    productType: string;
    patches: JsonPatchOperation[];
    issueLocale?: string;
  }): Promise<ListingSubmission> {
    const url = new URL(
      `${this.host}/listings/2021-08-01/items/${encodeURIComponent(params.sellerId)}/${encodeURIComponent(params.sku)}`,
    );
    url.searchParams.set("marketplaceIds", params.marketplaceId);
    if (params.issueLocale) url.searchParams.set("issueLocale", params.issueLocale);
    return this.requestJson<ListingSubmission>(
      url.toString(),
      {
        method: "PATCH",
        body: JSON.stringify({ productType: params.productType, patches: params.patches }),
      },
      "patchListingsItem",
    );
  }

  /**
   * PUT — tạo mới HOẶC ghi đè toàn bộ product facts (Seller).
   * Lưu ý: seller `put` THAY product facts nhưng GỘP sales terms (giá/tồn có thể
   * giữ nguyên nếu không gửi) — vẫn nên gửi đủ thuộc tính bắt buộc của schema.
   */
  async putListingsItem(params: {
    sellerId: string;
    sku: string;
    marketplaceId: string;
    productType: string;
    requirements: ListingsRequirements;
    attributes: Record<string, unknown[]>;
    issueLocale?: string;
  }): Promise<ListingSubmission> {
    const url = new URL(
      `${this.host}/listings/2021-08-01/items/${encodeURIComponent(params.sellerId)}/${encodeURIComponent(params.sku)}`,
    );
    url.searchParams.set("marketplaceIds", params.marketplaceId);
    if (params.issueLocale) url.searchParams.set("issueLocale", params.issueLocale);
    return this.requestJson<ListingSubmission>(
      url.toString(),
      {
        method: "PUT",
        body: JSON.stringify({
          productType: params.productType,
          requirements: params.requirements,
          attributes: params.attributes,
        }),
      },
      "putListingsItem",
    );
  }

  /** GET/POST/PATCH/PUT có retry 429 theo Retry-After (giống getListingsItem) */
  private async requestJson<T>(url: string, init: RequestInit, label: string): Promise<T> {
    const token = await this.lwa.getAccessToken();
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await this.fetchFn(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
        },
      });
      if (res.status === 429) {
        const waitMs = Number(res.headers.get("retry-after") ?? 1) * 1000;
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      if (!res.ok) {
        throw new Error(`${label} HTTP ${res.status}: ${await res.text()}`);
      }
      return (await res.json()) as T;
    }
    throw new Error(`${label}: vượt số lần retry (429)`);
  }
}

/** Trích trạng thái chuẩn hóa từ Item (BUYABLE/DISCOVERABLE → trạng thái L1) */
export function extractListingState(item: ListingsItem): {
  asin: string | null;
  itemName: string | null;
  productType: string | null;
  buyable: boolean | null;
  discoverable: boolean | null;
  issueErrors: number;
  issueWarnings: number;
  enforcementActions: string[];
} {
  const s = item.summaries?.[0];
  const flags = s?.status ?? [];
  const issues = item.issues ?? [];
  const enforcementActions = new Set<string>();
  for (const i of issues) {
    for (const a of i.enforcements?.actions ?? []) enforcementActions.add(a);
  }
  return {
    asin: s?.asin ?? null,
    itemName: s?.itemName ?? null,
    productType: s?.productType ?? null,
    buyable: flags.length > 0 ? flags.includes("BUYABLE") : null,
    discoverable: flags.length > 0 ? flags.includes("DISCOVERABLE") : null,
    issueErrors: issues.filter((i) => i.severity === "ERROR").length,
    issueWarnings: issues.filter((i) => i.severity === "WARNING").length,
    enforcementActions: [...enforcementActions],
  };
}
