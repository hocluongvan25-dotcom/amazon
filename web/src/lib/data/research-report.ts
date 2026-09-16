/**
 * Module 8 G5 — đọc dữ liệu Report Canvas + dựng ngữ cảnh LLM narrative.
 *
 * Supabase: view vexim_research_report_versions/_sections/_veto_acks (RLS theo
 * org). Demo: chạy MockLlmProvider tạo nháp TOÀN BỘ section narrative từ ngữ
 * cảnh demo (gắn rõ mode=demo, mọi nút quy trình bị khóa ở UI).
 */

import { MockLlmProvider, getLlmProvider } from "@/lib/ai";
import {
  REQUIRED_SECTIONS,
  SECTION_REGISTRY,
  markdownLiteToDoc,
  type SectionStatus,
  type TiptapDoc,
} from "@/lib/research/domain";
import { buildNarrativeContext, type NarrativeContextBundle } from "@/lib/research/domain";
import { createClient } from "@/lib/supabase/server";
import { readAssessmentDetail, readCollectionData } from "./research";
import { readPainData } from "./research-pain";

export type ReportVersionStatus =
  | "draft"
  | "in_review"
  | "changes_requested"
  | "approved"
  | "published"
  | "stale";

export type ReportVersionRow = {
  versionNo: number;
  status: ReportVersionStatus;
  title: string | null;
  hasSnapshot: boolean;
  changeNote: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  createdName: string | null;
  approverName: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ReportSectionRow = {
  sectionKey: string;
  status: SectionStatus;
  content: TiptapDoc;
  source: "empty" | "ai" | "human" | "human_regen";
  generatedModel: string | null;
  verifiedName: string | null;
  verifiedAt: string | null;
  updatedAt: string;
  lockOwner: string | null;
  lockedAt: string | null;
  lockIsMine: boolean;
  lockActiveOther: boolean;
};

export type VetoAckRow = {
  versionNo: number;
  ruleCode: string;
  acknowledgedName: string | null;
  note: string | null;
  createdAt: string;
};

export type ReportData = {
  mode: "demo" | "supabase";
  draftVersionNo: number | null;
  sections: Partial<Record<string, ReportSectionRow>>;
  versions: ReportVersionRow[];
  acks: VetoAckRow[]; // theo draftVersionNo
  requiredKeys: string[];
  /** mã model/provider LLM đang cấu hình (hiển thị nhãn minh bạch) */
  llm: { configured: boolean; providerName: string; model: string };
};

const str = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));
const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function mapVersion(r: Record<string, unknown>): ReportVersionRow {
  return {
    versionNo: Number(r.version_no),
    status: String(r.status) as ReportVersionStatus,
    title: str(r.title),
    hasSnapshot: !!r.snapshot,
    changeNote: str(r.change_note),
    submittedAt: str(r.submitted_at),
    approvedAt: str(r.approved_at),
    createdName: str(r.created_name),
    approverName: str(r.approver_name),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function mapSection(r: Record<string, unknown>): ReportSectionRow {
  return {
    sectionKey: String(r.section_key),
    status: String(r.status) as SectionStatus,
    content: (r.content ?? { type: "doc", content: [{ type: "paragraph" }] }) as TiptapDoc,
    source: String(r.source ?? "empty") as ReportSectionRow["source"],
    generatedModel: str(r.generated_model),
    verifiedName: str(r.verified_name),
    verifiedAt: str(r.verified_at),
    updatedAt: String(r.updated_at),
    lockOwner: str(r.lock_owner),
    lockedAt: str(r.locked_at),
    lockIsMine: !!r.lock_is_mine,
    lockActiveOther: !!r.lock_active_other,
  };
}

/** Dựng ngữ cảnh narrative cho 1 hồ sơ (dùng cho regenerate/seed nháp). */
export async function loadNarrativeContext(
  assessmentId: string,
): Promise<NarrativeContextBundle & { llm: ReportData["llm"] }> {
  const [detail, collection, pain] = await Promise.all([
    readAssessmentDetail(assessmentId),
    readCollectionData(assessmentId),
    readPainData(assessmentId),
  ]);
  if (!detail) throw new Error("Không thấy hồ sơ");
  if (!collection) throw new Error("Không thấy dữ liệu thu thập hồ sơ");
  if (!pain) throw new Error("Không thấy dữ liệu phân tích review");
  const llmContext = getLlmProvider();
  const differentiation =
    detail.result.scorecard.pillars.find((p) => p.pillar === "differentiation") ?? null;
  const demand = detail.result.scorecard.pillars.find((p) => p.pillar === "demand") ?? null;
  const painAnalysis =
    pain.items.length > 0
      ? {
          model: pain.llmRuns[0]?.model ?? "unknown",
          // số review phẳng dùng reviewCount của collection; ASIN suy từ quote
          sampleSize: collection.reviewCount,
          asinCount: new Set(pain.items.flatMap((i) => i.quotes.map((q) => q.asin))).size,
          executiveNarrative: null,
          items: pain.items,
        }
      : null;
  const bundle = buildNarrativeContext({
    result: detail.result,
    competitors: collection.competitors.map((c) => ({
      position: c.position,
      isSponsored: !!c.is_sponsored,
      asin: c.asin,
      currency: "USD",
      isAmazon1p: !!c.is_amazon_1p,
      price: num(c.price),
      rating: num(c.rating),
      ratingsTotal: num(c.ratings_total),
      estUnitsMonth: num(c.est_units_month),
      dataSource: (c.data_source as "rainforest" | "mock") ?? "rainforest",
    })),
    pain: painAnalysis,
    differentiation: differentiation
      ? { score: differentiation.score, confidence: differentiation.confidence, reason: differentiation.reason }
      : null,
    demand: demand ? { score: demand.score, confidence: demand.confidence, reason: demand.reason } : null,
    velocity: collection.velocity,
    reviewCount: collection.reviewCount,
    llm: { providerName: llmContext.provider.name, model: llmContext.provider.model },
    collectedAt: new Date().toISOString().slice(0, 10),
  });
  return {
    ...bundle,
    llm: {
      configured: llmContext.configured,
      providerName: llmContext.provider.name,
      model: llmContext.provider.model,
    },
  };
}

/** Tạo nháp nháp MỌI section narrative bằng provider (mock hoặc openai). */
async function buildDemoReport(assessmentId: string, llm: ReportData["llm"]): Promise<ReportData> {
  const ctx = await loadNarrativeContext(assessmentId);
  const provider = new MockLlmProvider();
  const resolution = {
    metrics: new Map(ctx.metrics.map((m) => [m.key, m])),
    quotes: new Map(ctx.quotes.map((q) => [q.reviewId, q])),
  };
  const sections: ReportData["sections"] = {};
  await Promise.all(
    SECTION_REGISTRY.filter((s) => s.narrative).map(async (def) => {
      const res = await provider.sectionNarrative({
        assessmentId,
        sectionKey: def.key,
        sectionTitle: def.title,
        brief: def.brief,
        metrics: ctx.metrics,
        quotes: ctx.quotes,
        context: ctx.contextText,
      });
      const { doc } = markdownLiteToDoc(res.data.markdown, resolution);
      sections[def.key] = {
        sectionKey: def.key,
        status: "drafted",
        content: doc,
        source: "ai",
        generatedModel: res.model,
        verifiedName: null,
        verifiedAt: null,
        updatedAt: new Date().toISOString(),
        lockOwner: null,
        lockedAt: null,
        lockIsMine: false,
        lockActiveOther: false,
      };
    }),
  );
  return {
    mode: "demo",
    draftVersionNo: 1,
    sections,
    versions: [
      {
        versionNo: 1,
        status: "draft",
        title: "Báo cáo thẩm định v1 (DEMO)",
        hasSnapshot: false,
        changeNote: null,
        submittedAt: null,
        approvedAt: null,
        createdName: "Hải Anh (demo)",
        approverName: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
    acks: [],
    requiredKeys: REQUIRED_SECTIONS,
    llm,
  };
}

let demoReportCache: Promise<ReportData> | null = null;

export async function readReportData(assessmentId: string): Promise<ReportData | null> {
  const llmContext = getLlmProvider();
  const llm: ReportData["llm"] = {
    configured: llmContext.configured,
    providerName: llmContext.provider.name,
    model: llmContext.provider.model,
  };

  if (assessmentId.startsWith("demo-")) {
    if (!demoReportCache || assessmentId !== "demo-1") {
      demoReportCache = buildDemoReport(assessmentId, llm);
    }
    return demoReportCache;
  }

  const db = await createClient();
  if (!db) return null;

  const [versionsRes, sectionsRes, acksRes] = await Promise.all([
    db
      .from("vexim_research_report_versions")
      .select("*")
      .eq("assessment_id", assessmentId)
      .order("version_no", { ascending: false }),
    db.from("vexim_research_report_sections").select("*").eq("assessment_id", assessmentId),
    db.from("vexim_research_veto_acks").select("*").eq("assessment_id", assessmentId),
  ]);
  if (versionsRes.error) throw new Error(`Không đọc được version báo cáo — ${versionsRes.error.message}`);
  if (sectionsRes.error) throw new Error(`Không đọc được section báo cáo — ${sectionsRes.error.message}`);
  if (acksRes.error) throw new Error(`Không đọc được ghi nhận veto — ${acksRes.error.message}`);

  const versions = ((versionsRes.data ?? []) as Record<string, unknown>[]).map(mapVersion);
  const draft = versions.find((v) => v.status === "draft") ?? null;

  const sections: ReportData["sections"] = {};
  for (const r of (sectionsRes.data ?? []) as Record<string, unknown>[]) {
    if (Number(r.report_version) !== draft?.versionNo) continue;
    const mapped = mapSection(r);
    sections[mapped.sectionKey] = mapped;
  }
  const acks: VetoAckRow[] = ((acksRes.data ?? []) as Record<string, unknown>[])
    .filter((r) => Number(r.version_no) === draft?.versionNo)
    .map((r) => ({
      versionNo: Number(r.version_no),
      ruleCode: String(r.rule_code),
      acknowledgedName: str(r.acknowledged_name),
      note: str(r.note),
      createdAt: String(r.created_at),
    }));

  return {
    mode: "supabase",
    draftVersionNo: draft?.versionNo ?? null,
    sections,
    versions,
    acks,
    requiredKeys: REQUIRED_SECTIONS,
    llm,
  };
}
