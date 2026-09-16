/**
 * Module 8 G4 — LLM provider MOCK deterministic (không gọi mạng, không tốn
 * tiền) cho CI, DEMO MODE và đào tạo quy trình. Phân cụm bằng từ khóa đa
 * ngôn ngữ; câu trích được CẮT TRỰC TIẾP TỪ BODY (nên luôn truy được gốc —
 * lớp validate quote vẫn chạy lại như với model thật).
 */

import {
  extractVerbatimQuote,
  type AnalysisReview,
  type PainClusterCode,
  type PainItemDraft,
  type PainObservation,
} from "../research/domain/pain.ts";
import { hashMessages } from "./hash.ts";
import { buildMapMessages, buildReduceMessages, buildSectionMessages } from "./prompts.ts";
import { MOCK_MODEL, estimateTokens } from "./pricing.ts";
import type {
  LlmCallResult,
  LlmProvider,
  MapChunkInput,
  MapChunkOutput,
  ReducePainInput,
  ReducePainOutput,
  SectionNarrativeInput,
  SectionNarrativeOutput,
} from "./types.ts";

type Suggestion = Omit<PainItemDraft, "itemKey" | "cluster" | "title" | "subLabel" | "reviewIds">;

type Rule = {
  cluster: PainClusterCode;
  subLabel: string;
  painTitle: string;
  /** regex nhận diện (tiếng Anh + vài từ tiếng Việt) */
  re: RegExp;
  /** cụm từ để định vị câu trích (lấy regex đầu tiên match) */
  anchors: RegExp[];
  suggestion: Suggestion;
};

const RUST: Suggestion = {
  effortHint: 3,
  factoryRequirement:
    "Nâng vật liệu khung lên inox 304 hoặc bổ sung lớp mạ điện phân/sơn tĩnh điện chống gỉ; kiểm tra chất lượng mối hàn.",
  listingFix: null,
  testMethod: "Thử phun muối trung tính (salt spray) theo ASTM B117 trong 48 giờ.",
  acceptanceStandard: "Không xuất hiện vết gỉ/đốm oxy hóa sau 48 giờ phun muối.",
  costImpactEstimate: "+0,3–0,6 USD/đơn vị",
};

const STRUCTURAL: Suggestion = {
  effortHint: 2,
  factoryRequirement:
    "Tăng độ dày vật liệu, bổ sung gân gia cố và chân đế chỉnh được; kiểm soát độ phẳng sau dập.",
  listingFix: null,
  testMethod: "Thử tải tĩnh 1,5 lần tải định mức trong 24h; thử lặp 1.000 chu kỳ.",
  acceptanceStandard: "Không biến dạng vĩnh viễn, không nghiêng đổ ở tải định mức.",
  costImpactEstimate: "+0,4–0,9 USD/đơn vị",
};

const RULES: Rule[] = [
  {
    cluster: "quality",
    subLabel: "gỉ sét",
    painTitle: "Khung/vật liệu gỉ sét sau thời gian ngắn",
    re: /rust|gỉ|corrod/i,
    anchors: [/rust(?:ed|ing)?[^\n.]{0,60}/i, /corrod[^\n.]{0,60}/i],
    suggestion: RUST,
  },
  {
    cluster: "quality",
    subLabel: "gãy/biến dạng",
    painTitle: "Kết cấu yếu, gãy hoặc cong vênh khi dùng",
    re: /snap|broke|broken|bend|bent|wobble|wobbly|flex|flimsy|uneven|gãy|cong|ọp/i,
    anchors: [/[^\n.]{0,40}(?:snap(?:ped)?|broke|broken|wobble[sd]?|bend[s]?|bent|flex(?:es)?)[^\n.]{0,40}/i],
    suggestion: STRUCTURAL,
  },
  {
    cluster: "quality",
    subLabel: "cạnh sắc/gia công",
    painTitle: "Cạnh sắc/gia công thô gây nguy hiểm",
    re: /sharp|burr|finishing|cut my|sắc|gia công/i,
    anchors: [/[^\n.]{0,30}(?:sharp|burr)[^\n.]{0,50}/i],
    suggestion: {
      effortHint: 2,
      factoryRequirement: "Bo trám (deburr) và mài làm phẳng mọi cạnh cắt sau dập; thêm bo góc nhựa.",
      listingFix: null,
      testMethod: "Kiểm tra cạnh bằng găng vải và dưỡng đo bán kính góc trên toàn lô.",
      acceptanceStandard: "100% mẫu không có ba via, không xước khi lướt găng kiểm.",
      costImpactEstimate: "+0,1–0,2 USD/đơn vị",
    },
  },
  {
    cluster: "quality",
    subLabel: "lớp phủ bong tróc",
    painTitle: "Lớp phủ đen bong tróc rơi vào đồ dùng",
    re: /peel|coating|flecks|flak|bong tróc|phủ/i,
    anchors: [/[^\n.]{0,30}(?:peel(?:ing)?|coating|flecks)[^\n.]{0,50}/i],
    suggestion: {
      effortHint: 2,
      factoryRequirement:
        "Đổi quy trình xử lý bề mặt (phốt phát hóa trước khi phủ), kiểm tra độ bám dính lớp phủ.",
      listingFix: null,
      testMethod: "Test bám dính ô vuông (cross-hatch) theo ISO 2409.",
      acceptanceStandard: "Đạt cấp 0–1 ISO 2409, không mảng phủ bong khi cọ rửa thường.",
      costImpactEstimate: "+0,15–0,3 USD/đơn vị",
    },
  },
  {
    cluster: "quality",
    subLabel: "lỗ lắp lệch",
    painTitle: "Lỗ khoan/lắp ráp lệch khiến không lắp được vuông",
    re: /holes? (?:do|don't|not) line|pre-?drilled|line up|square|lệch/i,
    anchors: [/[^\n.]{0,30}(?:holes?|line up|square)[^\n.]{0,50}/i],
    suggestion: {
      effortHint: 2,
      factoryRequirement: "Dùng đồ gá định vị lỗ khoan, QC kiểm 100% khoảng cách lỗ trên chuẩn.",
      listingFix: "Thêm video hướng dẫn lắp từng bước rõ ràng.",
      testMethod: "Lắp thử với vít chuẩn trên 5% sản phẩm mỗi lô.",
      acceptanceStandard: "Lắp vuông thành, không phải ép vít; sai lệch tâm lỗ ≤0,5mm.",
      costImpactEstimate: "+0,1 USD/đơn vị",
    },
  },
  {
    cluster: "expectation_gap",
    subLabel: "kích thước",
    painTitle: "Sản phẩm nhỏ hơn kỳ vọng so với hình ảnh",
    re: /smaller|bigger|dimensions|look (?:bigger|larger)|fit upright|nhỏ hơn|kích thước/i,
    anchors: [/[^\n.]{0,40}(?:smaller|bigger|dimensions|fit upright)[^\n.]{0,40}/i],
    suggestion: {
      effortHint: 1,
      factoryRequirement: null,
      listingFix:
        "Thêm ảnh so sánh kích thước với vật chuẩn (đĩa ăn/tay người), ghi rõ kích thước lọt lòng theo inch và cm.",
      testMethod: null,
      acceptanceStandard: null,
      costImpactEstimate: null,
    },
  },
  {
    cluster: "expectation_gap",
    subLabel: "mỏng hơn kỳ vọng",
    painTitle: "Vật liệu mỏng hơn cảm nhận trên listing",
    re: /thinner|than expected|cheap(?:ly)? made|feels cheap|mỏng/i,
    anchors: [/[^\n.]{0,30}(?:thinner|thin|cheap)[^\n.]{0,50}/i],
    suggestion: {
      effortHint: 2,
      factoryRequirement: "Công bố độ dày danh định và tăng độ dày tối thiểu tại các điểm chịu lực.",
      listingFix: "Ghi rõ độ dày vật liệu và khả năng chịu tải tối đa trong ảnh infographic.",
      testMethod: "Đo độ dày bằng panme tại 3 điểm trên mỗi thành.",
      acceptanceStandard: "Độ dày đạt danh định ±0,05mm ở mọi điểm đo.",
      costImpactEstimate: "+0,2–0,4 USD/đơn vị",
    },
  },
  {
    cluster: "logistics",
    subLabel: "móp trầy khi giao",
    painTitle: "Hàng móp/trầy khi giao do đóng gói mỏng",
    re: /packag|crushed|dented|bent in the corner|scratched on arrival|arrived (?:damaged|dented|bent|scratched)|bao bì|móp/i,
    anchors: [/[^\n.]{0,20}(?:packag(?:ing)?|crushed|dented|scratched on arrival|arrived [^\n.]{0,30})[^\n.]{0,40}/i],
    suggestion: {
      effortHint: 2,
      factoryRequirement: "Đổi sang hộp carton 5 lớp, thêm góc đổ và xốp/khay định vị khớp sản phẩm.",
      listingFix: null,
      testMethod: "Thử rơi vận chuyển theo ISTA 3A (6 cạnh, 8 góc, 12 mặt).",
      acceptanceStandard: "Sau thử rơi: sản phẩm không móp/trầy, hộp không thủng.",
      costImpactEstimate: "+0,25–0,5 USD/đơn vị",
    },
  },
  {
    cluster: "logistics",
    subLabel: "thiếu linh kiện",
    painTitle: "Thiếu vít/phụ kiện trong túi hardware",
    re: /missing|hardware pack|screws?|parts?|thiếu/i,
    anchors: [/[^\n.]{0,30}(?:missing|hardware pack|screws?)[^\n.]{0,50}/i],
    suggestion: {
      effortHint: 1,
      factoryRequirement: "Đóng túi phụ kiện theo định lượng (kít định vị), checklist QC điểm danh trước khi niêm thùng.",
      listingFix: "Liệt kê định lượng từng loại vít trong hướng dẫn và trên hộp.",
      testMethod: "Đối soát túi hardware theo bảng định lượng 100% trước đóng thùng.",
      acceptanceStandard: "0 hồ sơ thiếu linh kiện trên 3 lô liên tiếp.",
      costImpactEstimate: "+0,05–0,1 USD/đơn vị",
    },
  },
];

/** Cắt 1 cửa sổ ≤25 từ quanh vị trí match, đảm bảo là substring của body. */
function cutAround(body: string, anchor: RegExp): string | null {
  const m = anchor.exec(body);
  if (!m) return null;
  return extractVerbatimQuote(m[0], body);
}

function observeReview(r: AnalysisReview): PainObservation[] {
  const out: PainObservation[] = [];
  const haystack = `${r.title ?? ""} ${r.body}`;
  for (const rule of RULES) {
    if (!rule.re.test(haystack)) continue;
    let quote: string | null = null;
    for (const a of rule.anchors) {
      quote = cutAround(r.body, a);
      if (quote) break;
    }
    if (!quote) continue;
    out.push({
      reviewId: r.sourceReviewId,
      cluster: rule.cluster,
      subLabel: rule.subLabel,
      painTitle: rule.painTitle,
      quote,
    });
    if (out.length >= 2) break; // tối đa 2 quan sát/review như prompt yêu cầu model thật
  }
  return out;
}

const slug = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

const CLUSTER_NARRATIVE_LABEL: Record<PainClusterCode, string> = {
  quality: "chất lượng sản phẩm",
  expectation_gap: "lệch kỳ vọng so với mô tả",
  logistics: "đóng gói và vận hành",
};

export class MockLlmProvider implements LlmProvider {
  readonly name = "mock" as const;
  readonly model = MOCK_MODEL;

  async mapPainChunk(input: MapChunkInput): Promise<LlmCallResult<MapChunkOutput>> {
    const observations = input.reviews.flatMap(observeReview);
    const data: MapChunkOutput = { observations };
    return {
      data,
      promptHash: hashMessages(buildMapMessages(input)),
      usage: {
        promptTokens: estimateTokens(JSON.stringify(input.reviews)),
        outputTokens: estimateTokens(JSON.stringify(data)),
      },
      model: this.model,
    };
  }

  async reducePain(input: ReducePainInput): Promise<LlmCallResult<ReducePainOutput>> {
    const groups = new Map<string, { rule: Rule; reviewIds: Set<string> }>();
    for (const o of input.observations) {
      const rule = RULES.find((r) => r.cluster === o.cluster && r.painTitle === o.painTitle);
      if (!rule) continue;
      const g = groups.get(rule.painTitle) ?? { rule, reviewIds: new Set<string>() };
      g.reviewIds.add(o.reviewId);
      groups.set(rule.painTitle, g);
    }

    const drafts: PainItemDraft[] = [...groups.values()]
      .sort((a, b) => b.reviewIds.size - a.reviewIds.size)
      .slice(0, 5)
      .map((g) => ({
        itemKey: slug(g.rule.painTitle),
        cluster: g.rule.cluster,
        title: g.rule.painTitle,
        subLabel: g.rule.subLabel,
        reviewIds: [...g.reviewIds],
        ...g.rule.suggestion,
      }));

    const narratives: ReducePainOutput["narratives"] = {};
    for (const code of ["quality", "expectation_gap", "logistics"] as PainClusterCode[]) {
      const inCluster = drafts.filter((d) => d.cluster === code);
      if (inCluster.length) {
        narratives[code] =
          `Nhóm ${CLUSTER_NARRATIVE_LABEL[code]} ghi nhận: ${inCluster
            .map((i) => i.title.toLowerCase())
            .join("; ")}. (Nội dung AI MOCK nháp — bắt buộc đối chiếu khi chạy model thật.)`;
      }
    }

    const data: ReducePainOutput = {
      drafts,
      narratives,
      executiveNarrative: drafts.length
        ? `Phân tích MOCK: phát hiện ${drafts.length} điểm đau chính từ ${input.observations.length} quan sát; ưu tiên các pain tần suất cao có hướng khắc phục tại xưởng. Khi nối OpenAI, nội dung do gpt-4.1-mini phân tích thay thế.`
        : "Mẫu review không phát hiện điểm đau hệ thống (MOCK).",
    };
    return {
      data,
      promptHash: hashMessages(buildReduceMessages(input)),
      usage: {
        promptTokens: estimateTokens(JSON.stringify(input.observations)),
        outputTokens: estimateTokens(JSON.stringify(data)),
      },
      model: this.model,
    };
  }

  /** G5: nháp narrative deterministic từ chính các token được cấp. */
  async sectionNarrative(
    input: SectionNarrativeInput,
  ): Promise<LlmCallResult<SectionNarrativeOutput>> {
    const m = input.metrics.slice(0, 5);
    const q = input.quotes.slice(0, 3);
    const lines: string[] = [];

    const opening: Record<string, string> = {
      exec_verdict:
        "### Tóm tắt điều hành\nKhuyến nghị ở mức **kiểm chứng nhỏ trước khi quyết định nhập lớn**; mọi số dưới đây là số máy tính, chuyên viên phải đối chiếu lại.",
      risk_register:
        "### Sổ đăng ký rủi ro\nMọi cờ veto do engine tính phải được hội đồng nhìn nhận; chuyên viên chỉ ghi biên bản phản biện, không gỡ cờ.",
      rd_specsheet:
        "### Spec sheet gửi xưởng\nCác yêu cầu dưới đây là **llm_suggested**, chưa phải chỉ thị sản xuất; trưởng nhóm R&D phải ký xác nhận từng dòng.",
      appendix_signoff:
        "### Bảng ký tên\nTài liệu gồm phần AI soạn nháp và phần chuyên viên hiệu đính; mọi số lấy từ engine tại ngày chụp version.",
    };
    if (opening[input.sectionKey]) lines.push(opening[input.sectionKey]);

    if (m.length) {
      lines.push("Số liệu then chốt:");
      for (const token of m) {
        lines.push(`- ${token.label}: {{metric:${token.key}}} (chỉ dẫn ${token.value}).`);
      }
    } else {
      lines.push("Hiện **chưa đủ cơ sở** cho các chỉ số của mục này; chờ thu thập thêm ở G2/G3.");
    }
    if (q.length && (input.sectionKey.startsWith("rd_") || input.sectionKey === "exec_verdict")) {
      lines.push("Bằng chứng khách hàng tiêu biểu:");
      for (const quote of q) lines.push(`- {{quote:${quote.reviewId}}}`);
    }
    lines.push(
      "*(Nội dung MOCK nháp để chạy quy trình; khi có LLM_API_KEY, phần này do gpt-4.1-mini soạn và vẫn phải hiệu đính trước khi ký.)*",
    );

    const data: SectionNarrativeOutput = { markdown: lines.join("\n") };
    return {
      data,
      promptHash: hashMessages(buildSectionMessages(input)),
      usage: {
        promptTokens: estimateTokens(input.context + JSON.stringify(input.metrics)),
        outputTokens: estimateTokens(JSON.stringify(data)),
      },
      model: this.model,
    };
  }
}
