/**
 * Test L3 — luật soạn listing (thuần, không cần Supabase).
 * Mọi hạn mức ở đây đối chiếu tài liệu Amazon đã kiểm chứng 12/09/2026:
 *   • Tiêu đề ≤ 75 ký tự từ 27/07/2026 (nhóm media 200) + Item Highlight ≤ 125
 *   • Bullet 10–255 (tối đa 5) · Mô tả 2.000 · Từ khóa backend 249 BYTE
 *   • 9 ảnh · offer phải có audience + giá > 0 · CHILD phải có parent_sku
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AMAZON_SOURCES,
  charCount,
  readSchemaLimits,
  repeatedTitleWords,
  resolveLimit,
  utf8Bytes,
} from "../src/lib/listing/amazon-limits.ts";

import {
  availableActions,
  buildFeedDocument,
  buildPatchBody,
  deriveCanWrite,
  filterConnectedShops,
  buildPutBody,
  canTransition,
  checkPublishGate,
  countByStatus,
  createEmptyDraftPayload,
  diffPayload,
  getOffer,
  getParentageLevel,
  getTextAttribute,
  isEditable,
  MAX_FEED_MESSAGES,
  parsePrice,
  pickSubmissionMethod,
  summarizeDraft,
  validateListingDraft,
  type ListingDraftPayload,
  type ValidationReport,
} from "../src/lib/listing/editor-model.ts";

/* ================================================================== */
/* Đếm ký tự / byte — nền tảng của mọi giới hạn                        */
/* ================================================================== */

test("charCount đếm theo code point, utf8Bytes đếm theo byte UTF-8", () => {
  assert.equal(charCount("Cà phê"), 6);
  assert.equal(utf8Bytes("Cà phê"), 8); // 'à', 'ê' = 2 byte mỗi ký tự
  assert.equal(charCount("😀"), 1); // 1 code point
  assert.equal(utf8Bytes("😀"), 4);
  assert.equal(utf8Bytes("abc"), 3);
  // 125 ký tự 'ư' = 250 byte > 249 → lỗi dù chỉ 125 ký tự
  assert.equal(utf8Bytes("ư".repeat(125)), 250);
  assert.equal(charCount("ư".repeat(125)), 125);
});

/* ================================================================== */
/* Validate theo hạn mức Amazon                                        */
/* ================================================================== */

const BASE = {
  productType: "PRODUCT",
  marketplaceId: "ATVPDKIKX0DER",
  locale: "en_US",
};

function validate(payload: ListingDraftPayload, extra: Partial<typeof BASE> & { brand?: string } = {}) {
  return validateListingDraft({ ...BASE, payload, ...extra });
}

const codes = (report: ValidationReport, severity?: string) =>
  report.issues
    .filter((i) => (severity ? i.severity === severity : true))
    .map((i) => i.code);

test("tiêu đề: 75 ký tự là trần (27/07/2026), vượt là ERROR; media được 200", () => {
  const at75 = validate({ item_name: [{ value: "A".repeat(75) }] });
  assert.equal(at75.issues.some((i) => i.attributeName === "item_name" && i.severity === "ERROR"), false);

  const at76 = validate({ item_name: [{ value: "A".repeat(76) }] });
  assert.ok(codes(at76, "ERROR").includes("VEXIM-MAX-LENGTH"));
  assert.equal(at76.ok, false);
  assert.equal(at76.errorCount, at76.issues.filter((i) => i.severity === "ERROR").length);

  // Media (sách/nhạc/video) không chịu luật 75
  const book = validate({ item_name: [{ value: "B".repeat(180) }] }, { productType: "BOOKS" });
  assert.equal(book.issues.some((i) => i.code === "VEXIM-MAX-LENGTH"), false);
});

test("thiếu attribute bắt buộc → ERROR kèm mã Amazon tham chiếu", () => {
  const report = validate({});
  const required = report.issues.filter((i) => i.code === "VEXIM-REQUIRED");
  assert.ok(required.some((i) => i.attributeName === "item_name" && i.amazonCode === "90220"));
  assert.ok(
    report.issues.some((i) => i.attributeName === "main_product_image_locator" && i.severity === "ERROR"),
  );
});

test("tiêu đề: ký tự cấm, nội dung khuyến mại, lặp từ > 2 lần", () => {
  const banned = validate({ item_name: [{ value: "XMO 950 Spinner _ Đen 28" }] });
  assert.ok(codes(banned, "ERROR").includes("VEXIM-TITLE-BANNED-CHAR"));

  // Ký tự cấm nằm trong brand → được miễn
  const brandOk = validate({ item_name: [{ value: "A_Brand 950 Spinner" }] }, { brand: "A_Brand" });
  assert.equal(brandOk.issues.some((i) => i.code === "VEXIM-TITLE-BANNED-CHAR"), false);

  const promo = validate({ item_name: [{ value: "XMO 950 Best Seller Spinner" }] });
  assert.ok(codes(promo, "ERROR").includes("VEXIM-TITLE-PROMO"));

  assert.deepEqual(repeatedTitleWords("Spinner spinner spinner luggage"), [{ word: "spinner", count: 3 }]);
  const repeat = validate({ item_name: [{ value: "Spinner spinner spinner luggage" }] });
  assert.ok(codes(repeat, "WARNING").includes("VEXIM-TITLE-REPEAT"));
});

test("Item Highlights (title_differentiation): trần 125 và chỉ dùng khi tiêu đề ≤ 75", () => {
  const long = validate({ title_differentiation: [{ value: "x".repeat(126) }] });
  assert.ok(long.issues.some((i) => i.attributeName === "title_differentiation" && i.code === "VEXIM-MAX-LENGTH"));

  const blocked = validate({
    item_name: [{ value: "T".repeat(80) }],
    title_differentiation: [{ value: "Vật liệu polycarbonate, dùng cho du lịch" }],
  });
  assert.ok(codes(blocked, "ERROR").includes("VEXIM-HIGHLIGHT-TITLE-BLOCKED"));

  const ok = validate({
    item_name: [{ value: "XMO 950 Hardside Spinner 28 inch Black" }],
    title_differentiation: [{ value: "Vỏ polycarbonate, khóa TSA, bánh xe 360" }],
  });
  assert.equal(ok.issues.some((i) => i.code === "VEXIM-HIGHLIGHT-TITLE-BLOCKED"), false);
  assert.equal(ok.issues.some((i) => i.code === "VEXIM-HIGHLIGHT-DUPLICATE"), false);
});

test("bullet point: tối đa 5, policy 10–255, trần field 500", () => {
  const many = validate({ bullet_point: Array.from({ length: 6 }, () => ({ value: "bullet hop le" })) });
  assert.ok(codes(many, "ERROR").includes("VEXIM-BULLET-COUNT"));

  const tooLong = validate({ bullet_point: [{ value: "b".repeat(501) }] });
  assert.ok(tooLong.issues.some((i) => i.attributeName.startsWith("bullet_point") && i.code === "VEXIM-MAX-LENGTH"));

  const policy = validate({ bullet_point: [{ value: "b".repeat(300) }] });
  assert.ok(policy.issues.some((i) => i.code === "VEXIM-POLICY-LENGTH" && i.severity === "WARNING"));
  // 300 ký tự là WARNING (policy), không phải ERROR (trần field 500)
  assert.equal(
    policy.issues.some((i) => i.attributeName.startsWith("bullet_point") && i.severity === "ERROR"),
    false,
  );

  const tooShort = validate({ bullet_point: [{ value: "ngan" }] });
  assert.ok(tooShort.issues.some((i) => i.code === "VEXIM-POLICY-MIN-LENGTH"));

  const punctuation = validate({ bullet_point: [{ value: "Bền bỉ và nhẹ, dùng hằng ngày." }] });
  assert.ok(punctuation.issues.some((i) => i.code === "VEXIM-BULLET-PUNCTUATION"));

  const emoji = validate({ bullet_point: [{ value: "Bền bỉ và nhẹ, dùng hằng ngày 😀" }] });
  assert.ok(emoji.issues.some((i) => i.code === "VEXIM-BULLET-EMOJI"));
});

test("mô tả: 2.000 ký tự và KHÔNG dùng HTML", () => {
  const over = validate({ product_description: [{ value: "d".repeat(2001) }] });
  assert.ok(over.issues.some((i) => i.attributeName === "product_description" && i.code === "VEXIM-MAX-LENGTH"));

  const html = validate({ product_description: [{ value: "<p>Mô tả</p>" }] });
  assert.ok(codes(html, "ERROR").includes("VEXIM-DESC-HTML"));
});

test("từ khoá backend: trần 249 BYTE (không phải ký tự)", () => {
  const asciiOver = validate({ generic_keyword: [{ value: "a".repeat(250) }] });
  assert.ok(asciiOver.issues.some((i) => i.attributeName === "generic_keyword" && i.code === "VEXIM-MAX-LENGTH"));

  // 125 ký tự có dấu = 250 byte → vẫn vượt
  const accentOver = validate({ generic_keyword: [{ value: "ư".repeat(125) }] });
  assert.ok(accentOver.issues.some((i) => i.attributeName === "generic_keyword" && i.code === "VEXIM-MAX-LENGTH"));

  // 249 byte ASCII → hợp lệ và có INFO báo số byte
  const ok = validate({ generic_keyword: [{ value: "a".repeat(249) }] });
  assert.equal(ok.issues.some((i) => i.attributeName === "generic_keyword" && i.severity === "ERROR"), false);
  assert.ok(ok.issues.some((i) => i.code === "VEXIM-KEYWORD-BYTES" && i.severity === "INFO"));

  const punct = validate({ generic_keyword: [{ value: "hop, dung, pin" }] });
  assert.ok(punct.issues.some((i) => i.code === "VEXIM-KEYWORD-PUNCTUATION"));

  const dup = validate({
    item_name: [{ value: "XMO 950 Hardside Spinner Luggage" }],
    generic_keyword: [{ value: "spinner luggage travel" }],
  });
  assert.ok(dup.issues.some((i) => i.code === "VEXIM-KEYWORD-DUPLICATE"));
});

test("ảnh: bắt buộc ảnh chính, tối đa 9, URL phải https", () => {
  const noMain = validate({ other_product_image_locator_1: [{ media_location: "https://a.example/1.jpg" }] });
  assert.ok(noMain.issues.some((i) => i.code === "VEXIM-IMAGE-MAIN-REQUIRED"));

  const http = validate({
    main_product_image_locator: [{ media_location: "http://a.example/main.jpg" }],
  });
  assert.ok(http.issues.some((i) => i.code === "VEXIM-IMAGE-URL"));

  const tooMany = validate({
    main_product_image_locator: [{ media_location: "https://a.example/main.jpg" }],
    ...Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [
        `other_product_image_locator_${i + 1}`,
        [{ media_location: `https://a.example/${i}.jpg` }],
      ]),
    ),
  });
  assert.ok(tooMany.issues.some((i) => i.code === "VEXIM-IMAGE-COUNT"));
});

test("purchasable_offer: audience bắt buộc, giá > 0, list_price ≥ giá bán", () => {
  const missingAudience = validate({
    purchasable_offer: [{ currency: "USD", our_price: [{ schedule: [{ value_with_tax: 19.99 }] }] }],
  });
  assert.ok(missingAudience.issues.some((i) => i.code === "VEXIM-OFFER-AUDIENCE" && i.amazonCode === "4002005"));

  const zero = validate({
    purchasable_offer: [{ audience: "ALL", currency: "USD", our_price: [{ schedule: [{ value_with_tax: 0 }] }] }],
  });
  assert.ok(zero.issues.some((i) => i.code === "VEXIM-OFFER-PRICE"));

  const listLower = validate({
    purchasable_offer: [
      {
        audience: "ALL",
        currency: "USD",
        our_price: [{ schedule: [{ value_with_tax: 30 }] }],
        list_price: { value_with_tax: 25 },
      },
    ],
  });
  assert.ok(listLower.issues.some((i) => i.code === "VEXIM-OFFER-LIST-PRICE"));
});

test("fulfillment_availability: quantity số nguyên ≥ 0; 0 với FBM là cảnh báo", () => {
  const negative = validate({ fulfillment_availability: [{ fulfillment_channel_code: "DEFAULT", quantity: -1 }] });
  assert.ok(negative.issues.some((i) => i.code === "VEXIM-FULFILLMENT-QTY"));

  const zero = validate({ fulfillment_availability: [{ fulfillment_channel_code: "DEFAULT", quantity: 0 }] });
  assert.ok(zero.issues.some((i) => i.code === "VEXIM-FULFILLMENT-ZERO" && i.severity === "WARNING"));
});

test("variation: CHILD phải có SKU cha, PARENT/CHILD phải có variation_theme", () => {
  const childNoParent = validate({
    parentage_level: [{ value: "CHILD" }],
    variation_theme: [{ name: "COLOR" }],
  });
  assert.ok(childNoParent.issues.some((i) => i.code === "VEXIM-VARIATION-PARENT-SKU"));

  const childPayload: ListingDraftPayload = {
    parentage_level: [{ value: "CHILD" }],
    variation_theme: [{ name: "COLOR" }],
    child_parent_sku_relationship: [{ child_relationship_type: "variation", parent_sku: "XMO-950" }],
  };
  const childOk = validate(childPayload);
  assert.equal(childOk.issues.some((i) => i.code === "VEXIM-VARIATION-PARENT-SKU"), false);
  assert.equal(getParentageLevel(childPayload), "CHILD");

  const parentNoTheme = validate({ parentage_level: [{ value: "PARENT" }] });
  assert.ok(parentNoTheme.issues.some((i) => i.code === "VEXIM-VARIATION-THEME"));
});

test("không có schema product type → INFO nói rõ đang dùng fallback policy", () => {
  const report = validate({ item_name: [{ value: "XMO 950 Spinner" }] });
  assert.equal(report.source, "vexim-policy");
  const info = report.issues.find((i) => i.code === "VEXIM-SCHEMA-MISSING");
  assert.ok(info);
  assert.equal(info!.sourceId, "product_type_definitions");
  assert.equal(report.limits.item_name.source, "vexim-policy-fallback");
  assert.equal(report.limits.item_name.max, 75);
  // mọi issue đều trỏ về nguồn tài liệu Amazon
  for (const i of report.issues) {
    if (i.sourceId) assert.ok(AMAZON_SOURCES[i.sourceId], `nguồn ${i.sourceId} phải tồn tại`);
  }
});

/* ================================================================== */
/* Schema product type (Product Type Definitions API) là nguồn ưu tiên */
/* ================================================================== */

test("readSchemaLimits đọc maxLength/required từ JSON Schema và được ưu tiên hơn fallback", () => {
  const schema = {
    $id: "amazon-product-type-schema/PRODUCT/2026",
    required: ["item_name", "brand", "country_of_origin"],
    properties: {
      item_name: {
        type: "array",
        maxLength: 75,
        items: { type: "object", required: ["value", "language_tag"], properties: { value: { type: "string" } } },
      },
      brand: { type: "array", items: { type: "object", properties: { value: { type: "string" } } } },
      country_of_origin: { type: "array", maxLength: 3, items: { type: "object" } },
    },
  };
  const parsed = readSchemaLimits(schema)!;
  assert.equal(parsed.source, "amazon-schema");
  assert.deepEqual(parsed.requiredAttributes, ["brand", "country_of_origin", "item_name"]);
  assert.equal(parsed.attributes.item_name.maxLength, 75);

  const resolved = resolveLimit("item_name", parsed)!;
  assert.equal(resolved.source, "amazon-schema");
  assert.equal(resolved.max, 75);

  const report = validateListingDraft({
    ...BASE,
    productTypeSchema: schema,
    payload: { item_name: [{ value: "ok" }] },
  });
  assert.equal(report.source, "amazon-schema+vexim-policy");
  // brand + country_of_origin bắt buộc theo schema nhưng chưa có → ERROR
  assert.ok(
    report.issues.some(
      (i) => i.code === "VEXIM-REQUIRED" && (i.attributeName === "brand" || i.attributeName === "country_of_origin"),
    ),
  );
});

/* ================================================================== */
/* Máy trạng thái + 4 mắt                                              */
/* ================================================================== */

test("máy trạng thái: chỉ những bước hợp lệ mới được phép", () => {
  assert.equal(canTransition("draft", "pending_approval"), true);
  assert.equal(canTransition("rejected", "draft"), true);
  assert.equal(canTransition("pending_approval", "approved"), true);
  assert.equal(canTransition("approved", "publishing"), true);
  assert.equal(canTransition("publishing", "published"), true);
  // nhảy bước
  assert.equal(canTransition("draft", "approved"), false);
  assert.equal(canTransition("pending_approval", "published"), false);
  assert.equal(canTransition("published", "approved"), false);

  assert.equal(isEditable("draft"), true);
  assert.equal(isEditable("rejected"), true);
  assert.equal(isEditable("pending_approval"), false);
  assert.equal(isEditable("published"), false);
});

test("phân quyền hành động: 4 mắt — người gửi không tự duyệt được bản của mình", () => {
  const draft = { status: "pending_approval" as const, createdBy: "u1", submittedBy: "u1" };

  const operator = availableActions(draft, { userId: "u1", canWrite: true, isApprover: false });
  assert.deepEqual(operator.map((a) => a.action), ["withdraw"]);

  const selfApprover = availableActions(draft, { userId: "u1", canWrite: true, isApprover: true });
  assert.deepEqual(selfApprover.map((a) => a.action), ["withdraw"]);

  const lead = availableActions(draft, { userId: "u2", canWrite: false, isApprover: true });
  assert.deepEqual(lead.map((a) => a.action), ["approve", "reject"]);
  assert.ok(lead.every((a) => a.needsNote));

  const draftOwner = availableActions({ status: "draft", createdBy: "u1", submittedBy: null }, {
    userId: "u1",
    canWrite: true,
    isApprover: false,
  });
  assert.deepEqual(draftOwner.map((a) => a.action), ["save", "submit"]);
});

/* ================================================================== */
/* Build payload gửi Amazon                                           */
/* ================================================================== */

test("diffPayload: so sánh theo từng attribute (JSON Patch không sửa trong attribute)", () => {
  assert.deepEqual(diffPayload({ item_name: [{ value: "A" }] }, { item_name: [{ value: "B" }] }), ["item_name"]);
  assert.deepEqual(
    diffPayload({ item_name: [{ value: "A" }] }, { item_name: [{ value: "A" }], brand: [{ value: "X" }] }),
    ["brand"],
  );
  assert.deepEqual(diffPayload({ brand: [{ value: "X" }] }, {}), ["brand"]);
  assert.deepEqual(diffPayload(null, null), []);
});

test("buildPatchBody: replace khi có giá trị, delete khi bỏ attribute (kèm marketplace_id)", () => {
  const body = buildPatchBody({
    productType: "LUGGAGE",
    marketplaceId: "ATVPDKIKX0DER",
    locale: "en_US",
    changedAttributes: ["item_name", "generic_keyword"],
    payload: { item_name: [{ value: "XMO 950 Spinner", language_tag: "en_US" }] },
  });
  assert.equal(body.productType, "LUGGAGE");
  assert.deepEqual(body.patches[0], {
    op: "replace",
    path: "/attributes/item_name",
    value: [{ value: "XMO 950 Spinner", language_tag: "en_US" }],
  });
  assert.deepEqual(body.patches[1], {
    op: "delete",
    path: "/attributes/generic_keyword",
    value: [{ marketplace_id: "ATVPDKIKX0DER", language_tag: "en_US" }],
  });
});

test("buildPutBody: giữ đúng requirements và bỏ giá trị undefined", () => {
  const body = buildPutBody({
    productType: "PRODUCT",
    requirements: "LISTING",
    payload: {
      item_name: [{ value: "A" }],
      bullet_point: undefined,
      purchasable_offer: [{ audience: "ALL", currency: "USD" }],
    },
  });
  assert.equal(body.requirements, "LISTING");
  assert.deepEqual(Object.keys(body.attributes).sort(), ["item_name", "purchasable_offer"]);
});

test("JSON_LISTINGS_FEED: messageId tự tăng, trần 25.000 message, chọn phương thức theo số SKU", () => {
  const doc = buildFeedDocument({
    sellerId: "A1XXXXXXXXXXXX",
    locale: "en_US",
    messages: [
      { sku: "SKU-1", operationType: "PATCH", productType: "PRODUCT", patches: [] },
      { sku: "SKU-2", operationType: "UPDATE", productType: "PRODUCT", requirements: "LISTING", attributes: {} },
    ],
  });
  assert.equal(doc.header.version, "2.0");
  assert.deepEqual(doc.messages.map((m) => m.messageId), [1, 2]);
  assert.equal(MAX_FEED_MESSAGES, 25000);
  assert.throws(
    () =>
      buildFeedDocument({
        sellerId: "A1",
        locale: "en_US",
        messages: Array.from({ length: MAX_FEED_MESSAGES + 1 }, (_, i) => ({
          sku: `S${i}`,
          operationType: "PATCH" as const,
          productType: "PRODUCT",
          patches: [],
        })),
      }),
    /25\.000|25000/,
  );
  assert.equal(pickSubmissionMethod(1), "patch");
  assert.equal(pickSubmissionMethod(100), "patch");
  assert.equal(pickSubmissionMethod(101), "feed");
});

/* ================================================================== */
/* Cổng publish (restrictions)                                        */
/* ================================================================== */

test("checkPublishGate: chặn khi chưa duyệt, còn lỗi, hoặc Amazon hạn chế danh mục", () => {
  const validationOk = { ...validate({}), errorCount: 0, ok: true };

  const notApproved = checkPublishGate({
    status: "pending_approval",
    validation: validationOk,
    restrictions: { checkedAt: "", marketplaceId: BASE.marketplaceId, asin: "B0X", reasonCodes: [], messages: [], approvalLinks: [] },
    isNewListing: false,
  });
  assert.equal(notApproved.ok, false);
  assert.ok(notApproved.blockers.some((b) => b.includes("chưa") || b.includes("chỉ publish")));

  const withErrors = checkPublishGate({
    status: "approved",
    validation: { ...validationOk, errorCount: 2, ok: false },
    restrictions: null,
    isNewListing: false,
  });
  assert.equal(withErrors.ok, false);
  assert.ok(withErrors.warnings.some((w) => w.includes("getListingsRestrictions")));

  const notEligible = checkPublishGate({
    status: "approved",
    validation: validationOk,
    restrictions: {
      checkedAt: "2026-09-12T00:00:00Z",
      marketplaceId: BASE.marketplaceId,
      asin: "B0X",
      reasonCodes: ["NOT_ELIGIBLE"],
      messages: ["Not eligible"],
      approvalLinks: [],
    },
    isNewListing: false,
  });
  assert.equal(notEligible.ok, false);
  assert.ok(notEligible.blockers.some((b) => b.includes("NOT_ELIGIBLE")));

  const approvalRequired = checkPublishGate({
    status: "approved",
    validation: validationOk,
    restrictions: {
      checkedAt: "2026-09-12T00:00:00Z",
      marketplaceId: BASE.marketplaceId,
      asin: "B0X",
      reasonCodes: ["APPROVAL_REQUIRED"],
      messages: ["Approval required"],
      approvalLinks: ["https://sellercentral.amazon.com/hz/approvalrequest/restrictions/approve?asin=B0X"],
    },
    isNewListing: false,
  });
  assert.equal(approvalRequired.ok, false);
  assert.ok(approvalRequired.blockers.some((b) => b.includes("approvalrequest")));

  const clean = checkPublishGate({
    status: "approved",
    validation: validationOk,
    restrictions: {
      checkedAt: "2026-09-12T00:00:00Z",
      marketplaceId: BASE.marketplaceId,
      asin: "B0X",
      reasonCodes: [],
      messages: [],
      approvalLinks: [],
    },
    isNewListing: false,
  });
  assert.equal(clean.ok, true);
  assert.equal(clean.blockers.length, 0);
});

/* ================================================================== */
/* Tiện ích                                                           */
/* ================================================================== */

test("parsePrice hiểu cả kiểu US và EU", () => {
  assert.equal(parsePrice("129.99"), 129.99);
  assert.equal(parsePrice("$129.99"), 129.99);
  assert.equal(parsePrice("129,99"), 129.99);
  assert.equal(parsePrice("1.234,56"), 1234.56);
  assert.equal(parsePrice("1,234.56"), 1234.56);
  assert.equal(parsePrice(""), null);
  assert.equal(parsePrice("abc"), null);
});

test("helper truy cập payload + tổng hợp bản nháp", () => {
  const payload = createEmptyDraftPayload({ marketplaceId: "ATVPDKIKX0DER", locale: "en_US", itemName: "XMO 950" });
  assert.equal(getTextAttribute(payload, "item_name"), "XMO 950");
  assert.deepEqual(getOffer({ purchasable_offer: [{ audience: "ALL", currency: "USD", our_price: [{ schedule: [{ value_with_tax: 12.5 }] }] }] }).price, "12.5");

  const summary = summarizeDraft({
    status: "pending_approval",
    payload,
    validation: { errorCount: 1, warningCount: 3 },
    revision: 4,
    updatedAt: null,
  });
  assert.equal(summary.statusLabel, "Chờ trưởng phòng duyệt");
  assert.equal(summary.errorCount, 1);
  assert.equal(summary.titleLength, 7);
  assert.equal(summary.revision, 4);

  const counts = countByStatus([
    { status: "draft" as const },
    { status: "draft" as const },
    { status: "published" as const },
  ]);
  assert.equal(counts.draft, 2);
  assert.equal(counts.published, 1);
  assert.equal(counts.approved, 0);
});

/* ============================================================================
 * FIX 09/2026 — form soạn listing bị khoá với super admin.
 * deriveCanWrite phải KHỚP iam.can_write_seller_account (nguồn sự thật RLS):
 * super_admin ghi được MỌI shop mà KHÔNG cần dòng iam.assignments.
 * ==========================================================================*/

test("deriveCanWrite: super_admin KHÔNG cần assignment vẫn ghi được (bug form khoá)", () => {
  // Đúng tình huống bug: super admin, không có assignment per-shop
  assert.equal(deriveCanWrite([{ role: "super_admin" }], []), true);
  // super_admin + assignment can_write=false vẫn ghi được (role thắng)
  assert.equal(deriveCanWrite([{ role: "super_admin" }], [{ can_write: false }]), true);
});

test("deriveCanWrite: người thường cần assignment can_write=true", () => {
  assert.equal(deriveCanWrite([{ role: "staff" }], [{ can_write: true }]), true);
  assert.equal(deriveCanWrite([{ role: "staff" }], [{ can_write: false }]), false);
  assert.equal(deriveCanWrite([{ role: "staff" }], []), false);
  assert.equal(deriveCanWrite([], []), false);
});

test("deriveCanWrite: org_admin/dept_lead KHÔNG tự có quyền ghi (khớp iam.can_write_seller_account)", () => {
  // Chỉ super_admin được đặc cách trong hàm DB — org_admin muốn ghi vẫn cần assignment
  assert.equal(deriveCanWrite([{ role: "org_admin" }], []), false);
  assert.equal(deriveCanWrite([{ role: "dept_lead" }], []), false);
  assert.equal(deriveCanWrite([{ role: "org_admin" }], [{ can_write: true }]), true);
});

/* ============================================================================
 * FIX 09/2026 — bộ chọn shop chỉ hiện shop ĐÃ KẾT NỐI Amazon (is_active=true).
 * Shop chưa kết nối soạn xong cũng không publish được → ẩn đi tránh chọn nhầm.
 * ==========================================================================*/

test("filterConnectedShops: chỉ giữ shop có token is_active=true", () => {
  const shops = [
    { sellerAccountId: "s1", shop: "Shop US (đã kết nối)" },
    { sellerAccountId: "s2", shop: "Shop CA (chưa kết nối)" },
    { sellerAccountId: "s3", shop: "Shop UK (token hết hạn)" },
  ];
  const tokens = [
    { seller_account_id: "s1", is_active: true },
    { seller_account_id: "s3", is_active: false }, // hết hạn/thu hồi → ẩn
    // s2 không có dòng token → chưa từng kết nối → ẩn
  ];
  assert.deepEqual(filterConnectedShops(shops, tokens), [
    { sellerAccountId: "s1", shop: "Shop US (đã kết nối)" },
  ]);
});

test("filterConnectedShops: KHÔNG có dòng token nào → giữ nguyên (DB cũ chưa chạy 0020, không chặn oan)", () => {
  const shops = [{ sellerAccountId: "s1", shop: "Shop US" }];
  assert.deepEqual(filterConnectedShops(shops, []), shops);
});

test("filterConnectedShops: mọi token đều inactive → danh sách rỗng (buộc đi kết nối lại)", () => {
  const shops = [{ sellerAccountId: "s1", shop: "Shop US" }];
  assert.deepEqual(
    filterConnectedShops(shops, [{ seller_account_id: "s1", is_active: false }]),
    [],
  );
});
