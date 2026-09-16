/**
 * Module 8 G5 — test domain Report Canvas:
 * markdown-lite → TipTap doc (chỉ chip giải nghĩa được), diff, máy trạng thái,
 * kiểm định hình thái doc, truy vết chip.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  REQUIRED_SECTIONS,
  SECTION_REGISTRY,
  canEditSection,
  canTransitionSection,
  checkRequiredSections,
  collectDocRefs,
  diffDocs,
  docHasContent,
  docToPlainText,
  docWordCount,
  emptyDoc,
  markdownLiteToDoc,
  sectionStatusAfterEdit,
  validateDocShape,
  type NarrativeResolution,
  type TiptapDoc,
} from "../src/lib/research/domain/report.ts";

const resolution = (): NarrativeResolution => ({
  metrics: new Map([
    ["base_margin_pct", { key: "base_margin_pct", label: "Biên lợi nhuận cơ sở", value: "18,4%" }],
    ["median_units", { key: "median_units", label: "Đơn/tháng trung vị", value: "3.100" }],
  ]),
  quotes: new Map([
    [
      "GRV-1",
      {
        reviewId: "GRV-1",
        asin: "B0G5001",
        quote: "started rusting after three weeks next to the sink",
        stars: 1,
        reviewDate: "2026-09-01",
        url: "https://www.amazon.test/dp/GRV-1",
      },
    ],
  ]),
});

test("registry: 8 section bắt buộc, đủ nhóm theo phụ lục B", () => {
  assert.deepEqual(REQUIRED_SECTIONS, [
    "exec_verdict",
    "fin_pnl",
    "mkt_conclusion",
    "rd_clusters",
    "rd_specsheet",
    "roadmap_gates",
    "risk_register",
    "appendix_signoff",
  ]);
  for (const key of REQUIRED_SECTIONS) {
    const def = SECTION_REGISTRY.find((s) => s.key === key);
    assert.ok(def?.narrative && def.required, `${key} phải là narrative bắt buộc`);
  }
  assert.ok(SECTION_REGISTRY.some((s) => s.key === "cover" && !s.narrative));
});

test("markdown: đoạn, heading, bullet, đậm, link đổi đúng cấu trúc TipTap", () => {
  const md = `### Tóm tắt
Đây là **điểm mấu chốt** cần nắm.

- ý một, xem [nguồn](https://example.test/a)
- ý hai`;
  const { doc, missingTokens } = markdownLiteToDoc(md, resolution());
  assert.deepEqual(missingTokens, []);
  assert.equal(doc.content?.[0]?.type, "heading");
  assert.equal((doc.content?.[0]?.attrs as { level: number }).level, 3);
  const bullet = doc.content?.find((n) => n.type === "bulletList");
  assert.equal(bullet?.content?.length, 2);
  // mark đậm + link
  const flat = JSON.stringify(doc);
  assert.match(flat, /"type":"bold"/);
  assert.match(flat, /"type":"link"/);
  assert.match(flat, /example\.test/);
});

test("markdown: token metric/quote đổi thành chip khóa cứng", () => {
  const md = "Biên {{metric:base_margin_pct}} là rất mỏng. Bằng chứng: {{quote:GRV-1}}";
  const { doc } = markdownLiteToDoc(md, resolution());
  const refs = collectDocRefs(doc);
  assert.deepEqual(refs.metricKeys, ["base_margin_pct"]);
  assert.deepEqual(refs.quoteReviewIds, ["GRV-1"]);
  const flat = JSON.stringify(doc);
  assert.match(flat, /"type":"metricToken"/);
  assert.match(flat, /18,4%/);
  assert.match(flat, /"type":"quoteChip"/);
  // chip mang đủ metadata truy gốc
  assert.match(flat, /B0G5001/);
  assert.match(flat, /amazon\.test/);
});

test("markdown: token không được cấp (số/câu bịa) bị BỎ và đếm công khai", () => {
  const md = "Số bịa {{metric:magic_number}} và câu bịa {{quote:FAKE-9}}.";
  const { doc, missingTokens } = markdownLiteToDoc(md, resolution());
  assert.deepEqual(missingTokens.sort(), ["metric:magic_number", "quote:FAKE-9"].sort());
  const text = docToPlainText(doc);
  assert.ok(!text.includes("magic"));
  assert.ok(!text.includes("FAKE"));
});

test("doc helpers: empty/trống/đếm từ", () => {
  assert.equal(docHasContent(emptyDoc()), false);
  assert.equal(docHasContent({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Có nội dung" }] }] }), true);
  const doc: TiptapDoc = {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "một hai ba bốn" }] }],
  };
  assert.equal(docWordCount(doc), 4);
});

test("validateDocShape: nhận doc hợp lệ chip, loại node lạ / chip rỗng", () => {
  const ok = markdownLiteToDoc("Biên {{metric:base_margin_pct}} · {{quote:GRV-1}}", resolution()).doc;
  assert.deepEqual(validateDocShape(ok), []);

  const badNode: unknown = { type: "doc", content: [{ type: "image", attrs: { src: "x" } }] };
  assert.match(validateDocShape(badNode)[0] ?? "", /không cho phép/);

  const badChip: unknown = {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "metricToken", attrs: { key: "", value: "" } }] }],
  };
  assert.match(validateDocShape(badChip)[0] ?? "", /thiếu key\/value/);

  assert.match(validateDocShape(null)[0] ?? "", /JSON/);
  assert.match(validateDocShape({ type: "paragraph" })[0] ?? "", /type='doc'/);
});

test("diff: giữ đoạn trùng, đánh dấu thêm/xóa", () => {
  const a = markdownLiteToDoc("Đoạn một.\nĐoạn hai.\nĐoạn ba.", resolution()).doc;
  const b = markdownLiteToDoc("Đoạn một.\nĐoạn hai đã sửa.\nĐoạn bốn.", resolution()).doc;
  const segments = diffDocs(a, b);
  const kinds = new Set(segments.map((s) => s.type));
  assert.ok(kinds.has("added") && kinds.has("removed"));
  assert.ok(segments.some((s) => s.type === "same" && s.text.includes("Đoạn một")));
  assert.ok(segments.some((s) => s.type === "removed" && s.text.includes("Đoạn ba")));
  assert.ok(segments.some((s) => s.type === "added" && s.text.includes("Đoạn bốn")));
});

test("state machine section: luồng drafted→verified→(sửa lại)drafted", () => {
  assert.ok(canTransitionSection("drafted", "verified"));
  assert.ok(canTransitionSection("verified", "drafted"));
  assert.ok(!canTransitionSection("verified", "in_review"));
  assert.equal(sectionStatusAfterEdit("verified"), "drafted");
  assert.equal(sectionStatusAfterEdit("drafted"), "drafted");
});

test("chỉ sửa narrative khi version draft và section chưa verified", () => {
  assert.ok(canEditSection("draft", "drafted"));
  assert.ok(!canEditSection("draft", "verified"));
  assert.ok(!canEditSection("in_review", "drafted"));
  assert.ok(!canEditSection("approved", "drafted"));
});

test("checkRequiredSections: liệt kê đủ/thiếu", () => {
  const ok = Object.fromEntries(REQUIRED_SECTIONS.map((k) => [k, "verified" as const]));
  assert.equal(checkRequiredSections(ok).complete, true);
  const missing = checkRequiredSections({ ...ok, fin_pnl: "drafted" });
  assert.equal(missing.complete, false);
  assert.deepEqual(missing.missing, ["fin_pnl"]);
});
