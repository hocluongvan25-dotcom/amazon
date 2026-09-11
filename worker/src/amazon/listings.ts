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
 * Write ops (put/patch/delete, JSON_LISTINGS_FEED): khóa đến Đợt 2 (SOP-03).
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
