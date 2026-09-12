/**
 * HẠN MỨC NỘI DUNG AMAZON — nguồn sự thật duy nhất cho L3 (Listing Editor).
 *
 * Nguyên tắc (đã kiểm chứng tài liệu 12/09/2026):
 *   1. Hạn mức CHÍNH XÁC luôn nằm trong JSON schema trả về từ
 *      Product Type Definitions API 2020-09-01 (getDefinitionsProductType) —
 *      đó là nguồn ưu tiên số 1 và có thể đổi theo product type.
 *   2. Khi chưa có schema (demo mode / chưa gọi worker), dùng bảng hạn mức
 *      MẶC ĐỊNH dưới đây — mọi giá trị đều ghi rõ nguồn + ngày hiệu lực.
 *   3. Đơn vị: hầu hết là ký tự; `generic_keyword` (từ khóa backend) tính
 *      bằng BYTE UTF-8 — tiếng Việt có dấu tốn 2 byte/ký tự.
 *
 * LƯU Ý VỀ THAY ĐỔI LỚN 27/07/2026: Amazon chuyển tiêu đề sang cấu trúc
 * "modular title": item_name ≤ 75 ký tự (trừ nhóm media giữ 200) + trường
 * mới Item Highlight (`title_differentiation`) ≤ 125 ký tự. Tiêu đề cũ 200
 * ký tự KHÔNG còn đúng cho đa số ngành hàng.
 */

/* ------------------------------------------------------------------ */
/* Nguồn tài liệu (hiển thị trên UI để người dùng đối chiếu)           */
/* ------------------------------------------------------------------ */

export type AmazonSource = {
  id: string;
  label: string;
  url: string;
  checkedAt: string;
  note: string;
};

export const AMAZON_SOURCES: Record<string, AmazonSource> = {
  title_requirements: {
    id: "title_requirements",
    label: "Seller Central — Title requirements (GYTR6SYGFA5E3EQC)",
    url: "https://sellercentral.amazon.com/help/hub/reference/GYTR6SYGFA5E3EQC",
    checkedAt: "2026-09-12",
    note: "Cấu trúc tiêu đề mới: item_name ≤ 75 ký tự, Item Highlight ≤ 125 ký tự (hiệu lực 27/07/2026).",
  },
  item_highlights: {
    id: "item_highlights",
    label: "SP-API changelog 01/07/2026 — cấu trúc tiêu đề mô-đun (Item Highlights)",
    url: "https://developer-docs.amazon.com/sp-api/changelog",
    checkedAt: "2026-09-12",
    note: "title_differentiation ≤ 125 ký tự và CHỈ dùng được khi item_name ≤ 75; áp dụng mọi marketplace trừ SA/EG/TR/AE. Một số ngành hàng chưa hỗ trợ (lỗi 100476).",
  },
  bullet_policy: {
    id: "bullet_policy",
    label: "Seller Central — Product Detail Page Rules (G200390640) + hướng dẫn bullet",
    url: "https://sellercentral.amazon.com/help/hub/reference/G200390640",
    checkedAt: "2026-09-12",
    note: "Mỗi bullet 10–255 ký tự, tối đa 5 bullet; chỉ ~1.000 byte đầu được lập chỉ mục.",
  },
  search_terms: {
    id: "search_terms",
    label: "Seller Central — Search terms (249 byte)",
    url: "https://sellercentral.amazon.com/help/hub/reference/G23501",
    checkedAt: "2026-09-12",
    note: "Từ khóa backend ≤ 249 BYTE (US/UK/EU), 500 (JP), 200 (IN) — vượt là mất toàn bộ từ khóa.",
  },
  product_type_definitions: {
    id: "product_type_definitions",
    label: "SP-API — Product Type Definitions API 2020-09-01",
    url: "https://developer-docs.amazon.com/sp-api/docs/product-type-definitions-api",
    checkedAt: "2026-09-12",
    note: "getDefinitionsProductType trả JSON Schema của product type — nguồn ưu tiên cho maxLength/required/enum.",
  },
  listings_items: {
    id: "listings_items",
    label: "SP-API — Listings Items API 2021-08-01",
    url: "https://developer-docs.amazon.com/sp-api/docs/listings-items-api",
    checkedAt: "2026-09-12",
    note: "put = tạo mới/ghi đè product facts (seller); patch = sửa listing đã tồn tại; marketplaceIds là query param.",
  },
  listings_restrictions: {
    id: "listings_restrictions",
    label: "SP-API — Listings Restrictions API 2021-08-01",
    url: "https://developer-docs.amazon.com/sp-api/docs/listings-restrictions-api",
    checkedAt: "2026-09-12",
    note: "getListingsRestrictions trả APPROVAL_REQUIRED | ASIN_NOT_FOUND | NOT_ELIGIBLE — phải gọi trước khi publish.",
  },
  listings_merge: {
    id: "listings_merge",
    label: "SP-API — Merge a listing (patch op \"merge\")",
    url: "https://developer-docs.amazon.com/sp-api/docs/merge-a-listing",
    checkedAt: "2026-09-12",
    note: "op merge chỉ hỗ trợ fulfillment_availability.quantity và purchasable_offer (xoá quantity_discount_plan bằng null); các attribute khác vẫn replace/delete.",
  },
  listings_workflows: {
    id: "listings_workflows",
    label: "SP-API — Building Listings Management Workflows Guide",
    url: "https://developer-docs.amazon.com/sp-api/docs/building-listings-management-workflows-guide",
    checkedAt: "2026-09-12",
    note: "put = tạo mới/ghi đè (attribute bỏ trống BỊ XOÁ); patch = sửa listing đã có; nên dùng mode=VALIDATION_PREVIEW trước khi gửi.",
  },
  listings_feed: {
    id: "listings_feed",
    label: "SP-API — Listings feed type values",
    url: "https://developer-docs.amazon.com/sp-api/docs/listings-feed-type-values",
    checkedAt: "2026-09-12",
    note: "JSON_LISTINGS_FEED (schema listings-feed-schema-v2) tối đa 25.000 message/feed; feed XML cũ ngừng hỗ trợ 31/07/2025.",
  },
};

/* ------------------------------------------------------------------ */
/* Đếm độ dài — ký tự (code point) và byte UTF-8                       */
/* ------------------------------------------------------------------ */

/** Đếm KÝ TỰ theo code point (emoji tốn 1, không phải 2 như .length). */
export function charCount(value: string): number {
  let n = 0;
  for (const _ of value) n += 1;
  return n;
}

/** Đếm BYTE UTF-8 (tiếng Việt có dấu = 2–3 byte/ký tự). */
export function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    bytes += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
  }
  return bytes;
}

export type LimitUnit = "characters" | "bytes";

/** Hạn mức mặc định của một trường (fallback khi chưa có schema Amazon). */
export type TextLimit = {
  attribute: string;
  label: string;
  max: number;
  unit: LimitUnit;
  /** Nhóm media (sách/nhạc/video) dùng max này thay cho `max` */
  mediaMax?: number;
  /** Ngưỡng tối thiểu theo chính sách (vd bullet ≥ 10 ký tự) */
  policyMin?: number;
  sourceId: keyof typeof AMAZON_SOURCES;
  note?: string;
};

export const TEXT_LIMITS: TextLimit[] = [
  {
    attribute: "item_name",
    label: "Tiêu đề (item_name)",
    max: 75,
    mediaMax: 200,
    unit: "characters",
    sourceId: "title_requirements",
    note: "Tính cả dấu cách; nhóm media (sách/nhạc/video) vẫn 200. Từ 27/07/2026.",
  },
  {
    attribute: "title_differentiation",
    label: "Item Highlight (title_differentiation)",
    max: 125,
    unit: "characters",
    sourceId: "item_highlights",
    note: "Chỉ dùng được khi tiêu đề ≤ 75 ký tự; một số ngành hàng chưa hỗ trợ (lỗi 100476).",
  },
  {
    attribute: "bullet_point",
    label: "Bullet point",
    // Trần FIELD = 500 (schema), nhưng chính sách chỉ cho 10–255 → 256..500 là WARNING
    max: 500,
    unit: "characters",
    sourceId: "bullet_policy",
    note: "Chính sách 10–255 ký tự/bullet (cảnh báo); vượt 500 là Amazon từ chối.",
  },
  {
    attribute: "product_description",
    label: "Mô tả (product_description)",
    max: 2000,
    unit: "characters",
    sourceId: "listings_items",
    note: "Tính cả thẻ HTML; HTML không còn được hỗ trợ (07/2024) → nên để văn bản thuần.",
  },
  {
    attribute: "generic_keyword",
    label: "Từ khóa backend (generic_keyword)",
    max: 249,
    unit: "bytes",
    sourceId: "search_terms",
    note: "BYTE UTF-8. Vượt 1 byte là Amazon bỏ TOÀN BỘ từ khóa (không báo lỗi).",
  },
  {
    attribute: "brand",
    label: "Thương hiệu (brand)",
    max: 50,
    unit: "characters",
    sourceId: "title_requirements",
  },
  {
    attribute: "variation_theme",
    label: "Chủ đề phân loại (variation_theme)",
    max: 100,
    unit: "characters",
    sourceId: "product_type_definitions",
  },
  {
    attribute: "item_type_keyword",
    label: "Item type keyword",
    max: 100,
    unit: "characters",
    sourceId: "product_type_definitions",
  },
];

export const TEXT_LIMIT_BY_ATTRIBUTE: Record<string, TextLimit> = Object.fromEntries(
  TEXT_LIMITS.map((l) => [l.attribute, l]),
);

/**
 * JSON_LISTINGS_FEED: tối đa 25.000 message/feed (kiểm chứng
 * developer-docs.amazon.com/sp-api/docs/listings-feed-type-values). Vượt là
 * Amazon từ chối TOÀN BỘ feed.
 */
export const MAX_FEED_MESSAGES = 25000;

export const MAX_IMAGES = 9; // 1 ảnh chính + 8 ảnh phụ
export const MAX_BULLETS = 5;
export const MIN_IMAGE_LONG_SIDE_PX = 1000; // ảnh chính: cạnh dài ≥ 1000px
export const MAX_IMAGE_LONG_SIDE_PX = 10000;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB/ảnh

export const LISTING_REQUIREMENTS = ["LISTING", "LISTING_PRODUCT_ONLY", "LISTING_OFFER_ONLY", "OFFER"] as const;
export type ListingRequirements = (typeof LISTING_REQUIREMENTS)[number];

export const FULFILLMENT_CHANNELS = ["DEFAULT", "AMAZON_NA", "AMAZON_EU", "AMAZON_FE", "AMAZON_JP"] as const;
export type FulfillmentChannel = (typeof FULFILLMENT_CHANNELS)[number];

/** parentage_level theo Product Type Definitions (CHILD/PARENT/NONE). */
export const PARENTAGE_LEVELS = ["NONE", "PARENT", "CHILD"] as const;
export type ParentageLevel = (typeof PARENTAGE_LEVELS)[number];

/** Từ khóa là BYTE theo thị trường — JP/IN có hạn mức riêng. */
export const KEYWORD_BYTES_BY_MARKETPLACE: Record<string, number> = {
  A1VC38T7YXB528: 500, // JP
  A21TJRUUN4KGV: 200, // IN
};
export const KEYWORD_BYTES_DEFAULT = 249;

export function keywordByteLimit(marketplaceId: string): number {
  return KEYWORD_BYTES_BY_MARKETPLACE[marketplaceId] ?? KEYWORD_BYTES_DEFAULT;
}

/* ------------------------------------------------------------------ */
/* Luật tiêu đề (banned chars / khuyến mại / lặp từ)                   */
/* ------------------------------------------------------------------ */

/** Ký tự bị Amazon chặn trong tiêu đề (trừ khi thuộc tên thương hiệu). */
export const BANNED_TITLE_CHARS = ["!", "$", "?", "_", "{", "}", "^", "¬", "¦"];

/** Cụm từ khuyến mại bị chặn (bảng mẫu — hay gặp nhất). */
export const PROMOTIONAL_PHRASES = [
  "free shipping",
  "free gift",
  "best seller",
  "best-selling",
  "sale",
  "discount",
  "% off",
  "money back",
  "satisfaction guarantee",
  "hot item",
  "top rated",
  "cheap",
];

/** Từ nối được phép lặp > 2 lần trong tiêu đề. */
export const TITLE_STOPWORDS = new Set([
  "a", "an", "and", "or", "for", "with", "the", "of", "to", "in", "on", "at", "by",
  "from", "into", "over", "under", "per", "as", "is", "are", "be", "that", "this",
]);

export function titleWords(title: string): string[] {
  return title
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0);
}

/** Từ (không phải stopword) xuất hiện > 2 lần — Amazon coi là spam tiêu đề. */
export function repeatedTitleWords(title: string): { word: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const w of titleWords(title)) {
    if (TITLE_STOPWORDS.has(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, c]) => c > 2)
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count);
}

export function findBannedTitleChars(title: string, brand?: string | null): string[] {
  const allowed = (brand ?? "").toLowerCase();
  const found = new Set<string>();
  for (const ch of title) {
    if (!BANNED_TITLE_CHARS.includes(ch)) continue;
    if (allowed.includes(ch.toLowerCase())) continue;
    found.add(ch);
  }
  return [...found];
}

export function findPromotionalPhrases(text: string): string[] {
  const lower = text.toLowerCase();
  return PROMOTIONAL_PHRASES.filter((p) => lower.includes(p));
}

/** Từ 3 ký tự trở lên viết HOA toàn bộ (Amazon coi là spam). */
export function isAllCaps(value: string): boolean {
  const words = value.split(/\s+/).filter((w) => /^\p{L}{3,}$/u.test(w));
  if (words.length < 2) return false;
  return words.every((w) => w === w.toUpperCase() && w !== w.toLowerCase());
}

/** Thẻ HTML — Amazon ngừng hỗ trợ trong mô tả từ 07/2024. */
export function hasHtmlTags(value: string): boolean {
  return /<\/?[a-z][^>]*>/i.test(value);
}

/* ------------------------------------------------------------------ */
/* Đọc hạn mức từ JSON Schema của Amazon (getDefinitionsProductType)    */
/* ------------------------------------------------------------------ */

export type SchemaAttributeSpec = {
  attribute: string;
  maxLength: number | null;
  required: boolean;
  type: string | null;
  enumValues: string[] | null;
  /** Amazon cho phép sửa (editable) — thuộc tính hệ thống thì không */
  editable: boolean | null;
};

export type ProductTypeSchemaLimits = {
  /** Luôn là "amazon-schema" — đánh dấu nguồn hạn mức đã đọc từ schema */
  source: "amazon-schema";
  productType: string | null;
  /** Schema có phải bản mới nhất không (meta.schemaVersion) */
  schemaVersion: string | null;
  attributes: Record<string, SchemaAttributeSpec>;
  requiredAttributes: string[];
};

type JsonSchemaNode = {
  type?: string | string[];
  maxLength?: number;
  minLength?: number;
  required?: string[];
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  enum?: unknown[];
  $ref?: string;
  "x-amazon-editable"?: boolean;
};

type ProductTypeDefinitionLike = {
  meta?: { productType?: string; schemaVersion?: string };
  requirements?: string;
  /** Bản trả về của SP-API chỉ có link tải schema, KHÔNG nhúng schema */
  schema?: { link?: { resource?: string } } | JsonSchemaNode;
  propertyGroups?: Record<string, unknown>;
};

/**
 * Đọc hạn mức từ phản hồi getDefinitionsProductType HOẶC từ JSON Schema đã tải.
 *
 * Trả `null` khi chưa có schema thật: phản hồi SP-API chỉ chứa
 * `schema.link.resource` (URL tải schema). Khi đó UI hiển thị hạn mức mặc
 * định và ghi rõ nguồn là "mặc định theo tài liệu", KHÔNG giả vờ là schema.
 */
export function readSchemaLimits(schema: unknown): ProductTypeSchemaLimits | null {
  if (!schema || typeof schema !== "object") return null;
  const wrapper = schema as ProductTypeDefinitionLike;

  // Có thể là JSON Schema trực tiếp (đã tải từ schema.link.resource)...
  let root: JsonSchemaNode | null = null;
  const maybeSchema = wrapper.schema as JsonSchemaNode | undefined;
  if (maybeSchema && typeof maybeSchema === "object" && maybeSchema.properties) {
    root = maybeSchema;
  } else if ((schema as JsonSchemaNode).properties) {
    root = schema as JsonSchemaNode;
  }

  // ...hoặc chỉ là wrapper có link → không đọc được gì
  if (!root) return null;

  const attributes: Record<string, SchemaAttributeSpec> = {};
  for (const [name, node] of Object.entries(root.properties ?? {})) {
    // Amazon Meta-Schema: thuộc tính là mảng các "value object" có maxLength
    const item = node.items ?? node;
    const enumValues =
      (Array.isArray(item.enum) ? item.enum : Array.isArray(node.enum) ? node.enum : null)?.map(String) ?? null;
    const maxLength =
      typeof node.maxLength === "number" ? node.maxLength : typeof item.maxLength === "number" ? item.maxLength : null;
    attributes[name] = {
      attribute: name,
      maxLength,
      required: false, // gán ở dưới theo root.required
      type: typeof item.type === "string" ? item.type : Array.isArray(item.type) ? item.type[0] ?? null : null,
      enumValues,
      editable: item["x-amazon-editable"] ?? null,
    };
  }

  const requiredAttributes = Array.isArray(root.required) ? [...root.required].sort() : [];
  for (const name of requiredAttributes) {
    attributes[name] = {
      attribute: name,
      maxLength: attributes[name]?.maxLength ?? null,
      required: true,
      type: attributes[name]?.type ?? null,
      enumValues: attributes[name]?.enumValues ?? null,
      editable: attributes[name]?.editable ?? null,
    };
  }

  return {
    source: "amazon-schema",
    productType: wrapper.meta?.productType ?? null,
    schemaVersion: wrapper.meta?.schemaVersion ?? null,
    attributes,
    requiredAttributes,
  };
}

/** Hạn mức cuối cùng cho một attribute: schema Amazon ưu tiên hơn bảng mặc định. */
export type ResolvedLimit = {
  attribute: string;
  max: number | null;
  unit: LimitUnit;
  source: "amazon-schema" | "vexim-policy-fallback";
  note: string;
};

export function resolveLimit(
  attribute: string,
  schemaLimits?: ProductTypeSchemaLimits | null,
  opts: { market?: string; productType?: string | null } = {},
): ResolvedLimit {
  const fromSchema = schemaLimits?.attributes?.[attribute]?.maxLength;
  const fallback = TEXT_LIMIT_BY_ATTRIBUTE[attribute];
  const isMedia = isMediaProductType(opts.productType ?? "");
  const market = opts.market ?? "";

  if (typeof fromSchema === "number") {
    return {
      attribute,
      max: fromSchema,
      unit: fallback?.unit ?? "characters",
      source: "amazon-schema",
      note: `Theo JSON Schema product type (schemaVersion ${schemaLimits?.schemaVersion ?? "?"})`,
    };
  }

  if (attribute === "generic_keyword") {
    return {
      attribute,
      max: keywordByteLimit(market),
      unit: "bytes",
      source: "vexim-policy-fallback",
      note: fallback?.note ?? "BYTE UTF-8; vượt là mất toàn bộ từ khóa",
    };
  }

  if (attribute === "item_name" && fallback) {
    return {
      attribute,
      max: isMedia && fallback.mediaMax ? fallback.mediaMax : fallback.max,
      unit: "characters",
      source: "vexim-policy-fallback",
      note: fallback.note ?? "",
    };
  }

  return {
    attribute,
    max: fallback?.max ?? null,
    unit: fallback?.unit ?? "characters",
    source: "vexim-policy-fallback",
    note: fallback?.note ?? "Chưa khai báo hạn mức — kiểm tra lại trong schema Amazon.",
  };
}

/** Attribute bắt buộc có trong schema mà form VEXIM CHƯA hỗ trợ (cần nhập ở Seller Central). */
export function schemaOnlyRequiredAttributes(schemaLimits: ProductTypeSchemaLimits | null): string[] {
  if (!schemaLimits) return [];
  const covered = new Set(COVERED_ATTRIBUTES);
  return schemaLimits.requiredAttributes.filter((a) => !covered.has(a));
}

/* ------------------------------------------------------------------ */
/* Phân loại ngành hàng media (tiêu đề vẫn 200 ký tự)                   */
/* ------------------------------------------------------------------ */

const MEDIA_PRODUCT_TYPE_PATTERNS = [
  "BOOK",
  "MUSIC",
  "VIDEO",
  "DVD",
  "BLU_RAY",
  "BLURAY",
  "AUDIOBOOK",
  "VINYL",
  "CD_",
  "_CD",
  "DOWNLOADABLE",
  "VHS",
  "ABIS",
];

export function isMediaProductType(productType: string | null | undefined): boolean {
  const pt = (productType ?? "").toUpperCase();
  if (!pt) return false;
  return MEDIA_PRODUCT_TYPE_PATTERNS.some((p) => pt.includes(p));
}

/** Attribute nào form L3 bao phủ (dùng cho schemaOnlyRequiredAttributes). */
export const COVERED_ATTRIBUTES = [
  "item_name",
  "title_differentiation",
  "bullet_point",
  "product_description",
  "generic_keyword",
  "brand",
  "main_product_image_locator",
  "other_product_image_locator_1",
  "other_product_image_locator_2",
  "other_product_image_locator_3",
  "other_product_image_locator_4",
  "other_product_image_locator_5",
  "other_product_image_locator_6",
  "other_product_image_locator_7",
  "other_product_image_locator_8",
  "purchasable_offer",
  "fulfillment_availability",
  "parentage_level",
  "child_parent_sku_relationship",
  "variation_theme",
  "item_type_keyword",
];
