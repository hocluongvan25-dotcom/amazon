"use server";

/**
 * Module 8 — server action G1: nhận giả định từ form what-if, chạy lại engine
 * ở server (không tin số client gửi), rồi ghi DUY NHẤT qua RPC
 * public.vexim_research_create_assessment (migration 0025). Demo mode không có
 * Supabase → trả kết quả tính nhưng không lưu.
 */

import { revalidatePath } from "next/cache";
import { getAppSession } from "@/lib/auth/session";
import { getIntelligenceProvider } from "@/lib/intelligence";
import {
  RESEARCH_ENGINE_VERSION,
  computeAssessment,
  parseAsinAutofill,
  validateAssumptions,
} from "@/lib/research/domain";
import { referralRatePctFromFee } from "@/lib/worker/domain/product-fees";
import { lookupSpApiFeesForAsin } from "@/lib/worker/run-product-fees";
import { createClient } from "@/lib/supabase/server";
import { formToAssumptions, type ResearchFormRaw } from "@/lib/data/research-model";

export type SaveAssessmentState = {
  ok: boolean;
  message: string;
  code?: string;
  id?: string;
  /** Kết quả engine trả về ngay cả khi không lưu (demo) để client hiển thị. */
  computed?: {
    verdict: string;
    overallScore: number | null;
    baseMarginPct: number;
    pessMarginPct: number;
    redVetoCount: number;
  };
};

export async function saveAssessmentAction(raw: ResearchFormRaw): Promise<SaveAssessmentState> {
  const assumptions = formToAssumptions(raw);
  const errors = validateAssumptions(assumptions);
  if (errors.length) {
    return { ok: false, message: errors.join(" · ") };
  }

  const result = computeAssessment(assumptions);
  const computed = {
    verdict: result.scorecard.verdict,
    overallScore: result.scorecard.overallScore,
    baseMarginPct: result.financial.scenarios.base.netMarginPct,
    pessMarginPct: result.financial.scenarios.pessimistic.netMarginPct,
    redVetoCount: result.scorecard.vetoes.filter((v) => v.severity === "red").length,
  };

  const db = await createClient();
  if (!db) {
    return {
      ok: false,
      message:
        "DEMO MODE: máy tính what-if đã chạy nhưng bản demo không lưu hồ sơ. Kết nối Supabase để lưu qua RPC (cần vai trò analyst/dept_lead).",
      computed,
    };
  }

  const { data, error } = await db.rpc("vexim_research_create_assessment", {
    p_payload: {
      assumptions,
      result,
      engineVersion: RESEARCH_ENGINE_VERSION,
    },
  });
  if (error) {
    return { ok: false, message: error.message, computed };
  }
  const out = data as { ok: boolean; id: string; code: string };
  revalidatePath("/research");
  return {
    ok: true,
    message: `Đã lưu hồ sơ ${out.code}. G1 lưu được tài chính + scorecard; các trụ Competition/Demand/Differentiation sẽ điền ở G2–G4.`,
    code: out.code,
    id: out.id,
    computed,
  };
}

export type EnqueueState = { ok: boolean; message: string };

/**
 * G2 — analyst xếp hàng 1 lượt thu thập (serp/products/reviews). Ghi qua RPC
 * vexim_research_enqueue_run bằng PHIÊN NGƯỜI DÙNG (không service_role); worker
 * /cron nhận việc sau đó.
 */
export async function enqueueCollectionAction(
  assessmentId: string,
  kind: "serp" | "products" | "reviews",
  params: Record<string, unknown> = {},
): Promise<EnqueueState> {
  const db = await createClient();
  if (!db) {
    return {
      ok: false,
      message: "DEMO MODE: không xếp hàng thu thập được; cần Supabase + worker/cron.",
    };
  }
  const { data, error } = await db.rpc("vexim_research_enqueue_run", {
    p_assessment: assessmentId,
    p_kind: kind,
    p_params: params,
    p_provider: null,
  });
  if (error) return { ok: false, message: error.message };
  const out = data as { ok: boolean; run_id: string };
  revalidatePath(`/research/${assessmentId}`);
  return { ok: true, message: `Đã xếp hàng lượt "${kind}" (${out.run_id.slice(0, 8)}). Worker/cron sẽ nhận và chạy.` };
}

/**
 * G4 — xếp hàng phân tích pain bằng LLM (run kind='analyze', provider='llm').
 * Yêu cầu worker có LLM_API_KEY (không có thì worker chạy mock và gắn
 * provider='mock' — UI hiển thị rõ để không nhầm với phân tích thật).
 */
export async function enqueueAnalyzeAction(assessmentId: string): Promise<EnqueueState> {
  const db = await createClient();
  if (!db) {
    return { ok: false, message: "DEMO MODE: không xếp hàng phân tích được; cần Supabase + worker." };
  }
  const { data, error } = await db.rpc("vexim_research_enqueue_run", {
    p_assessment: assessmentId,
    p_kind: "analyze",
    p_params: { chunkSize: 25, concurrency: 4 },
    p_provider: "llm",
  });
  if (error) return { ok: false, message: error.message };
  const out = data as { ok: boolean; run_id: string };
  revalidatePath(`/research/${assessmentId}`);
  return {
    ok: true,
    message: `Đã xếp hàng phân tích pain bằng LLM (${out.run_id.slice(0, 8)}). Worker sẽ map/reduce trên review 1–3★.`,
  };
}

/**
 * G4 — analyst thẩm định lại 1 pain item: đổi ưu tiên must/should/skip và/sửa
 * yêu cầu cho xưởng. RPC chuyển source sang human_confirmed (migration 0028).
 * Tham số null = giữ nguyên; chuỗi rỗng = bỏ gợi ý.
 */
export async function updatePainItemAction(
  assessmentId: string,
  itemKey: string,
  input: {
    priority?: "must" | "should" | "skip";
    factoryRequirement?: string | null;
    listingFix?: string | null;
  },
): Promise<EnqueueState> {
  const db = await createClient();
  if (!db) {
    return { ok: false, message: "DEMO MODE: bản demo không lưu chỉnh sửa pain." };
  }
  const { error } = await db.rpc("vexim_research_update_pain_item", {
    p_assessment: assessmentId,
    p_item_key: itemKey,
    p_priority: input.priority ?? null,
    p_factory_requirement:
      input.factoryRequirement === undefined ? null : input.factoryRequirement,
    p_listing_fix: input.listingFix === undefined ? null : input.listingFix,
  });
  if (error) return { ok: false, message: error.message };
  revalidatePath(`/research/${assessmentId}`);
  return { ok: true, message: `Đã cập nhật pain "${itemKey}".` };
}

/* ===================== G1 — AUTO-ĐIỀN TỪ ASIN HẠT NHÂN ===================== */

export type AsinLookupAutofill = {
  title: string | null;
  brand: string | null;
  lengthIn: number | null;
  widthIn: number | null;
  heightIn: number | null;
  weightLb: number | null;
  price: number | null;
  suggestedPrices: { pessimistic: number; base: number; optimistic: number } | null;
  missing: string[];
};

export type AsinLookupState = {
  ok: boolean;
  message: string;
  /** 'rainforest' = số thật; 'mock' = demo deterministic (chưa có API key). */
  dataSource?: "rainforest" | "mock";
  autofill?: AsinLookupAutofill;
};

/**
 * Bấm "Lấy dữ liệu ASIN" ở form G1: gọi Rainforest product (1 credit) rồi trả
 * bộ auto-điền (kích thước, khối lượng, giá buybox + 3 kịch bản giá gợi ý
 * ±10%). CHỈ trả dữ liệu mock khi chưa có RAINFOREST_API_KEY và gắn nhãn rõ —
 * không bao giờ âm thầm dùng số giả như số thật. Chạy phía server (KHÔNG gọi
 * Rainforest từ trình duyệt — lộ API key).
 */
export async function lookupSeedAsinAction(asinRaw: string): Promise<AsinLookupState> {
  const session = await getAppSession();
  if (!session) return { ok: false, message: "Chưa đăng nhập." };
  if (session.persona !== "ceo") {
    return { ok: false, message: "Màn thẩm định ngách chỉ dành cho persona CEO." };
  }

  const asin = asinRaw.trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(asin)) {
    return { ok: false, message: "ASIN phải gồm đúng 10 ký tự chữ/số (vd: B0GZN6YMHS)." };
  }

  const { provider, configured } = getIntelligenceProvider();
  let json: unknown;
  try {
    json = await provider.product(asin, "amazon.com");
  } catch (e) {
    const msg = (e as Error).message.split("\n")[0];
    return {
      ok: false,
      message: configured
        ? `Rainforest từ chối truy vấn ASIN ${asin}: ${msg} (kiểm tra gói credit / định dạng ASIN).`
        : `DEMO MODE: provider mock lỗi (${msg}). Thêm RAINFOREST_API_KEY để tra ASIN thật.`,
    };
  }

  const parsed = parseAsinAutofill(json);
  if (!parsed) {
    return {
      ok: false,
      message:
        configured
          ? `Không tìm thấy listing cho ASIN ${asin} trên amazon.com — kiểm tra lại mã ASIN.`
          : `DEMO MODE: mock chỉ biết các ASIN mẫu B0MOCK001..B0MOCK030. Thêm RAINFOREST_API_KEY để tra ASIN thật.`,
    };
  }

  const filled: string[] = [];
  if (parsed.lengthIn !== null && parsed.widthIn !== null && parsed.heightIn !== null) {
    filled.push(`kích thước ${parsed.lengthIn}×${parsed.widthIn}×${parsed.heightIn} in`);
  }
  if (parsed.weightLb !== null) filled.push(`khối lượng ${parsed.weightLb} lb`);
  if (parsed.price !== null) filled.push(`giá đối thủ $${parsed.price} → gợi ý giá cơ sở`);
  if (filled.length === 0) {
    return {
      ok: false,
      message: `Listing ${asin} không công bố kích thước/khối lượng/giá — phải nhập tay các ô này.`,
    };
  }

  return {
    ok: true,
    dataSource: configured ? "rainforest" : "mock",
    message:
      (configured ? "" : "⚠ DEMO — số liệu MOCK, không phải dữ liệu thật. ") +
      `Đã đọc ${parsed.title ? `“${parsed.title}”` : asin}: ${filled.join(", ")}.` +
      (parsed.missing.length ? ` Còn thiếu: ${parsed.missing.join("; ")}.` : ""),
    autofill: {
      title: parsed.title,
      brand: parsed.brand,
      lengthIn: parsed.lengthIn,
      widthIn: parsed.widthIn,
      heightIn: parsed.heightIn,
      weightLb: parsed.weightLb,
      price: parsed.price,
      suggestedPrices: parsed.suggestedPrices,
      missing: parsed.missing,
    },
  };
}

/* ============ G1+ — PHÍ CHUẨN SP-API (getMyFeesEstimateForASIN) ============ */

export type OfficialFeesState = {
  ok: boolean;
  message: string;
  fees?: {
    referralFee: number | null;
    fulfillmentFee: number | null;
    variableClosingFee: number | null;
    totalFees: number | null;
    currency: string | null;
    /** % referral suy từ phí chuẩn — form điền vào ô Referral % */
    referralRatePct: number | null;
    timeOfEstimation: string | null;
  };
};

/**
 * Bấm "Lấy phí chuẩn SP-API" ở form G1: gọi getMyFeesEstimateForASIN với GIÁ
 * CƠ SỞ user đang xét, trả referral + phí FBA CHUẨN (cùng nguồn số với Revenue
 * Calculator của Seller Central) để tự điền ô Referral % và Phí FBA thực.
 * Chạy phía server vì cần LWA refresh token.
 */
export async function lookupOfficialFeesAction(
  asinRaw: string,
  priceBase: number,
): Promise<OfficialFeesState> {
  const session = await getAppSession();
  if (!session) return { ok: false, message: "Chưa đăng nhập." };
  if (session.persona !== "ceo") {
    return { ok: false, message: "Màn thẩm định ngách chỉ dành cho persona CEO." };
  }

  const asin = asinRaw.trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(asin)) {
    return { ok: false, message: "Cần ASIN hạt nhân hợp lệ (10 ký tự) để tra phí chuẩn — lấy ASIN ở mục 1 trước." };
  }
  if (!Number.isFinite(priceBase) || priceBase <= 0) {
    return { ok: false, message: "Cần Giá CƠ SỞ > 0 — Amazon ước phí theo mức giá này (bấm Lấy dữ liệu ASIN để tự điền)." };
  }

  const res = await lookupSpApiFeesForAsin({
    asin,
    price: priceBase,
    // Luồng thẩm định đang US-only (cùng thị trường với Revenue Calculator):
    // GHIM marketplace US thay vì chọn "shop đầu tiên trong DB" — sự cố
    // 16/09/2026: shops[0] trúng shop CA (A2EUQ1WTGCTBG2) mà giá là USD →
    // Amazon trả ClientError "Please verify your inputs" (lệch cặp marketplace/tiền).
    marketplaceId: "ATVPDKIKX0DER",
    currency: "USD",
  });
  const scope = `marketplace ${res.marketplaceId ?? "?"}${res.shopName ? ` · shop ${res.shopName}` : ""}`;
  if (!res.ok || !res.estimate || !res.estimate.ok) {
    return {
      ok: false,
      message:
        (res.reason ??
          res.estimate?.errorMessage ??
          "Không lấy được phí chuẩn SP-API — nhập tay ô Referral % và Phí FBA thực.") +
        ` [${scope} @ $${priceBase.toFixed(2)}]`,
    };
  }

  const e = res.estimate;
  const parts: string[] = [];
  if (e.referralFee !== null) parts.push(`giới thiệu $${e.referralFee.toFixed(2)}`);
  if (e.fulfillmentFee !== null) parts.push(`FBA $${e.fulfillmentFee.toFixed(2)}`);
  if (e.totalFees !== null) parts.push(`tổng $${e.totalFees.toFixed(2)}`);

  return {
    ok: true,
    message:
      `Phí CHUẨN SP-API @ $${priceBase.toFixed(2)} (${scope}): ${parts.join(", ")}.` +
      " Đã điền Referral % và Phí FBA thực — kết quả nay khớp Revenue Calculator.",
    fees: {
      referralFee: e.referralFee,
      fulfillmentFee: e.fulfillmentFee,
      variableClosingFee: e.variableClosingFee,
      totalFees: e.totalFees,
      currency: e.currency,
      referralRatePct: referralRatePctFromFee(e.referralFee, priceBase),
      timeOfEstimation: e.timeOfEstimation,
    },
  };
}
