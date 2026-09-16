/**
 * Test Module 8 — phân FBA size tier & ước lượng phí (bảng US 2026).
 * Quy tắc lấy từ trang "Product size tiers" của Amazon (đọc lại 08/2026).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifySizeTier,
  dimensionalWeightLb,
  estimateFbaFeeUs,
  estimateStorageMonthly,
  evaluatePackaging,
  lengthPlusGirth,
  sortedSides,
} from "../src/lib/research/domain/size-tier.ts";
import type { PackDimensions } from "../src/lib/research/domain/types.ts";

function pack(p: Partial<PackDimensions>): PackDimensions {
  return { lengthIn: 10, widthIn: 6, heightIn: 0.5, weightLb: 0.5, ...p };
}

test("sắp xếp cạnh: dài nhất → trung vị → ngắn nhất, không phụ thuộc thứ tự nhập", () => {
  assert.deepEqual(sortedSides(pack({ lengthIn: 0.5, widthIn: 12, heightIn: 8 })), [12, 8, 0.5]);
});

test("Large Envelope khi nằm trong 13×11×1 và ≤10 oz", () => {
  const r = classifySizeTier(pack({ lengthIn: 12, widthIn: 8, heightIn: 0.6, weightLb: 0.5 }));
  assert.equal(r.tier, "large_envelope");
  assert.equal(r.isOversize, false);
  // Bậc envelope/phong bì chỉ tính theo cân nặng đơn vị
  assert.equal(r.billableWeightLb, 0.5);
});

test("Small Standard cho sản phẩm mỏng ≤15×12×0.75, ≤1 lb", () => {
  const r = classifySizeTier(pack({ lengthIn: 14, widthIn: 9, heightIn: 0.5, weightLb: 0.75 }));
  assert.equal(r.tier, "small_standard");
  assert.equal(r.billableWeightLb, 0.75); // KHÔNG dùng dimensional weight
});

test("dày 0.9 inch là rơi xuống Large Standard dù cạnh khác nhỏ (vực 0.75\")", () => {
  const thin = classifySizeTier(pack({ lengthIn: 14, widthIn: 10, heightIn: 0.7, weightLb: 0.6 }));
  const thick = classifySizeTier(pack({ lengthIn: 14, widthIn: 10, heightIn: 0.9, weightLb: 0.6 }));
  assert.equal(thin.tier, "small_standard");
  assert.equal(thick.tier, "large_standard");
});

test("Large Standard cho hộp ≤18×14×8, ≤20 lb", () => {
  const r = classifySizeTier(pack({ lengthIn: 16, widthIn: 11, heightIn: 4, weightLb: 3 }));
  assert.equal(r.tier, "large_standard");
});

test("Small Bulky (bậc mới 15/01/2026): 20×15×10, 5 lb, L+girth ≤130", () => {
  const r = classifySizeTier(pack({ lengthIn: 20, widthIn: 15, heightIn: 10, weightLb: 5 }));
  assert.equal(r.tier, "small_bulky");
  assert.equal(r.isOversize, true);
  assert.equal(lengthPlusGirth(pack({ lengthIn: 20, widthIn: 15, heightIn: 10 })), 70);
});

test("Large Bulky khi vượt trần Small Bulky 37\" nhưng trong 59/33/33", () => {
  const r = classifySizeTier(pack({ lengthIn: 40, widthIn: 20, heightIn: 10, weightLb: 10 }));
  assert.equal(r.tier, "large_bulky");
  assert.equal(r.isOversize, true);
});

test("Large Standard nhẹ nhưng cồng kềnh → tính phí theo dimensional weight /139", () => {
  // 18×14×8 = 2016 in³ → 14.5 lb dim, dù chỉ nặng 2 lb
  const r = classifySizeTier(pack({ lengthIn: 18, widthIn: 14, heightIn: 8, weightLb: 2 }));
  assert.equal(r.tier, "large_standard");
  assert.equal(r.dimensionalWeightLb, 14.5);
  assert.equal(r.billableWeightLb, 14.5);
  assert.equal(dimensionalWeightLb(pack({ lengthIn: 18, widthIn: 14, heightIn: 8 })), 14.5);
});

test("nhóm bulky giả định W/H tối thiểu 2\" khi tính dimensional weight", () => {
  // Sản phẩm dài, mỏng: 30×3×0.4, 2 lb → dim dùng 30×max(3,2)×max(0.4,2)/139 = 180/139 ≈ 1.29
  const r = classifySizeTier(pack({ lengthIn: 30, widthIn: 3, heightIn: 0.4, weightLb: 2 }));
  assert.equal(r.tier, "small_bulky");
  assert.equal(r.billableWeightLb, 2); // 2 lb đơn vị vẫn lớn hơn 1.29 dim
});

test("cảnh báo sát ngưỡng khi trong vòng 5% trần bậc", () => {
  const r = classifySizeTier(pack({ lengthIn: 14.6, widthIn: 10, heightIn: 0.6, weightLb: 0.96 }));
  assert.equal(r.tier, "small_standard");
  assert.ok(r.nearBoundaries.some((t) => t.includes("cạnh dài nhất")));
  assert.ok(r.nearBoundaries.some((t) => t.includes("khối lượng")));
});

test("phí fulfilment tham khảo 2026 theo bậc cân", () => {
  assert.equal(estimateFbaFeeUs("small_standard", 0.2), 3.06); // ≤4 oz
  assert.equal(estimateFbaFeeUs("small_standard", 0.5), 3.15); // ≤8 oz
  assert.equal(estimateFbaFeeUs("small_standard", 0.75), 3.36); // ≤16 oz
  assert.equal(estimateFbaFeeUs("large_standard", 1.0), 4.13); // đúng 1 lb vẫn ở băng 12–16 oz
  assert.equal(estimateFbaFeeUs("large_standard", 1.25), 5.9); // >1–1.5 lb
  assert.equal(estimateFbaFeeUs("large_standard", 2.25), 6.63); // 2–2.5 lb
  assert.equal(estimateFbaFeeUs("large_standard", 2.9), 6.81); // 2.5–3 lb
  // 4 lb → 6.92 + 0.16 × ceil((4−3)×2)=2 nửa-lb = 7.24
  assert.equal(estimateFbaFeeUs("large_standard", 4), 7.24);
  // Bulky: 9.60 + 0.38 × (ceil(lb)−1)
  assert.equal(estimateFbaFeeUs("small_bulky", 5), 11.12);
});

test("storage: ft³ và phí 2 mùa, standard thấp hơn trên ft³ nhưng cao hơn tuyệt đối mùa Q4", () => {
  const s = estimateStorageMonthly(pack({ lengthIn: 16, widthIn: 11, heightIn: 4 }), false);
  // 16×11×4 = 704 in³ = 0.407 ft³ → low 0.407×0.78 ≈ 0.32, peak 0.407×2.25 ≈ 0.92
  assert.equal(s.cubicFeet, 0.41);
  assert.equal(s.low, 0.32);
  assert.equal(s.peak, 0.92);
});

test("evaluatePackaging tính tiết kiệm khi đổi được tier", () => {
  const bulky = pack({ lengthIn: 20, widthIn: 15, heightIn: 10, weightLb: 3 });
  const current = evaluatePackaging("hiện tại", bulky);
  assert.equal(current.tier, "small_bulky");
  // Đóng gói nén về Large Standard
  const alt = evaluatePackaging(
    "nén",
    { lengthIn: 17, widthIn: 13, heightIn: 6, weightLb: 3 },
    current.fbaFee,
    10000,
  );
  assert.equal(alt.tier, "large_standard");
  assert.ok((alt.savingPerUnit ?? 0) > 0);
  assert.equal(alt.savingPerYear, Math.round((alt.savingPerUnit ?? 0) * 10000 * 100) / 100);
});
