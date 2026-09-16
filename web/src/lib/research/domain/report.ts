/**
 * Module 8 G5 — Report Canvas domain thuần (KHÔNG TipTap/React ở đây).
 *
 * 6 nguyên tắc vàng (docs/ke-hoach... mục 1.4):
 *  - SỐ là khối metric token khóa cứng, lấy từ engine/snapshot, không sửa
 *    trong editor được (chỉ sửa ở màn giả định → engine chạy lại).
 *  - CÂU TRÍCH là quote chip khóa cứng, lưu xuống DB bị đối chiếu nguyên văn
 *    với reviews_raw (trigger migration 0029).
 *  - Editor chỉ chứa CHỮ (narrative): đậm/nghiêng/danh sách/link + 2 loại
 *    chip chỉ-đọc. Mọi chuyển đổi markdown LLM → TipTap doc đều test được.
 */

/* ============================ SECTION REGISTRY ========================== */

export type ReportSectionGroup = "exec" | "fin" | "mkt" | "rd" | "roadmap" | "risk" | "appendix";

export type SectionDef = {
  key: string;
  group: ReportSectionGroup;
  /** tiêu đề hiển thị trên canvas/PDF */
  title: string;
  /** section bắt buộc verified trước khi duyệt (state machine ở DB) */
  required: boolean;
  /** có khối narrative sửa được; false = chỉ khối dữ liệu (bìa) */
  narrative: boolean;
  /** gợi ý nội dung cho prompt LLM */
  brief: string;
};

export const SECTION_GROUPS: { key: ReportSectionGroup; title: string }[] = [
  { key: "exec", title: "Tóm tắt điều hành" },
  { key: "fin", title: "Tab 1 — Tài chính" },
  { key: "mkt", title: "Tab 2 — Thị trường" },
  { key: "rd", title: "Tab 3 — R&D / điểm đau" },
  { key: "roadmap", title: "Tab 4 — Lộ trình" },
  { key: "risk", title: "Rủi ro" },
  { key: "appendix", title: "Phụ lục & ký tên" },
];

/**
 * Bản đồ section v1 theo PHỤ LỤC B kế hoạch. Một số khối chi tiết
 * (fin_scale, mkt_toplist…) là khối DỮ LIỆU component thường; narrative
 * gom vào section chính của tab để gọn cho v1.
 */
export const SECTION_REGISTRY: SectionDef[] = [
  { key: "cover", group: "exec", title: "Bìa & metadata", required: false, narrative: false, brief: "" },
  {
    key: "exec_verdict",
    group: "exec",
    title: "Tóm tắt điều hành (3 nên / 3 rủi ro)",
    required: true,
    narrative: true,
    brief: "3 lý do NÊN và 3 rủi ro LỚN nhất, dẫn chiếu scorecard và các cờ veto; kết luận điều kiện test.",
  },
  {
    key: "fin_assumptions",
    group: "fin",
    title: "Giả định đầu vào & vốn test",
    required: false,
    narrative: true,
    brief: "giá 3 kịch bản, COGS, freight, khối lượng, CPC giả định, vốn test khuyến nghị.",
  },
  {
    key: "fin_pnl",
    group: "fin",
    title: "P&L 3 kịch bản & phí FBA",
    required: true,
    narrative: true,
    brief: "diễn giải biên lợi nhuận 3 kịch bản và bảng phí FBA; cảnh báo biên <20% nếu có.",
  },
  {
    key: "fin_scale",
    group: "fin",
    title: "Mô phỏng quy mô & size tier",
    required: false,
    narrative: true,
    brief: "size tier, mô phỏng lợi nhuận theo đơn lượng, điểm hòa vốn.",
  },
  {
    key: "fin_packaging",
    group: "fin",
    title: "Đóng gói & logistics",
    required: false,
    narrative: true,
    brief: "tier FBA, trọng lượng quy đổi, lưu ý đóng gói.",
  },
  {
    key: "mkt_definition",
    group: "mkt",
    title: "Định nghĩa ngách",
    required: false,
    narrative: true,
    brief: "từ khóa, marketplace, định nghĩa sản phẩm, hành vi mua.",
  },
  {
    key: "mkt_toplist",
    group: "mkt",
    title: "Top đối thủ",
    required: false,
    narrative: true,
    brief: "nhận xét nhanh top đối thủ organic, giá, rating.",
  },
  {
    key: "mkt_share",
    group: "mkt",
    title: "Tập trung thị trường CR3/CR5/HHI",
    required: false,
    narrative: true,
    brief: "diễn giải CR3/CR5/HHI, tỷ lệ sponsored, Amazon 1P.",
  },
  {
    key: "mkt_structure",
    group: "mkt",
    title: "Cấu trúc BSR & review velocity",
    required: false,
    narrative: true,
    brief: "phân bố BSR, velocity review, đơn/tháng ước lượng.",
  },
  {
    key: "mkt_conclusion",
    group: "mkt",
    title: "Kết luận thị trường",
    required: true,
    narrative: true,
    brief: "kết luận mức cạnh tranh/demand và đề xuất bước tiếp theo.",
  },
  {
    key: "rd_method",
    group: "rd",
    title: "Phương pháp đọc review",
    required: false,
    narrative: true,
    brief: "cỡ mẫu review 1–3★, số ASIN, model LLM, quy tắc truy nguyên câu trích.",
  },
  {
    key: "rd_clusters",
    group: "rd",
    title: "3 cụm điểm đau & tần suất",
    required: true,
    narrative: true,
    brief: "tóm tắt 3 cụm quality/expectation/logistics kèm câu trích đại diện.",
  },
  {
    key: "rd_pain_top",
    group: "rd",
    title: "Top pain & trích dẫn truy gốc",
    required: false,
    narrative: true,
    brief: "điểm đau ưu tiên cao nhất với quote chip truy gốc.",
  },
  {
    key: "rd_specsheet",
    group: "rd",
    title: "Spec sheet gửi xưởng",
    required: true,
    narrative: true,
    brief: "yêu cầu kỹ thuật, cách kiểm, tiêu chuẩn đạt, tác động giá; nhãn llm_suggested chờ người ký.",
  },
  {
    key: "rd_priority",
    group: "rd",
    title: "Ma trận impact × effort",
    required: false,
    narrative: true,
    brief: "thứ tự khắc phục theo ma trận.",
  },
  {
    key: "roadmap_phase0",
    group: "roadmap",
    title: "Giai đoạn 0 — kiểm chứng",
    required: false,
    narrative: true,
    brief: "mục tiêu, đơn lượng test, ngân sách mẫu.",
  },
  {
    key: "roadmap_order",
    group: "roadmap",
    title: "Thứ tự đặt hàng & nhà cung cấp",
    required: false,
    narrative: true,
    brief: "thứ tự mẫu, nhà cung cấp, cải tiến cần chốt.",
  },
  {
    key: "roadmap_ads",
    group: "roadmap",
    title: "Kế hoạch quảng cáo khởi đầu",
    required: false,
    narrative: true,
    brief: "ngân sách PPC khởi đầu, CPC giả định, mục tiêu ACOS.",
  },
  {
    key: "roadmap_gates",
    group: "roadmap",
    title: "Mốc quyết định & kill-criteria",
    required: true,
    narrative: true,
    brief: "các mốc go/kill và ngưỡng dừng lỗ tối đa (max loss).",
  },
  {
    key: "roadmap_cashflow",
    group: "roadmap",
    title: "Dòng tiền & kịch bản lỗ",
    required: false,
    narrative: true,
    brief: "nhu cầu vốn, kịch bản lỗ tối đa, thời gian hoàn vốn.",
  },
  {
    key: "risk_register",
    group: "risk",
    title: "Sổ đăng ký rủi ro & veto",
    required: true,
    narrative: true,
    brief: "liệt kê mọi cờ veto đỏ/vàng kèm biên bản phản biện; cờ không gỡ được.",
  },
  {
    key: "appendix_method",
    group: "appendix",
    title: "Phụ lục — phương pháp & nguồn",
    required: false,
    narrative: true,
    brief: "nguồn dữ liệu Rainforest/BSR, ngày lấy, model LLM, prompt version.",
  },
  {
    key: "appendix_limits",
    group: "appendix",
    title: "Phụ lục — giới hạn số liệu",
    required: false,
    narrative: true,
    brief: "sai số sales estimate 20–40%, TTL 30 ngày, số thiếu để 'chưa đủ cơ sở'.",
  },
  {
    key: "appendix_glossary",
    group: "appendix",
    title: "Phụ lục — thuật ngữ",
    required: false,
    narrative: true,
    brief: "CR3/HHI/BSR/1P/ACOS...",
  },
  {
    key: "appendix_signoff",
    group: "appendix",
    title: "Bảng ký tên",
    required: true,
    narrative: true,
    brief: "3 chữ ký: người soát, trưởng phòng duyệt, CEO; ghi rõ phần AI soạn nháp–người hiệu đính.",
  },
];

export const SECTION_BY_KEY: Record<string, SectionDef> = Object.fromEntries(
  SECTION_REGISTRY.map((s) => [s.key, s]),
);

/** Danh sách section BẮT BUỘC verified để duyệt (phải khớp danh sách trong migration 0029). */
export const REQUIRED_SECTIONS: string[] = SECTION_REGISTRY.filter((s) => s.required).map((s) => s.key);

/* ============================== TIPTAP TYPES ============================= */

export type ChipMark = { type: "metricToken"; attrs: { key: string; label: string; value: string } };
export type QuoteChipNode = {
  type: "quoteChip";
  attrs: { reviewId: string; asin: string; quote: string; stars: number | null; reviewDate: string | null; url: string | null };
};

/** TipTap doc JSON (tập node đã kiểm soát: paragraph, bulletList, listItem, heading, text + chip). */
export type TiptapNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TiptapNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
};
export type TiptapDoc = { type: "doc"; content?: TiptapNode[] };

export type MetricToken = { key: string; label: string; value: string };
export type QuoteToken = QuoteChipNode["attrs"] & { reviewId: string };

export type NarrativeResolution = {
  metrics: Map<string, MetricToken>;
  quotes: Map<string, QuoteToken>;
};

/* ============================ DOC THUẦN VĂN ============================== */

const CHIP_NODE = new Set(["metricToken", "quoteChip"]);
const TEXT_NODE = new Set(["paragraph", "heading", "listItem", "doc"]);

/** Trích toàn bộ chữ hiển thị của 1 node (kèm nhãn chip) — dùng cho diff/đếm từ. */
export function nodeToText(node: TiptapNode): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  if (node.type === "metricToken") return String(node.attrs?.label ?? node.attrs?.key ?? "");
  if (node.type === "quoteChip") {
    const a = node.attrs ?? {};
    return `"${a.quote ?? ""}"`;
  }
  if (node.type === "bulletList" || node.type === "orderedList") {
    return (node.content ?? []).map((c, i) => `• ${nodeToText(c).trim()}`).join("\n");
  }
  if (node.type === "listItem") return (node.content ?? []).map(nodeToText).join(" ");
  if (TEXT_NODE.has(node.type)) return (node.content ?? []).map(nodeToText).join("");
  return (node.content ?? []).map(nodeToText).join("");
}

export function docToPlainText(doc: TiptapDoc | null | undefined): string {
  if (!doc?.content) return "";
  return doc.content
    .map((n) => (n.type === "bulletList" || n.type === "orderedList" ? nodeToText(n) : nodeToText(n)))
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function docWordCount(doc: TiptapDoc | null | undefined): number {
  return (docToPlainText(doc).match(/[\p{L}\p{N}]+/gu) ?? []).length;
}

export function docHasContent(doc: TiptapDoc | null | undefined): boolean {
  if (!doc?.content) return false;
  for (const n of doc.content) {
    if (CHIP_NODE.has(n.type)) return true;
    if (nodeToText(n).trim()) return true;
  }
  return false;
}

export function emptyDoc(): TiptapDoc {
  return { type: "doc", content: [{ type: "paragraph" }] };
}

/* ===================== MARKDOWN LITE → TIPTAP DOC ======================== */
/**
 * LLM trả markdown TỐI GIẢN: đoạn văn, ### tiêu đề, - đầu dòng, **đậm**,
 * *nghiêng*, [link](url), và token {{metric:key}} / {{quote:reviewId}}.
 * Token không giải nghĩa được (không có trong NarrativeContext) sẽ bị BỎ và
 * đếm công khai → action trả lại số liệu cho UI, không âm thầm nuốt.
 */

const INLINE_TOKEN = /\{\{(metric|quote):([\w.]+)\}\}/g;
const INLINE_BOLD = /\*\*([^*]+)\*\*/g;
const INLINE_ITALIC = /(^|[\s(])\*([^*]+)\*/g;
const INLINE_LINK = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

type InlineResult = { nodes: TiptapNode[]; missingTokens: string[] };

function textNode(text: string, marks?: TiptapNode["marks"]): TiptapNode {
  return { type: "text", text, ...(marks?.length ? { marks } : {}) };
}

function parseInline(raw: string, res: NarrativeResolution): InlineResult {
  const missingTokens: string[] = [];
  const nodes: TiptapNode[] = [];
  let cursor = 0;
  const pushText = (s: string, marks?: TiptapNode["marks"]) => {
    if (!s) return;
    const last = nodes[nodes.length - 1];
    if (last?.type === "text" && JSON.stringify(last.marks ?? null) === JSON.stringify(marks ?? null)) {
      last.text += s;
    } else {
      nodes.push(textNode(s, marks));
    }
  };

  // Quét 1 lượt theo trộn các token đặc biệt (metric/quote trước, rồi định dạng).
  // id review Amazon có thể chứa gạch nối/chữ hoa → cho [\w.\-].
  const re = /\{\{(metric|quote):([\w.-]+)\}\}|\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    pushText(raw.slice(cursor, m.index));
    if (m[1] === "metric") {
      const token = res.metrics.get(m[2]);
      if (token) {
        nodes.push({ type: "metricToken", attrs: { key: token.key, label: token.label, value: token.value } });
      } else {
        missingTokens.push(`metric:${m[2]}`);
      }
    } else if (m[1] === "quote") {
      const q = res.quotes.get(m[2]);
      if (q) {
        nodes.push({ type: "quoteChip", attrs: { ...q } });
      } else {
        missingTokens.push(`quote:${m[2]}`);
      }
    } else if (m[3] !== undefined) {
      pushText(m[3], [{ type: "bold" }]);
    } else if (m[4] !== undefined) {
      pushText(m[4], [{ type: "link", attrs: { href: m[5], target: "_blank" } }]);
    }
    cursor = re.lastIndex;
  }
  pushText(raw.slice(cursor));

  // Nghiêng xử lý sau trên các text node chưa có mark (đơn giản hóa 1 cấp).
  void INLINE_TOKEN; void INLINE_BOLD; void INLINE_ITALIC; void INLINE_LINK;
  return { nodes, missingTokens };
}

export type MarkdownConvertResult = { doc: TiptapDoc; missingTokens: string[] };

export function markdownLiteToDoc(markdown: string, res: NarrativeResolution): MarkdownConvertResult {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const content: TiptapNode[] = [];
  const missingTokens: string[] = [];
  let bulletBuffer: TiptapNode[] = [];

  const flushBullets = () => {
    if (bulletBuffer.length) {
      content.push({ type: "bulletList", content: bulletBuffer });
      bulletBuffer = [];
    }
  };

  for (const lineRaw of lines) {
    const line = lineRaw.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) {
      flushBullets();
      continue;
    }
    const heading = /^(#{2,3})\s+(.*)$/.exec(trimmed);
    const bullet = /^[-*]\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushBullets();
      const parsed = parseInline(heading[2], res);
      missingTokens.push(...parsed.missingTokens);
      content.push({ type: "heading", attrs: { level: heading[1].length === 2 ? 2 : 3 }, content: parsed.nodes });
      continue;
    }
    if (bullet) {
      const parsed = parseInline(bullet[1], res);
      missingTokens.push(...parsed.missingTokens);
      bulletBuffer.push({ type: "listItem", content: [{ type: "paragraph", content: parsed.nodes }] });
      continue;
    }
    flushBullets();
    const parsed = parseInline(trimmed, res);
    missingTokens.push(...parsed.missingTokens);
    content.push({ type: "paragraph", content: parsed.nodes });
  }
  flushBullets();

  return {
    doc: { type: "doc", content: content.length ? content : [emptyDoc().content![0]] },
    missingTokens: [...new Set(missingTokens)],
  };
}

/* ============================ DIFF 2 BẢN NỘI DUNG ======================== */

export type DiffSegment = { type: "same" | "added" | "removed"; text: string };

/**
 * Diff theo đoạn văn (LCS) giữa 2 bản TipTap doc — phục vụ màn hình
 * "regenerate kèm diff" trước khi người duyệt chấp nhận bản LLM mới.
 */
export function diffDocs(prev: TiptapDoc | null, next: TiptapDoc | null): DiffSegment[] {
  const a = docToPlainText(prev).split("\n").map((s) => s.trim()).filter(Boolean);
  const b = docToPlainText(next).split("\n").map((s) => s.trim()).filter(Boolean);
  // bảng LCS
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffSegment[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ type: "same", text: a[i] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: "removed", text: a[i] });
      i++;
    } else {
      out.push({ type: "added", text: b[j] });
      j++;
    }
  }
  while (i < a.length) out.push({ type: "removed", text: a[i++] });
  while (j < b.length) out.push({ type: "added", text: b[j++] });
  return out;
}

/* =========================== TRẠNG THÁI SECTION ========================== */

export type SectionStatus = "drafted" | "in_review" | "verified";
export type ReportVersionStatus =
  | "draft"
  | "in_review"
  | "changes_requested"
  | "approved"
  | "published"
  | "stale";

export const SECTION_STATUS_FLOW: Record<SectionStatus, SectionStatus[]> = {
  drafted: ["in_review", "verified"],
  in_review: ["verified", "drafted"],
  verified: ["drafted"], // mở lại khi phát hiện sai
};

export function canTransitionSection(from: SectionStatus, to: SectionStatus): boolean {
  return from === to || SECTION_STATUS_FLOW[from].includes(to);
}

/** Chỉ được sửa narrative khi version còn 'draft' và section chưa verified. */
export function canEditSection(versionStatus: ReportVersionStatus, sectionStatus: SectionStatus): boolean {
  return versionStatus === "draft" && sectionStatus !== "verified";
}

/**
 * Sửa nội dung 1 section ĐÃ verified phải hạ lại drafted (chữ ký cũ mất hiệu
 * lực) — nguyên tắc: nội dung đổi sau chữ ký thì phải ký lại.
 */
export function sectionStatusAfterEdit(status: SectionStatus): SectionStatus {
  return status === "verified" ? "drafted" : status;
}

export type RequiredCheck = {
  missing: string[];
  complete: boolean;
};

export function checkRequiredSections(statusByKey: Record<string, SectionStatus | undefined>): RequiredCheck {
  const missing = REQUIRED_SECTIONS.filter((k) => statusByKey[k] !== "verified");
  return { missing, complete: missing.length === 0 };
}

/* ============================ QUÉT CHIP TRONG DOC ======================== */

export type DocRefs = { metricKeys: string[]; quoteReviewIds: string[] };

export function collectDocRefs(doc: TiptapDoc | null | undefined): DocRefs {
  const metricKeys: string[] = [];
  const quoteReviewIds: string[] = [];
  const walk = (n: TiptapNode): void => {
    if (n.type === "metricToken" && typeof n.attrs?.key === "string") metricKeys.push(n.attrs.key);
    if (n.type === "quoteChip" && typeof n.attrs?.reviewId === "string") quoteReviewIds.push(n.attrs.reviewId);
    n.content?.forEach(walk);
  };
  doc?.content?.forEach(walk);
  return { metricKeys: [...new Set(metricKeys)], quoteReviewIds: [...new Set(quoteReviewIds)] };
}

/**
 * Kiểm định hình thái doc (không kiểm NGUỒN số — nguồn do app/trigger kiểm).
 * Trả mảng lỗi tiếng Việt; rỗng = hợp lệ.
 */
export function validateDocShape(doc: unknown): string[] {
  const errors: string[] = [];
  if (!doc || typeof doc !== "object") return ["nội dung không phải JSON hợp lệ"];
  const root = doc as TiptapDoc;
  if (root.type !== "doc") return ["doc thiếu gốc type='doc'"];
  const allowedTop = new Set(["paragraph", "heading", "bulletList", "orderedList"]);
  const walk = (n: unknown, path: string, allowed: Set<string>): void => {
    if (!n || typeof n !== "object" || !("type" in n)) {
      errors.push(`${path}: node không hợp lệ`);
      return;
    }
    const node = n as TiptapNode;
    if (!allowed.has(node.type)) {
      errors.push(`${path}: loại node không cho phép "${node.type}"`);
      return;
    }
    if (node.type === "metricToken") {
      if (!node.attrs?.key || !node.attrs?.value) errors.push(`${path}: metric chip thiếu key/value`);
      return;
    }
    if (node.type === "quoteChip") {
      const a = node.attrs ?? {};
      if (!a.reviewId || !a.quote) errors.push(`${path}: quote chip thiếu reviewId/quote`);
      return;
    }
    node.content?.forEach((c, i) => {
      let childAllowed: Set<string>;
      if (node.type === "bulletList" || node.type === "orderedList") childAllowed = new Set(["listItem"]);
      else if (node.type === "listItem") childAllowed = new Set(["paragraph", "bulletList"]);
      else childAllowed = new Set(["text", "metricToken", "quoteChip", "hardBreak"]);
      walk(c, `${path}>${i}`, childAllowed);
    });
  };
  (root.content ?? []).forEach((n, i) => walk(n, `doc[${i}]`, allowedTop));
  return errors;
}
