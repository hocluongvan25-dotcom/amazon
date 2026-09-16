/**
 * Trạng thái nháp giữa 2 trang riêng của luồng G1:
 *   /research/new (nhập) → /research/new/phan-tich (kết quả)
 * Lưu qua sessionStorage (không đẩy 25 ô lên URL; mất khi đóng trình duyệt —
 * đúng chất nháp, hồ sơ thật chỉ tồn tại sau khi bấm Lưu qua RPC).
 */

import { formToAssumptions, type ResearchFormRaw } from "../data/research-model.ts";
import { validateAssumptions } from "./domain/index.ts";

export const DRAFT_KEY = "vexim:research-draft:v1";

export type FormSection = "nganh" | "gia" | "donggoi" | "velocity";

export const SECTION_LABEL: Record<FormSection, string> = {
  nganh: "Ngách & từ khóa",
  gia: "Giá & chi phí",
  donggoi: "Đóng gói & rủi ro",
  velocity: "Velocity & lô test",
};

export const DEFAULTS: ResearchFormRaw = {
  title: "Giá đỡ inox đa năng nhà bếp",
  keywords: "kitchen shelf organizer, stainless steel rack",
  seedAsin: "",
  pricePessimistic: "34.99",
  priceBase: "39.99",
  priceOptimistic: "44.99",
  cogsPerUnit: "6",
  inboundFreightPerUnit: "1.5",
  lengthIn: "10",
  widthIn: "6",
  heightIn: "0.5",
  weightLb: "0.75",
  referralRate: "15",
  fbaFeeOverride: "",
  cpc: "0.8",
  conversionRatePct: "10",
  returnRatePct: "4",
  otherPerUnit: "0",
  pessimisticUnitsPerDay: "3",
  testCoverDays: "45",
  adsBudgetPerDay: "",
  adsTestDays: "45",
  fragile: false,
  certificationRequired: false,
  patentRisk: false,
};

/**
 * Form TRẮNG — trạng thái khởi đầu thật của /research/new từ 16/09/2026.
 * KHÔNG điền sẵn số demo nữa: số liệu là của user (hoặc auto-fill từ ASIN hạt
 * nhân), engine không bao giờ phân tích nhầm sản phẩm mẫu. `DEFAULTS` ở trên
 * chỉ còn là MẪU hợp lệ cho test/demo tham chiếu, KHÔNG dùng để pre-fill.
 */
export const BLANK_FORM: ResearchFormRaw = {
  title: "",
  keywords: "",
  seedAsin: "",
  pricePessimistic: "",
  priceBase: "",
  priceOptimistic: "",
  cogsPerUnit: "",
  inboundFreightPerUnit: "",
  lengthIn: "",
  widthIn: "",
  heightIn: "",
  weightLb: "",
  referralRate: "",
  fbaFeeOverride: "",
  cpc: "",
  conversionRatePct: "",
  returnRatePct: "",
  otherPerUnit: "",
  pessimisticUnitsPerDay: "",
  testCoverDays: "",
  adsBudgetPerDay: "",
  adsTestDays: "",
  fragile: false,
  certificationRequired: false,
  patentRisk: false,
};

export function saveDraft(form: ResearchFormRaw): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify(form));
}

export function loadDraft(): ResearchFormRaw | null {
  if (typeof window === "undefined") return null;
  const raw = window.sessionStorage.getItem(DRAFT_KEY);
  if (!raw) return null;
  try {
    return { ...BLANK_FORM, ...(JSON.parse(raw) as Partial<ResearchFormRaw>) } as ResearchFormRaw;
  } catch {
    return null;
  }
}

export function clearDraft(): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(DRAFT_KEY);
}

/** Chạy engine validate thuần và gom lỗi theo từng thẻ mục. */
export function errorsBySection(form: ResearchFormRaw): {
  errors: string[];
  bySection: Record<FormSection, string[]>;
} {
  const assumptions = formToAssumptions(form);
  const errors = validateAssumptions(assumptions);
  const bySection: Record<FormSection, string[]> = {
    nganh: [],
    gia: [],
    donggoi: [],
    velocity: [],
  };
  for (const msg of errors) {
    if (msg.includes("tên ngách") || msg.includes("từ khóa")) {
      bySection.nganh.push(msg);
    } else if (msg.includes("Kích thước") || msg.includes("khối lượng")) {
      bySection.donggoi.push(msg);
    } else {
      bySection.gia.push(msg);
    }
  }
  return { errors, bySection };
}
