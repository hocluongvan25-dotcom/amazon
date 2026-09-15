/**
 * Test mắt xích từng THIẾU của màn A3 (/ppc/search-terms):
 * bảng ads.negative_suggestions + RPC + UI duyệt có sẵn từ 0020/0021, nhưng
 * không job nào SINH gợi ý → cột "Gợi ý" vĩnh viễn "không có gợi ý".
 * buildNegativeSuggestions áp luật SOP-04 (≥5 click · chi ≥10 · 0 đơn / 7 ngày).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildNegativeSuggestions, SUGGEST_RULES } from "../src/lib/worker/ads/suggest.ts";
import { MockDbAdapter } from "../src/lib/worker/db/adapter.ts";
import { runAdsReportPull } from "../src/lib/worker/jobs/ads-report-pull.job.ts";

const BASE = {
  campaignId: "C1",
  adGroupId: "G1",
  keywordId: "K1",
  keywordText: "muc in",
  matchType: "BROAD",
  currency: "USD",
  adsProfileId: "P1",
};

/** N ngày liên tiếp kết thúc 2026-09-13, mỗi ngày cùng số click/chi/đơn. */
function days(term: string, n: number, perDay: { clicks: number; cost: number; purchases?: number }) {
  return Array.from({ length: n }, (_, i) => ({
    ...BASE,
    day: new Date(Date.UTC(2026, 8, 13 - i)).toISOString().slice(0, 10),
    searchTerm: term,
    clicks: perDay.clicks,
    cost: perDay.cost,
    purchases7d: perDay.purchases ?? 0,
  }));
}

test("SOP-04: term đốt tiền (nhiều click, 0 đơn) → gợi ý negative_exact kèm bằng chứng", () => {
  const out = buildNegativeSuggestions(days("máy in màu giá rẻ", 7, { clicks: 2, cost: 3 }));
  assert.equal(out.length, 1);
  const s = out[0];
  assert.equal(s.suggestionType, "negative_exact");
  assert.equal(s.term, "máy in màu giá rẻ");
  assert.equal(s.targetKind, "search_term");
  assert.equal(s.windowDays, 7);
  const ev = s.evidence as { clicks: number; spend: number; purchases: number };
  assert.equal(ev.clicks, 14);
  assert.equal(ev.spend, 21);
  assert.equal(ev.purchases, 0);
  assert.ok(Array.isArray(s.reasons) && (s.reasons as string[]).length >= 2, "phải có lý do chữ người đọc được");
  assert.ok((s.confidence ?? 0) > 0 && (s.confidence ?? 0) <= 1);
});

test("SOP-04: term CÓ ĐƠN thì không bao giờ gợi ý chặn (dù chi nhiều)", () => {
  const out = buildNegativeSuggestions(days("mực in canon", 7, { clicks: 10, cost: 50, purchases: 1 }));
  assert.equal(out.length, 0);
});

test("SOP-04: dưới ngưỡng click hoặc chi → không gợi ý (chưa đủ bằng chứng)", () => {
  // 4 click tổng (< 5) dù chi 12
  assert.equal(buildNegativeSuggestions(days("t1", 2, { clicks: 2, cost: 6 })).length, 0);
  // 6 click nhưng chi 6 (< 10)
  assert.equal(buildNegativeSuggestions(days("t2", 3, { clicks: 2, cost: 2 })).length, 0);
});

test("cửa sổ 7 ngày tính từ ngày MỚI NHẤT trong report — ngày cũ hơn không được cộng dồn", () => {
  const recent = days("term nóng", 7, { clicks: 1, cost: 2 }); // 7 click · 14 → đạt
  const stale = [{ ...BASE, day: "2026-08-01", searchTerm: "term nguội", clicks: 99, cost: 999, purchases7d: 0 }];
  const out = buildNegativeSuggestions([...recent, ...stale]);
  assert.equal(out.length, 1);
  assert.equal(out[0].term, "term nóng");
});

test("cắt trần maxSuggestions, ưu tiên term chi nhiều nhất", () => {
  const rows = Array.from({ length: 10 }, (_, i) =>
    days(`term ${i}`, 7, { clicks: 2, cost: 2 + i }),
  ).flat();
  const out = buildNegativeSuggestions(rows, { rules: { maxSuggestions: 3 } });
  assert.equal(out.length, 3);
  assert.equal(out[0].term, "term 9"); // chi nhiều nhất
  assert.equal(SUGGEST_RULES.maxSuggestions, 200);
});

test("job ads-pull (file mode): nhập search-terms xong tự sinh gợi ý vào adapter", async () => {
  const db = new MockDbAdapter();
  const shop = {
    id: "00000000-0000-0000-0000-0000000000a1",
    displayName: "Shop test",
    marketplace: "ATVPDKIKX0DER",
  };
  const rows = days("từ khoá đốt tiền", 7, { clicks: 2, cost: 3 }).map((r) => ({
    date: r.day,
    campaignId: r.campaignId,
    adGroupId: r.adGroupId,
    keywordId: r.keywordId,
    keyword: r.keywordText,
    matchType: r.matchType,
    searchTerm: r.searchTerm,
    clicks: r.clicks,
    cost: r.cost,
    purchases7d: r.purchases7d,
  }));
  const result = await runAdsReportPull({
    db,
    shops: [shop],
    kinds: ["search-terms"],
    texts: { "search-terms": JSON.stringify(rows) },
  });
  const outcome = result.outcomes.find((o) => o.kind === "search-terms");
  assert.ok(outcome, "phải có outcome cho search-terms");
  assert.equal(outcome?.action, "imported");
  assert.equal(outcome?.suggestionsBuilt, 1, "phải sinh đúng 1 gợi ý");
  assert.equal(db.adsSuggestions.length, 1);
  assert.equal(db.adsSuggestions[0].term, "từ khoá đốt tiền");
  assert.equal(db.adsSuggestions[0].status, "pending");
});
