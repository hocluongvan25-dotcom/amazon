/**
 * L3 — LISTING EDITOR: model thuần (không phụ thuộc React/Supabase).
 *
 * Chứa "luật chơi" của trình soạn listing:
 *   • FIELDS/FIELD_GROUPS — form động theo product type của Amazon
 *   • validateListingDraft — kiểm tra hạn mức + ràng buộc trước khi gửi duyệt
 *   • DRAFT_TRANSITIONS/availableActions — Draft → trưởng phòng duyệt → Publish
 *   • buildPatchBody/buildPutBody/buildFeedDocument — payload gửi SP-API
 *   • checkPublishGate — cổng hạn chế danh mục trước khi publish
 *
 * Mọi ngưỡng lấy từ amazon-limits.ts (đã đối chiếu tài liệu Amazon 12/09/2026);
 * khi có JSON Schema của product type thì schema là nguồn ưu tiên.
 */

import {
  AMAZON_SOURCES,
  COVERED_ATTRIBUTES,
  MAX_BULLETS,
  MAX_FEED_MESSAGES,
  MAX_IMAGES,
  TEXT_LIMIT_BY_ATTRIBUTE,
  charCount,
  findBannedTitleChars,
  findPromotionalPhrases,
  hasHtmlTags,
  isAllCaps,
  isMediaProductType,
  readSchemaLimits,
  repeatedTitleWords,
  resolveLimit,
  utf8Bytes,
  type LimitUnit,
  type ListingRequirements,
  type ParentageLevel,
  type ProductTypeSchemaLimits,
  type ResolvedLimit,
} from "./amazon-limits.ts";

export { MAX_BULLETS, MAX_FEED_MESSAGES, MAX_IMAGES };

/** Re-export vài kiểu hay dùng ở tầng API/UI để chỉ cần import một chỗ. */
export type {
  LimitUnit,
  ListingRequirements,
  ParentageLevel,
  ProductTypeSchemaLimits,
  ResolvedLimit,
} from "./amazon-limits.ts";

/* ------------------------------------------------------------------ */
/* Kiểu dữ liệu                                                       */
/* ------------------------------------------------------------------ */

/** Payload bản nháp = attributes của listing theo schema Amazon. */
export type ListingDraftPayload = Record<string, unknown[] | undefined>;

export type IssueSeverity = "ERROR" | "WARNING" | "INFO";

export type ValidationIssue = {
  code: string;
  severity: IssueSeverity;
  /** Attribute Amazon liên quan — khớp issue.attributeNames của SP-API.
   *  Rỗng ("") với các thông báo không gắn attribute cụ thể. */
  attributeName: string;
  message: string;
  /** Gợi ý cách sửa */
  hint?: string;
  /** Mã lỗi Amazon tham chiếu (90220, 4002005…) để tra cứu khi Amazon trả về */
  amazonCode?: string;
  /** Nguồn tài liệu của luật này (khoá trong AMAZON_SOURCES) */
  sourceId?: keyof typeof AMAZON_SOURCES;
};

export type ValidationLimitUsage = {
  label: string;
  max: number | null;
  used: number;
  unit: LimitUnit;
  source: ResolvedLimit["source"];
  note: string;
};

export type ValidationReport = {
  checkedAt: string;
  productType: string;
  marketplaceId: string;
  /** "vexim-policy" khi chưa có schema; "+schema" khi đã đối chiếu schema Amazon */
  source: "vexim-policy" | "amazon-schema+vexim-policy";
  ok: boolean;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  issues: ValidationIssue[];
  /** Hạn mức đã áp — tra theo tên attribute, dùng để hiển thị "đã dùng x/y" */
  limits: Record<string, ValidationLimitUsage>;
};

export type DraftStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "publishing"
  | "published"
  | "failed";

export const DRAFT_STATUS_LABEL: Record<DraftStatus, string> = {
  draft: "Nháp",
  pending_approval: "Chờ trưởng phòng duyệt",
  approved: "Đã duyệt — chờ publish",
  rejected: "Bị từ chối",
  publishing: "Đang gửi Amazon",
  published: "Đã publish",
  failed: "Publish lỗi",
};

/* ------------------------------------------------------------------ */
/* Khai báo trường (form động theo product type)                       */
/* ------------------------------------------------------------------ */

export type FieldKind =
  | "title"
  | "highlight"
  | "bullets"
  | "textarea"
  | "text"
  | "images"
  | "offer"
  | "fulfillment"
  | "variation";

export type FieldGroupKey = "content" | "media" | "variation" | "sales_terms";

export type FieldSpec = {
  attribute: string;
  label: string;
  kind: FieldKind;
  group: FieldGroupKey;
  required: boolean;
  /** Không bắt buộc theo chính sách chung (có thể bắt buộc theo schema) */
  optional?: boolean;
  help: string;
  /** Attribute dùng để tra hạn mức (mặc định = attribute) */
  limitAttribute?: string;
};

export const FIELD_GROUPS: { key: FieldGroupKey; label: string; hint: string }[] = [
  { key: "content", label: "Nội dung & từ khóa", hint: "Tiêu đề, Item Highlight, bullet, mô tả, từ khóa backend" },
  { key: "media", label: "Hình ảnh", hint: "Ảnh chính bắt buộc: nền trắng, cạnh dài ≥ 1000px" },
  { key: "variation", label: "Phân loại (variation)", hint: "parentage_level + parent_sku + variation_theme" },
  { key: "sales_terms", label: "Offer & tồn kho", hint: "purchasable_offer + fulfillment_availability" },
];

export const FIELDS: FieldSpec[] = [
  {
    attribute: "item_name",
    label: "Tiêu đề (item_name)",
    kind: "title",
    group: "content",
    required: true,
    help: "≤ 75 ký tự (nhóm media 200). Không quảng cáo, không HOA cả từ, không lặp từ quá 2 lần.",
  },
  {
    attribute: "title_differentiation",
    label: "Item Highlight (title_differentiation)",
    kind: "highlight",
    group: "content",
    required: false,
    optional: true,
    help: "≤ 125 ký tự, chỉ dùng khi tiêu đề ≤ 75. Một số ngành hàng chưa hỗ trợ (Amazon trả 100476).",
  },
  {
    attribute: "bullet_point",
    label: "Bullet points",
    kind: "bullets",
    group: "content",
    required: true,
    help: "Tối đa 5 bullet; chính sách 10–255 ký tự/bullet (trần field 500). Chỉ ~1.000 byte đầu được index.",
  },
  {
    attribute: "product_description",
    label: "Mô tả (product_description)",
    kind: "textarea",
    group: "content",
    required: true,
    help: "≤ 2.000 ký tự, văn bản thuần (HTML không còn được hỗ trợ từ 07/2024).",
  },
  {
    attribute: "generic_keyword",
    label: "Từ khóa backend (generic_keyword)",
    kind: "textarea",
    group: "content",
    required: false,
    optional: true,
    help: "≤ 249 BYTE UTF-8 (US/UK/EU), 500 (JP), 200 (IN). Tiếng Việt có dấu tốn 2 byte/ký tự.",
  },
  {
    attribute: "brand",
    label: "Thương hiệu (brand)",
    kind: "text",
    group: "content",
    required: false,
    optional: true,
    help: "≤ 50 ký tự — tên thương hiệu đã đăng ký.",
  },
  {
    attribute: "item_type_keyword",
    label: "Item type keyword",
    kind: "text",
    group: "content",
    required: false,
    optional: true,
    help: "Phân loại sản phẩm theo browse node của Amazon.",
  },
  {
    attribute: "main_product_image_locator",
    label: "Ảnh chính",
    kind: "images",
    group: "media",
    required: true,
    help: "Nền trắng RGB 255,255,255, sản phẩm ≥ 85% khung, JPEG/PNG/GIF ≤ 10 MB.",
  },
  {
    attribute: "other_product_image_locator",
    label: "Ảnh phụ (tối đa 8)",
    kind: "images",
    group: "media",
    required: false,
    optional: true,
    help: "Tổng ảnh chính + phụ ≤ 9.",
  },
  {
    attribute: "parentage_level",
    label: "Cấp phân loại (parentage_level)",
    kind: "variation",
    group: "variation",
    required: false,
    optional: true,
    help: "NONE = sản phẩm đơn, PARENT = cha, CHILD = con (phải có parent_sku).",
  },
  {
    attribute: "variation_theme",
    label: "Chủ đề phân loại (variation_theme)",
    kind: "variation",
    group: "variation",
    required: false,
    optional: true,
    help: "Bắt buộc với sản phẩm cha, ví dụ COLOR/SIZE/COLOR_SIZE.",
  },
  {
    attribute: "purchasable_offer",
    label: "Offer (giá bán)",
    kind: "offer",
    group: "sales_terms",
    required: true,
    help: "Giá có thuế theo marketplace; list_price (giá niêm yết) phải ≥ giá bán.",
  },
  {
    attribute: "fulfillment_availability",
    label: "Tồn kho (fulfillment_availability)",
    kind: "fulfillment",
    group: "sales_terms",
    required: true,
    help: "Số lượng theo kênh. PATCH thay kênh sẽ GỘP kênh — phải gửi đủ mọi kênh đang có.",
  },
];

export const IMAGE_KEYS = [
  "main_product_image_locator",
  ...Array.from({ length: MAX_IMAGES - 1 }, (_, i) => `other_product_image_locator_${i + 1}`),
];

/**
 * URL ảnh hợp lệ: https, không khoảng trắng. Dùng CHUNG cho cổng validation (gửi
 * Amazon) và cho ảnh xem trước trong form — một luật, một chỗ sửa.
 */
export function isHttpsImageUrl(url: string): boolean {
  return /^https:\/\/[^\s]+$/i.test(url.trim());
}

export function isImageAttribute(attribute: string): boolean {
  return attribute === "main_product_image_locator" || /^other_product_image_locator_\d+$/.test(attribute);
}

export function imageAttributeLabel(attribute: string): string {
  if (attribute === "main_product_image_locator") return "Ảnh chính";
  return `Ảnh phụ ${attribute.split("_").pop()}`;
}

/* ------------------------------------------------------------------ */
/* Đọc/ghi payload (attribute getters & setters)                       */
/* ------------------------------------------------------------------ */

type ValueObject = { value?: unknown; name?: unknown; language_tag?: string; marketplace_id?: string };

function firstValueObject(payload: ListingDraftPayload, attribute: string): ValueObject | null {
  const arr = payload?.[attribute];
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const first = arr[0];
  return first && typeof first === "object" ? (first as ValueObject) : null;
}

export function getTextAttribute(payload: ListingDraftPayload, attribute: string): string {
  const obj = firstValueObject(payload, attribute);
  const v = obj?.value ?? obj?.name;
  return v == null ? "" : String(v);
}

export function setTextAttribute(
  payload: ListingDraftPayload,
  attribute: string,
  value: string,
  opts: { locale?: string; marketplaceId?: string } = {},
): ListingDraftPayload {
  const next: ListingDraftPayload = { ...payload };
  if (value.trim() === "") {
    delete next[attribute];
    return next;
  }
  next[attribute] = [
    {
      value,
      language_tag: opts.locale ?? "en_US",
      ...(opts.marketplaceId ? { marketplace_id: opts.marketplaceId } : {}),
    },
  ];
  return next;
}

export function getTextList(payload: ListingDraftPayload, attribute: string): string[] {
  const arr = payload?.[attribute];
  if (!Array.isArray(arr)) return [];
  return arr
    .map((entry) => {
      const v = entry && typeof entry === "object" ? ((entry as ValueObject).value ?? (entry as ValueObject).name) : entry;
      return v == null ? "" : String(v);
    })
    .filter((s) => s !== "");
}

export function setTextList(
  payload: ListingDraftPayload,
  attribute: string,
  values: string[],
  opts: { locale?: string; marketplaceId?: string } = {},
): ListingDraftPayload {
  const next: ListingDraftPayload = { ...payload };
  const clean = values.map((v) => v.trim()).filter((v) => v !== "");
  if (clean.length === 0) {
    delete next[attribute];
    return next;
  }
  next[attribute] = clean.map((value) => ({
    value,
    language_tag: opts.locale ?? "en_US",
    ...(opts.marketplaceId ? { marketplace_id: opts.marketplaceId } : {}),
  }));
  return next;
}

export function getImageUrls(payload: ListingDraftPayload, attribute: string): string[] {
  const arr = payload?.[attribute];
  if (!Array.isArray(arr)) return [];
  return arr
    .map((entry) => {
      if (entry && typeof entry === "object") {
        const obj = entry as { media_location?: unknown; value?: unknown };
        return String(obj.media_location ?? obj.value ?? "");
      }
      return String(entry ?? "");
    })
    .filter((s) => s !== "");
}

export function setImageUrls(payload: ListingDraftPayload, attribute: string, urls: string[]): ListingDraftPayload {
  const next: ListingDraftPayload = { ...payload };
  const clean = urls.map((u) => u.trim()).filter((u) => u !== "");
  if (clean.length === 0) {
    delete next[attribute];
    return next;
  }
  next[attribute] = clean.map((media_location) => ({ media_location }));
  return next;
}

export type OfferInput = {
  audience?: string;
  currency?: string;
  price?: number | null;
  listPrice?: number | null;
};

function scheduleValueWithTax(node: unknown): unknown {
  if (Array.isArray(node)) {
    const first = node[0] as Record<string, unknown> | undefined;
    const schedule = Array.isArray(first?.schedule) ? (first?.schedule as Record<string, unknown>[]) : [];
    return schedule[0]?.value_with_tax ?? first?.value_with_tax;
  }
  if (node && typeof node === "object") {
    return (node as Record<string, unknown>).value_with_tax;
  }
  return undefined;
}

export function getOffer(payload: ListingDraftPayload): {
  audience: string;
  currency: string;
  price: string;
  listPrice: string;
} {
  const arr = payload?.purchasable_offer;
  const offer = Array.isArray(arr) && arr[0] && typeof arr[0] === "object" ? (arr[0] as Record<string, unknown>) : null;
  const price = scheduleValueWithTax(offer?.our_price);
  const listPrice = scheduleValueWithTax(offer?.list_price);
  return {
    audience: offer?.audience == null ? "" : String(offer.audience),
    currency: offer?.currency == null ? "" : String(offer.currency),
    price: price == null ? "" : String(price),
    listPrice: listPrice == null ? "" : String(listPrice),
  };
}

export function setOffer(payload: ListingDraftPayload, input: OfferInput): ListingDraftPayload {
  const current = getOffer(payload);
  const audience = input.audience ?? current.audience ?? "ALL";
  const currency = input.currency ?? current.currency ?? "USD";
  const price = input.price !== undefined ? input.price : parsePrice(current.price);
  const listPrice = input.listPrice !== undefined ? input.listPrice : parsePrice(current.listPrice);
  const next: ListingDraftPayload = { ...payload };
  if (price == null && listPrice == null) {
    delete next.purchasable_offer;
    return next;
  }
  const offer: Record<string, unknown> = { audience, currency };
  if (price != null) offer.our_price = [{ schedule: [{ value_with_tax: price }] }];
  if (listPrice != null) offer.list_price = [{ schedule: [{ value_with_tax: listPrice }] }];
  next.purchasable_offer = [offer];
  return next;
}

export function getFulfillment(payload: ListingDraftPayload): { channel: string; quantity: string } {
  const arr = payload?.fulfillment_availability;
  const row = Array.isArray(arr) && arr[0] && typeof arr[0] === "object" ? (arr[0] as Record<string, unknown>) : null;
  return {
    channel: String(row?.fulfillment_channel_code ?? "DEFAULT"),
    quantity: row?.quantity == null ? "" : String(row.quantity),
  };
}

export function setFulfillment(
  payload: ListingDraftPayload,
  input: { channel?: string; quantity?: number | null },
): ListingDraftPayload {
  const current = getFulfillment(payload);
  const next: ListingDraftPayload = { ...payload };
  if (input.quantity === null) {
    delete next.fulfillment_availability;
    return next;
  }
  const channel = input.channel ?? current.channel ?? "DEFAULT";
  const quantity = input.quantity !== undefined ? input.quantity : Number(current.quantity);
  next.fulfillment_availability = [
    { fulfillment_channel_code: channel, quantity: Number.isFinite(quantity) ? quantity : 0 },
  ];
  return next;
}

export function getVariationTheme(payload: ListingDraftPayload): string {
  return getTextAttribute(payload, "variation_theme");
}

export function setVariationTheme(payload: ListingDraftPayload, theme: string): ListingDraftPayload {
  return setTextAttribute(payload, "variation_theme", theme);
}

export function getParentageLevel(payload: ListingDraftPayload): ParentageLevel | "" {
  const raw = getTextAttribute(payload, "parentage_level").toUpperCase();
  if (raw === "PARENT" || raw === "CHILD" || raw === "NONE") return raw;
  return "";
}

export function setParentageLevel(payload: ListingDraftPayload, level: ParentageLevel): ListingDraftPayload {
  const next = setTextAttribute(payload, "parentage_level", level);
  if (level !== "CHILD") delete next.child_parent_sku_relationship;
  return next;
}

/** parent_sku nằm trong child_parent_sku_relationship[0].parent_sku (KHÔNG phải .value). */
export function getParentSku(payload: ListingDraftPayload): string {
  const arr = payload?.child_parent_sku_relationship;
  if (!Array.isArray(arr) || !arr[0] || typeof arr[0] !== "object") return "";
  const rel = arr[0] as Record<string, unknown>;
  const value = rel.parent_sku ?? rel.value;
  return value == null ? "" : String(value);
}

export function setParentSku(payload: ListingDraftPayload, parentSku: string): ListingDraftPayload {
  const next: ListingDraftPayload = { ...payload };
  const clean = parentSku.trim();
  if (!clean) {
    delete next.child_parent_sku_relationship;
    return next;
  }
  next.child_parent_sku_relationship = [{ child_relationship_type: "VARIATION", parent_sku: clean }];
  return next;
}

/** Payload rỗng có sẵn tiêu đề — dùng khi bắt đầu soạn SKU mới. */
export function createEmptyDraftPayload(input: {
  marketplaceId: string;
  locale: string;
  itemName?: string;
  currency?: string;
}): ListingDraftPayload {
  let payload: ListingDraftPayload = {};
  if (input.itemName) {
    payload = setTextAttribute(payload, "item_name", input.itemName, {
      locale: input.locale,
      marketplaceId: input.marketplaceId,
    });
  }
  return payload;
}

/* ------------------------------------------------------------------ */
/* Giá                                                               */
/* ------------------------------------------------------------------ */

/**
 * Đọc giá người dùng nhập theo cả 2 kiểu: "1.234,56" (VN) và "1,234.56" (US).
 * Trả null nếu không phải số.
 */
export function parsePrice(input: string): number | null {
  const raw = input.trim().replace(/[^\d.,-]/g, "");
  if (!raw || !/\d/.test(raw)) return null;
  const lastComma = raw.lastIndexOf(",");
  const lastDot = raw.lastIndexOf(".");

  let normalized = raw;
  if (lastComma >= 0 && lastDot >= 0) {
    normalized = lastComma > lastDot ? raw.replace(/\./g, "").replace(",", ".") : raw.replace(/,/g, "");
  } else if (lastComma >= 0) {
    // "129,99" → 129.99 nhưng "1,234" → 1234 (dấu nghìn)
    normalized = /^\d{1,3},\d{2}$/.test(raw) ? raw.replace(",", ".") : raw.replace(/,/g, "");
  } else if ((raw.match(/\./g) ?? []).length > 1) {
    normalized = raw.replace(/\./g, "");
  }

  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

export function formatPrice(value: number | null, currency = "USD"): string {
  if (value == null || !Number.isFinite(value)) return "";
  return `${value.toFixed(2)} ${currency}`;
}

/* ------------------------------------------------------------------ */
/* Kiểm tra (validation)                                              */
/* ------------------------------------------------------------------ */

export type ValidateInput = {
  payload: ListingDraftPayload;
  productType: string;
  marketplaceId: string;
  locale?: string;
  requirements?: ListingRequirements;
  /** JSON Schema đã tải từ schema.link.resource (Product Type Definitions API) */
  productTypeSchema?: unknown;
  brand?: string | null;
  /** Ép nhóm media khi không đoán được từ product type */
  mediaOverride?: boolean;
  now?: Date;
};

const WORDS_SPLIT = /[^\p{L}\p{N}]+/u;

function significantWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(WORDS_SPLIT)
    .filter((w) => w.length > 0);
}

export function validateListingDraft(input: ValidateInput): ValidationReport {
  const {
    payload,
    productType,
    marketplaceId,
    requirements = "LISTING",
    productTypeSchema = null,
    now = new Date(),
  } = input;

  const schemaLimits: ProductTypeSchemaLimits | null = readSchemaLimits(productTypeSchema);
  const isMedia = input.mediaOverride ?? isMediaProductType(productType);
  const source: ValidationReport["source"] = schemaLimits ? "amazon-schema+vexim-policy" : "vexim-policy";
  const issues: ValidationIssue[] = [];
  const limits: Record<string, ValidationLimitUsage> = {};

  const push = (issue: Omit<ValidationIssue, "attributeName"> & { attributeName?: string }) =>
    issues.push({ ...issue, attributeName: issue.attributeName ?? "" });
  const err = (
    code: string,
    attributeName: string | undefined,
    message: string,
    opts: { hint?: string; amazonCode?: string; sourceId?: keyof typeof AMAZON_SOURCES } = {},
  ) => push({ code, severity: "ERROR", attributeName, message, ...opts });
  const warn = (
    code: string,
    attributeName: string | undefined,
    message: string,
    opts: { hint?: string; sourceId?: keyof typeof AMAZON_SOURCES } = {},
  ) => push({ code, severity: "WARNING", attributeName, message, ...opts });
  const info = (
    code: string,
    attributeName: string | undefined,
    message: string,
    opts: { hint?: string; sourceId?: keyof typeof AMAZON_SOURCES } = {},
  ) => push({ code, severity: "INFO", attributeName, message, ...opts });

  const missing = (attribute: string) => !Array.isArray(payload[attribute]) || (payload[attribute] as unknown[]).length === 0;

  const trackLimit = (attribute: string, used: number): ResolvedLimit => {
    const resolved = resolveLimit(attribute, schemaLimits, { market: marketplaceId, productType });
    const fallback = TEXT_LIMIT_BY_ATTRIBUTE[attribute];
    limits[attribute] = {
      label: fallback?.label ?? attribute,
      max: resolved.max,
      used,
      unit: resolved.unit,
      source: resolved.source,
      note: resolved.note,
    };
    return resolved;
  };

  /* --- 1. Thuộc tính bắt buộc (chính sách VEXIM + schema Amazon) --- */
  if (missing("item_name")) err("VEXIM-REQUIRED", "item_name", "Thiếu tiêu đề (item_name)", { amazonCode: "90220" });
  if (missing("bullet_point")) err("VEXIM-REQUIRED", "bullet_point", "Cần ít nhất 1 bullet point", { amazonCode: "90220" });
  if (missing("product_description")) {
    err("VEXIM-REQUIRED", "product_description", "Thiếu mô tả sản phẩm", { amazonCode: "90220" });
  }
  if (missing("main_product_image_locator")) {
    err("VEXIM-IMAGE-MAIN-REQUIRED", "main_product_image_locator", "Thiếu ảnh chính", {
      hint: "Ảnh chính là điều kiện bắt buộc để listing được hiển thị.",
    });
  }
  if (missing("purchasable_offer")) {
    err("VEXIM-REQUIRED", "purchasable_offer", "Thiếu offer (giá bán)", { amazonCode: "4002005" });
  }
  if (missing("fulfillment_availability")) {
    err("VEXIM-REQUIRED", "fulfillment_availability", "Thiếu tồn kho (fulfillment_availability)", {
      amazonCode: "4002005",
    });
  }

  for (const attribute of schemaLimits?.requiredAttributes ?? []) {
    if (missing(attribute)) {
      const covered = COVERED_ATTRIBUTES.includes(attribute);
      err("VEXIM-REQUIRED", attribute, `Amazon bắt buộc thuộc tính "${attribute}" theo schema product type`, {
        hint: covered ? undefined : "Form L3 chưa có trường này — bổ sung bằng Seller Central trước khi publish.",
        sourceId: "product_type_definitions",
      });
    }
  }

  /* --- 2. Hạn mức độ dài --- */
  const title = getTextAttribute(payload, "item_name");
  if (title) {
    const resolved = trackLimit("item_name", charCount(title));
    if (resolved.max != null && charCount(title) > resolved.max) {
      err("VEXIM-MAX-LENGTH", "item_name", `Tiêu đề ${charCount(title)} ký tự, vượt hạn mức ${resolved.max} ký tự`, {
        hint: isMedia
          ? "Nhóm media (sách/nhạc/video) được 200 ký tự."
          : "Từ 27/07/2026 tiêu đề tối đa 75 ký tự (tính cả dấu cách).",
        sourceId: "title_requirements",
      });
    }
    const banned = findBannedTitleChars(title, input.brand);
    if (banned.length > 0) {
      err("VEXIM-TITLE-BANNED-CHAR", "item_name", `Tiêu đề chứa ký tự Amazon chặn: ${banned.join(" ")}`, {
        hint: "Amazon sẽ tự sửa tiêu đề và có thể làm sai nội dung — bỏ các ký tự này.",
        sourceId: "title_requirements",
      });
    }
    const promo = findPromotionalPhrases(title);
    if (promo.length > 0) {
      err("VEXIM-TITLE-PROMO", "item_name", `Tiêu đề chứa cụm từ quảng cáo: ${promo.join(", ")}`, {
        hint: "Amazon coi là spam tiêu đề và có thể tự viết lại.",
        sourceId: "title_requirements",
      });
    }
    const repeated = repeatedTitleWords(title);
    if (repeated.length > 0) {
      warn(
        "VEXIM-TITLE-REPEAT",
        "item_name",
        `Từ lặp quá 2 lần: ${repeated.map((r) => `${r.word} ×${r.count}`).join(", ")}`,
        { hint: "Amazon chỉ cho phép lặp tối đa 2 lần (trừ từ nối).", sourceId: "title_requirements" },
      );
    }
    if (isAllCaps(title)) {
      warn("VEXIM-TITLE-ALLCAPS", "item_name", "Tiêu đề viết HOA toàn bộ", { sourceId: "title_requirements" });
    }
  }

  const highlight = getTextAttribute(payload, "title_differentiation");
  if (highlight) {
    const resolved = trackLimit("title_differentiation", charCount(highlight));
    if (resolved.max != null && charCount(highlight) > resolved.max) {
      err(
        "VEXIM-MAX-LENGTH",
        "title_differentiation",
        `Item Highlight ${charCount(highlight)} ký tự, vượt ${resolved.max} ký tự`,
        { sourceId: "item_highlights" },
      );
    }
    if (title && charCount(title) > 75 && !isMedia) {
      err(
        "VEXIM-HIGHLIGHT-TITLE-BLOCKED",
        "title_differentiation",
        "Item Highlight chỉ hiển thị khi tiêu đề ≤ 75 ký tự",
        { hint: "Rút ngắn tiêu đề hoặc bỏ Item Highlight.", sourceId: "item_highlights" },
      );
    }
    // Trùng lặp: chỉ cảnh báo khi trùng ≥ 2 từ có nghĩa với tiêu đề
    const titleWords = new Set(significantWords(title).filter((w) => w.length >= 4));
    const shared = [...new Set(significantWords(highlight).filter((w) => w.length >= 4 && titleWords.has(w)))];
    if (shared.length >= 2) {
      warn(
        "VEXIM-HIGHLIGHT-DUPLICATE",
        "title_differentiation",
        `Item Highlight lặp từ với tiêu đề: ${shared.join(", ")}`,
        { hint: "Nên bổ sung thông tin khác với tiêu đề (chất liệu, công dụng, kích thước).", sourceId: "item_highlights" },
      );
    }
  }

  const bullets = getTextList(payload, "bullet_point");
  if (bullets.length > 0) {
    const resolved = trackLimit("bullet_point", Math.max(...bullets.map((b) => charCount(b))));
    const policyMax = 255;
    const policyMin = 10;
    if (bullets.length > MAX_BULLETS) {
      err("VEXIM-BULLET-COUNT", "bullet_point", `${bullets.length} bullet, Amazon chỉ nhận tối đa ${MAX_BULLETS}`, {
        sourceId: "bullet_policy",
      });
    }
    bullets.forEach((bullet, index) => {
      const len = charCount(bullet);
      if (resolved.max != null && len > resolved.max) {
        err("VEXIM-MAX-LENGTH", "bullet_point", `Bullet ${index + 1} dài ${len} ký tự (trần field ${resolved.max})`, {
          sourceId: "bullet_policy",
        });
      } else if (len > policyMax) {
        warn(
          "VEXIM-POLICY-LENGTH",
          "bullet_point",
          `Bullet ${index + 1} dài ${len} ký tự — chính sách Amazon yêu cầu ≤ ${policyMax}`,
          { hint: "Bullet dài dễ bị cắt trên mobile và có thể bị Amazon sửa.", sourceId: "bullet_policy" },
        );
      }
      if (len > 0 && len < policyMin) {
        warn(
          "VEXIM-POLICY-MIN-LENGTH",
          "bullet_point",
          `Bullet ${index + 1} chỉ ${len} ký tự — chính sách yêu cầu ≥ ${policyMin}`,
          { sourceId: "bullet_policy" },
        );
      }
      if (/[.!;:]$/.test(bullet.trim())) {
        info("VEXIM-BULLET-PUNCTUATION", "bullet_point", `Bullet ${index + 1} kết thúc bằng dấu câu`, {
          hint: "Amazon khuyến nghị không dùng dấu câu cuối bullet.",
          sourceId: "bullet_policy",
        });
      }
      if (/\p{Extended_Pictographic}/u.test(bullet)) {
        warn("VEXIM-BULLET-EMOJI", "bullet_point", `Bullet ${index + 1} chứa emoji`, { sourceId: "bullet_policy" });
      }
    });
  }

  const description = getTextAttribute(payload, "product_description");
  if (description) {
    const resolved = trackLimit("product_description", charCount(description));
    if (resolved.max != null && charCount(description) > resolved.max) {
      err(
        "VEXIM-MAX-LENGTH",
        "product_description",
        `Mô tả ${charCount(description)} ký tự, vượt ${resolved.max} ký tự`,
        { sourceId: "listings_items" },
      );
    }
    if (hasHtmlTags(description)) {
      err("VEXIM-DESC-HTML", "product_description", "Mô tả còn thẻ HTML", {
        hint: "Amazon ngừng hỗ trợ HTML từ 07/2024 — thẻ có thể hiển thị nguyên văn.",
        sourceId: "listings_items",
      });
    }
  }

  const keywords = getTextAttribute(payload, "generic_keyword");
  if (keywords) {
    const used = utf8Bytes(keywords);
    const resolved = trackLimit("generic_keyword", used);
    info("VEXIM-KEYWORD-BYTES", "generic_keyword", `Từ khóa backend dùng ${used}/${resolved.max ?? "?"} byte`, {
      sourceId: "search_terms",
    });
    if (resolved.max != null && used > resolved.max) {
      err(
        "VEXIM-MAX-LENGTH",
        "generic_keyword",
        `Từ khóa backend ${used} byte, vượt ${resolved.max} byte của marketplace này`,
        {
          hint: "Giới hạn là BYTE UTF-8 (tiếng Việt có dấu tốn 2 byte/ký tự). Vượt 1 byte là Amazon bỏ toàn bộ từ khóa.",
          sourceId: "search_terms",
        },
      );
    }
    if (keywords !== keywords.trim() || /\s{2,}/.test(keywords)) {
      info("VEXIM-KEYWORD-WHITESPACE", "generic_keyword", "Từ khóa có khoảng trắng thừa", {
        sourceId: "search_terms",
      });
    }
    if (/[!$?_^{}¬¦,;.]/.test(keywords)) {
      warn("VEXIM-KEYWORD-PUNCTUATION", "generic_keyword", "Từ khóa chứa dấu câu/ký tự đặc biệt", {
        hint: "Không dùng dấu phẩy hay ký tự đặc biệt giữa các từ khóa.",
        sourceId: "search_terms",
      });
    }
    const titleWordSet = new Set(significantWords(title));
    const duplicated = [...new Set(significantWords(keywords).filter((w) => w.length >= 4 && titleWordSet.has(w)))];
    if (duplicated.length > 0) {
      warn(
        "VEXIM-KEYWORD-DUPLICATE",
        "generic_keyword",
        `Từ khóa lặp với tiêu đề: ${duplicated.join(", ")}`,
        { hint: "Từ khóa backend không cần lặp lại từ đã có trong tiêu đề.", sourceId: "search_terms" },
      );
    }
  }

  /* --- 3. Hình ảnh --- */
  const imageAttributes = Object.keys(payload).filter(isImageAttribute);
  const allImages = imageAttributes.flatMap((attribute) => getImageUrls(payload, attribute));
  if (allImages.length > MAX_IMAGES) {
    err("VEXIM-IMAGE-COUNT", "main_product_image_locator", `${allImages.length} ảnh, Amazon tối đa ${MAX_IMAGES} (1 chính + 8 phụ)`);
  }
  for (const attribute of imageAttributes) {
    for (const url of getImageUrls(payload, attribute)) {
      if (!isHttpsImageUrl(url)) {
        err("VEXIM-IMAGE-URL", attribute, `Ảnh "${url.slice(0, 60)}" không phải URL https hợp lệ`, {
          hint: "URL ảnh phải là https và trỏ trực tiếp tới file JPEG/PNG/GIF.",
        });
      }
    }
  }

  /* --- 4. Offer / tồn kho --- */
  const offer = getOffer(payload);
  if (!missing("purchasable_offer")) {
    if (!offer.audience) {
      err("VEXIM-OFFER-AUDIENCE", "purchasable_offer", "Offer thiếu audience (thường là ALL)", {
        amazonCode: "4002005",
      });
    }
    if (!offer.currency) err("VEXIM-OFFER-CURRENCY", "purchasable_offer", "Offer thiếu currency", { amazonCode: "4002005" });
    const price = parsePrice(offer.price);
    if (price == null || price <= 0) {
      err("VEXIM-OFFER-PRICE", "purchasable_offer", "Giá bán phải là số > 0", { amazonCode: "4002005" });
    }
    const listPrice = offer.listPrice === "" ? null : parsePrice(offer.listPrice);
    if (listPrice != null && price != null && listPrice < price) {
      warn("VEXIM-OFFER-LIST-PRICE", "purchasable_offer", "Giá niêm yết (list_price) thấp hơn giá bán", {
        hint: "Amazon có thể bỏ giá niêm yết.",
      });
    }
  }

  const fulfillment = getFulfillment(payload);
  if (!missing("fulfillment_availability")) {
    const qty = Number(fulfillment.quantity);
    if (fulfillment.quantity === "" || !Number.isFinite(qty) || qty < 0 || !Number.isInteger(qty)) {
      err("VEXIM-FULFILLMENT-QTY", "fulfillment_availability", "Số lượng tồn kho phải là số nguyên ≥ 0");
    } else if (qty === 0) {
      warn("VEXIM-FULFILLMENT-ZERO", "fulfillment_availability", "Tồn kho = 0 → listing sẽ không bán được", {
        hint: "Nhập > 0 nếu còn hàng.",
      });
    }
  }

  /* --- 5. Variation --- */
  const parentage = getParentageLevel(payload);
  if (parentage === "CHILD") {
    if (!getParentSku(payload)) {
      err(
        "VEXIM-VARIATION-PARENT-SKU",
        "child_parent_sku_relationship",
        "Sản phẩm con (CHILD) phải có parent_sku",
        {
          hint: 'child_parent_sku_relationship[0] = {child_relationship_type:"VARIATION", parent_sku:"..."}',
          sourceId: "product_type_definitions",
        },
      );
    }
    if (!getVariationTheme(payload)) {
      warn("VEXIM-VARIATION-THEME", "variation_theme", "Sản phẩm con nên có variation_theme", {
        sourceId: "product_type_definitions",
      });
    }
  } else if (parentage === "PARENT") {
    if (!getVariationTheme(payload)) {
      err("VEXIM-VARIATION-THEME", "variation_theme", "Sản phẩm cha (PARENT) bắt buộc có variation_theme", {
        sourceId: "product_type_definitions",
      });
    }
  } else if (getParentSku(payload)) {
    warn(
      "VEXIM-VARIATION-PARENT-SKU",
      "child_parent_sku_relationship",
      "Có parent_sku nhưng parentage_level không phải CHILD",
      { hint: "Đặt parentage_level = CHILD hoặc bỏ parent_sku.", sourceId: "product_type_definitions" },
    );
  }

  /* --- 6. Nguồn hạn mức --- */
  if (schemaLimits) {
    info(
      "VEXIM-SCHEMA-APPLIED",
      undefined,
      `Đã đối chiếu JSON Schema product type ${schemaLimits.productType ?? productType} (schemaVersion ${schemaLimits.schemaVersion ?? "?"})`,
      { sourceId: "product_type_definitions" },
    );
  } else {
    info(
      "VEXIM-SCHEMA-MISSING",
      undefined,
      "Chưa có schema Amazon cho product type này — đang áp hạn mức mặc định theo tài liệu Amazon",
      {
        hint: "Worker sẽ tải schema qua getDefinitionsProductType (Product Type Definitions API 2020-09-01) để kiểm tra chính xác hơn.",
        sourceId: "product_type_definitions",
      },
    );
  }

  const errorCount = issues.filter((i) => i.severity === "ERROR").length;
  const warningCount = issues.filter((i) => i.severity === "WARNING").length;
  const infoCount = issues.filter((i) => i.severity === "INFO").length;

  return {
    checkedAt: now.toISOString(),
    productType,
    marketplaceId,
    source,
    ok: errorCount === 0,
    errorCount,
    warningCount,
    infoCount,
    issues,
    limits,
  };
}

/* ------------------------------------------------------------------ */
/* Máy trạng thái Draft → duyệt → Publish                              */
/* ------------------------------------------------------------------ */

export const DRAFT_TRANSITIONS: Record<DraftStatus, DraftStatus[]> = {
  draft: ["pending_approval"],
  pending_approval: ["approved", "rejected", "draft"],
  approved: ["publishing", "draft"],
  rejected: ["draft", "pending_approval"],
  publishing: ["published", "failed"],
  published: ["draft"],
  failed: ["draft", "pending_approval"],
};

export function canTransition(from: DraftStatus, to: DraftStatus): boolean {
  return (DRAFT_TRANSITIONS[from] ?? []).includes(to);
}

export function isEditable(status: DraftStatus): boolean {
  return status === "draft" || status === "rejected" || status === "failed";
}

export type ActionKey = "save" | "submit" | "withdraw" | "approve" | "reject" | "reopen" | "publish";

export type ActionDescriptor = {
  action: ActionKey;
  label: string;
  needsNote?: boolean;
  enabled: boolean;
  disabledReason?: string;
};

export type ActorContext = {
  userId?: string | null;
  canWrite: boolean;
  isApprover: boolean;
};

export type DraftLike = {
  status: DraftStatus;
  createdBy?: string | null;
  submittedBy?: string | null;
  validationErrorCount?: number | null;
};

/**
 * Hành động khả dụng theo trạng thái + vai trò.
 * Luật 4 mắt: người GỬI không tự duyệt bản của mình — kể cả khi họ cũng là
 * trưởng phòng (DB trigger 0014 chặn lần nữa ở tầng dữ liệu).
 */
export function availableActions(draft: DraftLike, actor: ActorContext): ActionDescriptor[] {
  const out: ActionDescriptor[] = [];
  const errors = draft.validationErrorCount ?? 0;
  const isSubmitter = Boolean(
    actor.userId && (draft.submittedBy ?? draft.createdBy) && actor.userId === (draft.submittedBy ?? draft.createdBy),
  );
  const canApprove = actor.isApprover && !isSubmitter;
  const notWriter = !actor.canWrite ? "Không có quyền ghi trên shop này" : undefined;

  switch (draft.status) {
    case "draft":
    case "rejected":
    case "failed": {
      out.push({ action: "save", label: "Lưu nháp", enabled: actor.canWrite, disabledReason: notWriter });
      out.push({
        action: "submit",
        label: "Gửi trưởng phòng duyệt",
        enabled: actor.canWrite && errors === 0,
        disabledReason: notWriter ?? (errors > 0 ? `Còn ${errors} lỗi ERROR — sửa hết trước khi gửi duyệt` : undefined),
      });
      break;
    }
    case "pending_approval": {
      if (isSubmitter && (actor.canWrite || actor.isApprover)) {
        out.push({ action: "withdraw", label: "Rút lại để sửa", enabled: true });
      }
      if (canApprove) {
        out.push({ action: "approve", label: "Duyệt", needsNote: true, enabled: true });
        out.push({ action: "reject", label: "Từ chối", needsNote: true, enabled: true });
      }
      break;
    }
    case "approved": {
      out.push({
        action: "publish",
        label: "Publish lên Amazon",
        enabled: actor.isApprover || actor.canWrite,
        disabledReason: "Cần quyền ghi shop hoặc vai trò duyệt",
      });
      out.push({
        action: "withdraw",
        label: "Thu hồi về nháp",
        enabled: actor.canWrite || actor.isApprover,
        disabledReason: "Cần quyền ghi shop hoặc vai trò duyệt",
      });
      break;
    }
    case "publishing": {
      out.push({
        action: "withdraw",
        label: "Chờ worker phản hồi",
        enabled: false,
        disabledReason: "Đã gửi Amazon — chờ kết quả ACCEPTED/INVALID từ worker",
      });
      break;
    }
    case "published": {
      out.push({
        action: "reopen",
        label: "Tạo bản sửa mới",
        enabled: actor.canWrite || actor.isApprover,
        disabledReason: "Cần quyền ghi shop hoặc vai trò duyệt",
      });
      break;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Payload gửi SP-API                                                 */
/* ------------------------------------------------------------------ */

export type PatchOperation = { op: "add" | "replace" | "delete"; path: string; value?: unknown };
export type ListingsItemPatchBody = { productType: string; patches: PatchOperation[] };
export type ListingsItemPutBody = {
  productType: string;
  requirements: ListingRequirements;
  attributes: ListingDraftPayload;
};

function dropUndefined(payload: ListingDraftPayload): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const [key, value] of Object.entries(payload ?? {})) {
    if (value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value as unknown[];
  }
  return out;
}

/** Danh sách attribute đã đổi giữa 2 payload (so từng key). */
export function diffPayload(
  before: ListingDraftPayload | null | undefined,
  after: ListingDraftPayload | null | undefined,
): string[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const changed: string[] = [];
  for (const key of keys) {
    const a = before?.[key];
    const b = after?.[key];
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) changed.push(key);
  }
  return changed.sort();
}

/**
 * Body cho patchListingsItem — JSON Patch (RFC 6902) ở mức TOÀN BỘ attribute:
 * Amazon không nhận patch từng phần trong một attribute; bỏ attribute thì gửi
 * op "delete" kèm value tối thiểu (marketplace + language) để định danh ngữ cảnh.
 * `marketplaceIds` là QUERY PARAM của SP-API — không nằm trong body này.
 */
export function buildPatchBody(input: {
  productType: string;
  marketplaceId: string;
  locale?: string;
  changedAttributes: Iterable<string>;
  payload: ListingDraftPayload;
}): ListingsItemPatchBody {
  const locale = input.locale ?? "en_US";
  const patches: PatchOperation[] = [];
  for (const attribute of input.changedAttributes) {
    const value = input.payload?.[attribute];
    if (value === undefined || (Array.isArray(value) && value.length === 0)) {
      patches.push({
        op: "delete",
        path: `/attributes/${attribute}`,
        value: [{ marketplace_id: input.marketplaceId, language_tag: locale }],
      });
    } else {
      patches.push({ op: "replace", path: `/attributes/${attribute}`, value });
    }
  }
  return { productType: input.productType, patches };
}

/** Body cho putListingsItem — tạo mới hoặc ghi đè toàn bộ product facts. */
export function buildPutBody(input: {
  productType: string;
  requirements: ListingRequirements;
  payload: ListingDraftPayload;
}): ListingsItemPutBody {
  return {
    productType: input.productType,
    requirements: input.requirements,
    attributes: dropUndefined(input.payload),
  };
}

/* ------------------------------------------------------------------ */
/* Feed JSON_LISTINGS_FEED (gửi lô lớn)                                */
/* ------------------------------------------------------------------ */

export type ListingsFeedMessageInput = {
  sku: string;
  operationType: "PATCH" | "UPDATE" | "DELETE" | string;
  productType: string;
  requirements?: ListingRequirements;
  /** PATCH: danh sách JSON Patch đã dựng */
  patches?: PatchOperation[];
  /** UPDATE: toàn bộ attributes (thay thế giá trị cũ) */
  attributes?: ListingDraftPayload;
};

export type ListingsFeedMessage = ListingsFeedMessageInput & { messageId: number };

export type ListingsFeedDocument = {
  header: { sellerId: string; version: "2.0"; locale: string };
  messages: ListingsFeedMessage[];
};

/**
 * Dựng document cho JSON_LISTINGS_FEED (schema listings-feed-schema-v2).
 * Giới hạn đã kiểm chứng: tối đa 25.000 message/feed — vượt là Amazon từ chối
 * TOÀN BỘ feed, nên chặn ngay ở tầng dựng document.
 */
export function buildFeedDocument(input: {
  sellerId: string;
  locale?: string;
  messages: ListingsFeedMessageInput[];
}): ListingsFeedDocument {
  if (input.messages.length > MAX_FEED_MESSAGES) {
    throw new Error(
      `JSON_LISTINGS_FEED tối đa ${MAX_FEED_MESSAGES.toLocaleString("vi-VN")} message/feed — đang có ${input.messages.length.toLocaleString("vi-VN")}. Chia thành nhiều feed.`,
    );
  }
  return {
    header: { sellerId: input.sellerId, version: "2.0", locale: input.locale ?? "en_US" },
    messages: input.messages.map((message, index) => ({ ...message, messageId: index + 1 })),
  };
}

/** Lô nhỏ → patchListingsItem (đồng bộ); lô lớn → feed (rate limit 5 req/s). */
export function pickSubmissionMethod(skuCount: number, threshold = 100): "patch" | "feed" {
  return skuCount > threshold ? "feed" : "patch";
}

/* ------------------------------------------------------------------ */
/* Cổng publish — kiểm tra hạn chế danh mục trước khi gửi              */
/* ------------------------------------------------------------------ */

/**
 * Kết quả getListingsRestrictions do WORKER trả về (web không gọi SP-API).
 * reasonCodes ∈ APPROVAL_REQUIRED | ASIN_NOT_FOUND | NOT_ELIGIBLE (rỗng = OK).
 */
export type PublishRestrictions = {
  checkedAt: string;
  marketplaceId: string;
  asin: string | null;
  reasonCodes: string[];
  messages: string[];
  approvalLinks: string[];
};

export type PublishGate = {
  ok: boolean;
  blockers: string[];
  warnings: string[];
};

export const RESTRICTION_REASON_LABEL: Record<string, string> = {
  APPROVAL_REQUIRED: "Danh mục cần Amazon phê duyệt trước khi đăng bán",
  ASIN_NOT_FOUND: "Không tìm thấy ASIN trong catalog Amazon",
  NOT_ELIGIBLE: "Shop không đủ điều kiện bán ASIN này",
};

export function checkPublishGate(input: {
  status: DraftStatus;
  validation: Pick<ValidationReport, "errorCount" | "ok"> | null;
  restrictions: PublishRestrictions | null;
  isNewListing: boolean;
  requirements?: ListingRequirements;
  asin?: string | null;
}): PublishGate {
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (input.status !== "approved") {
    blockers.push(
      `Bản nháp đang ở trạng thái "${DRAFT_STATUS_LABEL[input.status]}" — chỉ publish bản đã được trưởng phòng duyệt.`,
    );
  }

  const errorCount = input.validation?.errorCount ?? null;
  if (errorCount == null) {
    blockers.push("Chưa có kết quả kiểm tra hạn mức — bấm Kiểm tra trước khi publish.");
  } else if (errorCount > 0) {
    blockers.push(`Còn ${errorCount} lỗi ERROR theo hạn mức Amazon — sửa hết rồi gửi duyệt lại.`);
  }

  if ((input.requirements === "LISTING_OFFER_ONLY" || input.requirements === "OFFER") && !input.asin) {
    blockers.push("Luồng offer-only bắt buộc có ASIN của sản phẩm đã tồn tại trong catalog Amazon.");
  }

  const restrictions = input.restrictions;

  if (!restrictions || !restrictions.checkedAt) {
    // Listing đã tồn tại trên Amazon bắt buộc kiểm tra hạn chế trước khi publish
    if (!input.isNewListing) {
      warnings.push(
        `Chưa kiểm tra hạn chế danh mục${input.asin ? ` cho ASIN ${input.asin}` : ""} — worker phải gọi getListingsRestrictions (Listings Restrictions API 2021-08-01) trước khi publish.`,
      );
    }
  } else {
    restrictions.reasonCodes.forEach((code, index) => {
      const detail = restrictions.messages[index] ?? "";
      const link = restrictions.approvalLinks[index] ?? restrictions.approvalLinks[0] ?? "";
      if (code === "APPROVAL_REQUIRED") {
        blockers.push(
          `Cần Amazon phê duyệt danh mục [APPROVAL_REQUIRED]: ${detail || RESTRICTION_REASON_LABEL.APPROVAL_REQUIRED}. Mở link để gửi yêu cầu phê duyệt: ${link}`,
        );
      } else if (code === "ASIN_NOT_FOUND") {
        blockers.push(`Không tìm thấy ASIN [ASIN_NOT_FOUND]: ${detail || RESTRICTION_REASON_LABEL.ASIN_NOT_FOUND}`);
      } else {
        blockers.push(`Amazon hạn chế danh mục [${code}]: ${detail || RESTRICTION_REASON_LABEL[code] || "không rõ lý do"}`);
      }
    });
  }

  return { ok: blockers.length === 0, blockers, warnings };
}

/* ------------------------------------------------------------------ */
/* Tổng hợp cho danh sách / KPI                                        */
/* ------------------------------------------------------------------ */

export type DraftSummaryInput = {
  status: DraftStatus;
  payload: ListingDraftPayload;
  validation?: Pick<ValidationReport, "errorCount" | "warningCount"> | null;
  revision?: number;
  updatedAt?: string | null;
};

export type DraftSummary = {
  statusLabel: string;
  errorCount: number;
  warningCount: number;
  titleLength: number;
  revision: number;
  updatedAt: string | null;
};

export function summarizeDraft(draft: DraftSummaryInput): DraftSummary {
  return {
    statusLabel: DRAFT_STATUS_LABEL[draft.status],
    errorCount: draft.validation?.errorCount ?? 0,
    warningCount: draft.validation?.warningCount ?? 0,
    titleLength: charCount(getTextAttribute(draft.payload, "item_name")),
    revision: draft.revision ?? 0,
    updatedAt: draft.updatedAt ?? null,
  };
}

export function countByStatus(rows: { status: DraftStatus }[]): Record<DraftStatus, number> {
  const counts: Record<DraftStatus, number> = {
    draft: 0,
    pending_approval: 0,
    approved: 0,
    rejected: 0,
    publishing: 0,
    published: 0,
    failed: 0,
  };
  for (const row of rows) counts[row.status] += 1;
  return counts;
}
