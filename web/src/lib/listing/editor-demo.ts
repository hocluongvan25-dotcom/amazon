/**
 * Bản nháp DEMO cho L3 — dùng khi chưa cấu hình Supabase.
 * Không ghi vào DB (API trả 409 ở DEMO MODE); chỉ để xem form + kiểm tra hạn mức.
 */

import {
  createEmptyDraftPayload,
  setFulfillment,
  setImageUrls,
  setOffer,
  setTextAttribute,
  setTextList,
  type ListingDraftPayload,
} from "./editor-model.ts";

export type DemoEditorDraft = {
  id: null;
  sellerAccountId: string;
  sku: string;
  asin: string | null;
  shop: string;
  productType: string;
  requirements: string;
  marketplaceId: string;
  locale: string;
  status: "draft";
  payload: ListingDraftPayload;
  revision: number;
  validation: null;
  history: never[];
};

export function createDemoEditorDraft(input: {
  sellerAccountId?: string;
  sku?: string;
  asin?: string | null;
  shop?: string;
  productType?: string;
  marketplaceId?: string;
  locale?: string;
}): DemoEditorDraft {
  const marketplaceId = input.marketplaceId ?? "ATVPDKIKX0DER";
  const locale = input.locale ?? "en_US";
  const opts = { locale, marketplaceId };

  let payload = createEmptyDraftPayload({ marketplaceId, locale, itemName: "XMO 950 Hardside Spinner 28 inch" });
  payload = setTextList(
    payload,
    "bullet_point",
    [
      "Vỏ polycarbonate chống va đập cho mọi chuyến đi",
      "Khóa TSA bảo vệ hành lý khi ký gửi",
      "Bánh xe 360 độ xoay linh hoạt tại sân bay",
    ],
    opts,
  );
  payload = setTextAttribute(payload, "product_description", "Vali vỏ cứng polycarbonate, khóa TSA, bánh xe spinner 360 độ.", opts);
  payload = setTextAttribute(payload, "generic_keyword", "vali du lịch chống sốc", opts);
  payload = setTextAttribute(payload, "brand", "XMO", opts);
  payload = setImageUrls(payload, "main_product_image_locator", ["https://m.media-amazon.com/images/I/example-main.jpg"]);
  payload = setOffer(payload, { audience: "ALL", currency: "USD", price: 129.99, listPrice: 159.99 });
  payload = setFulfillment(payload, { channel: "DEFAULT", quantity: 42 });

  return {
    id: null,
    sellerAccountId: input.sellerAccountId ?? "demo-shop",
    sku: input.sku ?? "XMO-950-BLK",
    asin: input.asin ?? "B0C7T31F",
    shop: input.shop ?? "Shop Demo US",
    productType: input.productType ?? "LUGGAGE",
    requirements: "LISTING",
    marketplaceId,
    locale,
    status: "draft",
    payload,
    revision: 0,
    validation: null,
    history: [],
  };
}
