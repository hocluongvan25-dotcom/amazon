"use client";

/**
 * PpcActions — phần TƯƠNG TÁC của chiều ghi PPC trên /ppc (Module 5 PHẦN 2&3).
 *
 * Server component (LivePpc) đọc dữ liệu thật từ 4 view của migration 0021 rồi
 * truyền xuống đây; component này KHÔNG fetch gì thêm và KHÔNG giữ secret nào.
 *
 * Ba việc, theo đúng thứ tự một người vận hành làm:
 *   1. GỢI Ý (sinh từ số liệu) → chọn dòng → "Tạo đề xuất" → ghi vào hàng đợi.
 *   2. HÀNG ĐỢI → trưởng phòng PPC duyệt/từ chối (quyền do DB tính: can_decide).
 *   3. KẾT QUẢ → cron ads-apply đã áp dụng / thất bại / bỏ qua, kèm lỗi Amazon.
 *
 * KHÔNG có nút nào gọi thẳng Amazon: đề xuất đã duyệt chờ cron /api/cron/ads-apply
 * (service_role) đọc lại Amazon để đối chiếu before_value rồi mới PUT/POST. Làm vậy
 * để mọi lần ghi đều nằm trong một luồng có audit + guardrail + trần ngày.
 */
import { useMemo, useState, useTransition, type ReactNode } from "react";

import { Chip, Panel, tableCls } from "@/components/ui";
import { agoText } from "@/lib/data/ads-model";
import {
  NEGATIVE_MATCH_LABEL,
  groupSuggestions,
  money,
  pendingApproval,
  policyGuardLines,
  proposalItemFromSuggestion,
  queueStats,
  recentResults,
  requestStatusTone,
  signedPct,
  suggestionTone,
  waitingForCron,
  type PpcNegative,
  type PpcPolicy,
  type PpcRequest,
  type PpcSuggestion,
} from "@/lib/data/ppc-write-model";
import {
  decideBulkAction,
  decideChangeAction,
  proposeChangesAction,
  proposeNegativeKeywordAction,
  savePolicyAction,
  type PpcActionResult,
} from "@/app/(app)/ppc/actions";

type Notice = { tone: "green" | "red" | "amber"; text: string; lines?: string[] };

export type PpcActionsProps = {
  mode: "supabase" | "demo";
  policies: PpcPolicy[];
  requests: PpcRequest[];
  suggestions: PpcSuggestion[];
  negatives: PpcNegative[];
  /** ADS_WRITE_ENABLED đọc ở server — cron có được phép gọi Amazon không */
  writeEnabled: boolean;
  partialErrors: string[];
  /** campaign của shop để chọn khi phủ định tay (đọc từ vexim_ads_campaigns) */
  campaignOptions: { id: string; name: string | null; shopId: string; type: string | null }[];
  /** lịch cron hiện hành (vercel.json) — hiện cho người dùng biết chờ tới lúc nào */
  cronSchedule: string;
};

function NoticeBar({ notice }: { notice: Notice | null }) {
  if (!notice) return null;
  const tone =
    notice.tone === "green"
      ? "border-green bg-green-soft text-[#0b5c40]"
      : notice.tone === "amber"
        ? "border-amber bg-amber-soft text-[#7a4c02]"
        : "border-red bg-red-soft text-[#8f1616]";
  return (
    <div className={`mb-3 rounded-[11px] border px-3 py-2 text-[12.5px] font-semibold ${tone}`}>
      <div>{notice.text}</div>
      {notice.lines && notice.lines.length > 0 ? (
        <ul className="mt-1 space-y-0.5 font-medium">
          {notice.lines.slice(0, 12).map((l, i) => (
            <li key={`${i}-${l.slice(0, 24)}`}>• {l}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Btn({
  children,
  onClick,
  disabled,
  tone = "default",
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  tone?: "default" | "primary" | "danger";
  title?: string;
}) {
  const cls =
    tone === "primary"
      ? "border-accent bg-accent text-white hover:brightness-110"
      : tone === "danger"
        ? "border-red bg-white text-[#a01717] hover:bg-red-soft"
        : "border-line bg-white text-muted hover:border-accent hover:text-accent-ink";
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md border px-2.5 py-1 text-[12px] font-extrabold transition disabled:cursor-not-allowed disabled:opacity-45 ${cls}`}
    >
      {children}
    </button>
  );
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[11px] font-extrabold uppercase tracking-wider text-soft">{label}</span>
      {children}
      {hint ? <span className="mt-0.5 block text-[11px] font-medium text-soft">{hint}</span> : null}
    </label>
  );
}

const inputCls =
  "w-full rounded-md border border-line bg-white px-2 py-1 text-[12.5px] font-medium text-ink focus:border-accent focus:outline-none";

export function PpcActions(props: PpcActionsProps) {
  const { mode, policies, requests, suggestions, negatives, writeEnabled, partialErrors } = props;
  const [shopId, setShopId] = useState<string>(policies[0]?.shopId ?? "");
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<Notice | null>(null);

  const policy = useMemo(() => policies.find((p) => p.shopId === shopId) ?? policies[0] ?? null, [policies, shopId]);
  const activeShopId = policy?.shopId ?? shopId;

  const myRequests = useMemo(() => requests.filter((r) => r.shopId === activeShopId), [requests, activeShopId]);
  const mySuggestions = useMemo(
    () => suggestions.filter((s) => s.shopId === activeShopId && s.canPropose),
    [suggestions, activeShopId],
  );
  const myNegatives = useMemo(() => negatives.filter((n) => n.shopId === activeShopId), [negatives, activeShopId]);

  const queue = useMemo(() => pendingApproval(myRequests), [myRequests]);
  const waiting = useMemo(() => waitingForCron(myRequests), [myRequests]);
  const results = useMemo(() => recentResults(myRequests, 25), [myRequests]);
  const stats = useMemo(() => queueStats(myRequests), [myRequests]);
  const grouped = useMemo(() => groupSuggestions(mySuggestions), [mySuggestions]);

  /* ---------- chọn dòng gợi ý ---------- */
  const [pickedSuggestions, setPickedSuggestions] = useState<string[]>([]);
  /* ---------- chọn dòng chờ duyệt ---------- */
  const [pickedRequests, setPickedRequests] = useState<string[]>([]);
  const [bulkNote, setBulkNote] = useState("");
  /* ---------- guardrail ---------- */
  const [editingPolicy, setEditingPolicy] = useState(false);

  function run(fn: () => Promise<PpcActionResult>, after?: () => void) {
    startTransition(async () => {
      const res = await fn();
      setNotice({
        tone: res.ok ? "green" : res.warnings.length > 0 ? "amber" : "red",
        text: res.message,
        lines: res.warnings,
      });
      if (res.ok) after?.();
    });
  }

  function toggle(list: string[], setList: (v: string[]) => void, key: string) {
    setList(list.includes(key) ? list.filter((x) => x !== key) : [...list, key]);
  }

  function submitSuggestions() {
    const chosen = mySuggestions.filter((s) => pickedSuggestions.includes(s.suggestionKey ?? `${s.entityType}|${s.amazonEntityId}|${s.label}`));
    if (chosen.length === 0) {
      setNotice({ tone: "amber", text: "Chưa chọn gợi ý nào." });
      return;
    }
    run(
      () =>
        proposeChangesAction({
          shopId: activeShopId,
          items: chosen.map(proposalItemFromSuggestion),
          source: "suggestion",
          reason: `Gợi ý từ số liệu Ads 7 ngày (${chosen.length} dòng)`,
        }),
      () => setPickedSuggestions([]),
    );
  }

  function decideOne(id: string, decision: "approve" | "reject") {
    run(() => decideChangeAction({ id, decision, note: bulkNote.trim() || undefined }), () =>
      setPickedRequests((prev) => prev.filter((x) => x !== id)),
    );
  }

  function decideBulk(decision: "approve" | "reject") {
    if (pickedRequests.length === 0) {
      setNotice({ tone: "amber", text: "Chưa chọn đề xuất nào để duyệt theo lô." });
      return;
    }
    run(() => decideBulkAction({ ids: pickedRequests, decision, note: bulkNote.trim() || undefined }), () =>
      setPickedRequests([]),
    );
  }

  /* ---------- form phủ định tay ---------- */
  const campaignOptions = props.campaignOptions.filter((c) => c.shopId === activeShopId);
  const [negCampaign, setNegCampaign] = useState<string>(campaignOptions[0]?.id ?? "");
  const [negLevel, setNegLevel] = useState<"campaign" | "ad_group">("campaign");
  const [negAdGroup, setNegAdGroup] = useState<string>("");
  const [negText, setNegText] = useState<string>("");
  const [negMatch, setNegMatch] = useState<string>("NEGATIVE_EXACT");
  const [negReason, setNegReason] = useState<string>("");

  // ad group chỉ biết được từ gợi ý/dữ liệu đã đồng bộ — không có thì cho nhập id.
  const adGroupOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const s of suggestions) {
      if (s.shopId !== activeShopId || s.campaignId !== negCampaign || !s.adGroupId) continue;
      if (!seen.has(s.adGroupId)) seen.set(s.adGroupId, s.adGroupName ?? s.adGroupId);
    }
    for (const r of requests) {
      if (r.shopId !== activeShopId || r.campaignId !== negCampaign || !r.adGroupId) continue;
      if (!seen.has(r.adGroupId)) seen.set(r.adGroupId, r.adGroupId);
    }
    return [...seen.entries()].map(([id, name]) => ({ id, name }));
  }, [suggestions, requests, activeShopId, negCampaign]);

  function submitNegative() {
    run(
      () =>
        proposeNegativeKeywordAction({
          shopId: activeShopId,
          draft: {
            campaignId: negCampaign,
            adGroupId: negAdGroup,
            keywordText: negText,
            matchType: negMatch,
            level: negLevel,
            reason: negReason,
          },
        }),
      () => {
        setNegText("");
        setNegReason("");
      },
    );
  }

  /* ---------- form guardrail ---------- */
  const [pf, setPf] = useState(() => ({
    autoApply: policy?.autoApply ?? false,
    requireApprovalState: policy?.requireApprovalState ?? true,
    maxBidChangePct: String(policy?.maxBidChangePct ?? 20),
    maxBudgetChangePct: String(policy?.maxBudgetChangePct ?? 30),
    bidFloor: policy?.bidFloor === null || policy?.bidFloor === undefined ? "" : String(policy.bidFloor),
    bidCeiling: policy?.bidCeiling === null || policy?.bidCeiling === undefined ? "" : String(policy.bidCeiling),
    budgetFloor: policy?.budgetFloor === null || policy?.budgetFloor === undefined ? "" : String(policy.budgetFloor),
    budgetCeiling: policy?.budgetCeiling === null || policy?.budgetCeiling === undefined ? "" : String(policy.budgetCeiling),
    dailyChangeCap: String(policy?.dailyChangeCap ?? 50),
    maxOpenRequests: String(policy?.maxOpenRequests ?? 100),
    proposalTtlHours: String(policy?.proposalTtlHours ?? 72),
    bidStepPct: String(policy?.bidStepPct ?? 15),
    currency: policy?.currency ?? "USD",
    notes: policy?.notes ?? "",
  }));

  function submitPolicy() {
    run(
      () =>
        savePolicyAction({
          shopId: activeShopId,
          draft: {
            autoApply: pf.autoApply,
            requireApprovalState: pf.requireApprovalState,
            maxBidChangePct: pf.maxBidChangePct,
            maxBudgetChangePct: pf.maxBudgetChangePct,
            bidFloor: pf.bidFloor,
            bidCeiling: pf.bidCeiling,
            budgetFloor: pf.budgetFloor,
            budgetCeiling: pf.budgetCeiling,
            dailyChangeCap: pf.dailyChangeCap,
            maxOpenRequests: pf.maxOpenRequests,
            proposalTtlHours: pf.proposalTtlHours,
            bidStepPct: pf.bidStepPct,
            currency: pf.currency,
            notes: pf.notes,
          },
        }),
      () => setEditingPolicy(false),
    );
  }

  if (mode === "demo") {
    return (
      <Panel title="Thay đổi PPC (bid / ngân sách / phủ định)" hint="chiều ghi — migration 0021">
        <p className="text-[12.5px] font-semibold text-amber">
          DEMO MODE: chiều ghi cần Supabase thật (hàng đợi <code>ads.change_requests</code> + guardrail + audit log).
          Cấu hình Supabase và chạy migration 0021 thì khối này sẽ hiện gợi ý, hàng đợi duyệt và kết quả áp dụng.
        </p>
      </Panel>
    );
  }

  return (
    <>
      <Panel
        title="Thay đổi PPC (chiều ghi)"
        hint="hàng đợi ads.change_requests · guardrail ads.ppc_policies · audit iam.audit_logs"
      >
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-[12px] font-bold text-soft">Shop:</span>
          {policies.length <= 1 ? (
            <span className="text-[12.5px] font-bold">{policy?.shop ?? "—"}</span>
          ) : (
            <select
              className={`${inputCls} w-auto`}
              value={activeShopId}
              onChange={(e) => {
                setShopId(e.target.value);
                setPickedSuggestions([]);
                setPickedRequests([]);
                setNotice(null);
              }}
            >
              {policies.map((p) => (
                <option key={p.shopId} value={p.shopId}>
                  {p.shop}
                  {p.marketplace ? ` (${p.marketplace})` : ""}
                </option>
              ))}
            </select>
          )}
          <span className="ml-auto flex flex-wrap items-center gap-1.5">
            <Chip tone={writeEnabled ? "green" : "amber"}>
              {writeEnabled ? "Cron ĐƯỢC phép ghi lên Amazon" : "ADS_WRITE_ENABLED tắt — chưa ghi lên Amazon"}
            </Chip>
            <Chip tone="gray">cron: {props.cronSchedule}</Chip>
          </span>
        </div>

        <NoticeBar notice={notice} />

        {partialErrors.length > 0 ? (
          <div className="mb-3 rounded-[11px] border border-amber bg-amber-soft px-3 py-2 text-[12px] font-semibold text-[#7a4c02]">
            Một phần dữ liệu chưa đọc được — các khối bên dưới có thể thiếu dòng:
            <ul className="mt-1 space-y-0.5 font-medium">
              {partialErrors.map((e) => (
                <li key={e}>• {e}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {!writeEnabled ? (
          <p className="mb-3 rounded-[11px] border border-line bg-[#f7f9fc] px-3 py-2 text-[12px] font-medium text-muted">
            Đề xuất đã duyệt <b>chưa</b> được gửi lên Amazon vì <code>ADS_WRITE_ENABLED</code> chưa bật. Muốn chạy thật:
            đặt biến này = <code>1</code> trên Vercel (Project → Settings → Environment Variables), Redeploy, rồi chờ cron
            hoặc bấm “Run now” ở tab Cron. Xem trước payload: <code>/api/cron/ads-apply?dryRun=1</code>.
          </p>
        ) : null}

        {/* ---------------- Guardrail ---------------- */}
        {policy ? (
          <div className="mb-4 rounded-[11px] border border-line bg-[#fbfcfe] px-3 py-2.5">
            <div className="mb-1.5 flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-extrabold">Guardrail của {policy.shop}</span>
              <Chip tone={policy.autoApply ? "amber" : "blue"}>{policy.autoApply ? "AUTO_APPLY bật" : "mọi thay đổi cần duyệt"}</Chip>
              <Chip tone={policy.hasPolicyRow ? "gray" : "amber"}>
                {policy.hasPolicyRow ? `đã lưu guardrail${policy.policyUpdatedAt ? ` · ${agoText(hoursSince(policy.policyUpdatedAt))}` : ""}` : "đang dùng mặc định (chưa lưu dòng nào)"}
              </Chip>
              <span className="ml-auto">
                {policy.canEditPolicy ? (
                  <Btn onClick={() => setEditingPolicy((v) => !v)}>{editingPolicy ? "Đóng form" : "Sửa guardrail"}</Btn>
                ) : (
                  <Chip tone="gray">chỉ admin / trưởng phòng PPC mới sửa được guardrail</Chip>
                )}
              </span>
            </div>
            <ul className="space-y-0.5 text-[12px] font-medium text-muted">
              {policyGuardLines(policy).map((l) => (
                <li key={l.slice(0, 32)}>• {l}</li>
              ))}
            </ul>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Chip tone={stats.proposed > 0 ? "amber" : "gray"}>{stats.proposed} chờ duyệt</Chip>
              <Chip tone={stats.approved > 0 ? "blue" : "gray"}>{stats.approved} đã duyệt — chờ cron</Chip>
              <Chip tone={stats.applying > 0 ? "blue" : "gray"}>{stats.applying} đang áp dụng</Chip>
              <Chip tone="green">{stats.applied} đã áp dụng</Chip>
              <Chip tone={stats.failed > 0 ? "red" : "gray"}>{stats.failed} thất bại</Chip>
              <Chip tone="gray">{stats.skipped} bỏ qua (lệch Amazon)</Chip>
              <Chip tone={policy.failed24h > 0 ? "red" : "gray"}>{policy.failed24h} lỗi trong 24h</Chip>
            </div>

            {editingPolicy && policy.canEditPolicy ? (
              <div className="mt-3 border-t border-line pt-3">
                <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                  <Field label="Tự duyệt trong ngưỡng" hint="auto_apply">
                    <select
                      className={inputCls}
                      value={pf.autoApply ? "1" : "0"}
                      onChange={(e) => setPf({ ...pf, autoApply: e.target.value === "1" })}
                    >
                      <option value="0">TẮT — mọi thay đổi cần duyệt</option>
                      <option value="1">BẬT — trong ±% cho phép thì tự duyệt</option>
                    </select>
                  </Field>
                  <Field label="Bật/tắt luôn cần duyệt" hint="require_approval_state">
                    <select
                      className={inputCls}
                      value={pf.requireApprovalState ? "1" : "0"}
                      onChange={(e) => setPf({ ...pf, requireApprovalState: e.target.value === "1" })}
                    >
                      <option value="1">BẬT (khuyến nghị)</option>
                      <option value="0">TẮT — state cũng có thể tự duyệt</option>
                    </select>
                  </Field>
                  <Field label="% bid tối đa không cần duyệt">
                    <input className={inputCls} value={pf.maxBidChangePct} onChange={(e) => setPf({ ...pf, maxBidChangePct: e.target.value })} />
                  </Field>
                  <Field label="% ngân sách tối đa không cần duyệt">
                    <input
                      className={inputCls}
                      value={pf.maxBudgetChangePct}
                      onChange={(e) => setPf({ ...pf, maxBudgetChangePct: e.target.value })}
                    />
                  </Field>
                  <Field label={`Sàn bid (${pf.currency})`} hint="để trống = không chặn">
                    <input className={inputCls} value={pf.bidFloor} onChange={(e) => setPf({ ...pf, bidFloor: e.target.value })} />
                  </Field>
                  <Field label={`Trần bid (${pf.currency})`}>
                    <input className={inputCls} value={pf.bidCeiling} onChange={(e) => setPf({ ...pf, bidCeiling: e.target.value })} />
                  </Field>
                  <Field label={`Sàn ngân sách ngày (${pf.currency})`}>
                    <input className={inputCls} value={pf.budgetFloor} onChange={(e) => setPf({ ...pf, budgetFloor: e.target.value })} />
                  </Field>
                  <Field label={`Trần ngân sách ngày (${pf.currency})`}>
                    <input className={inputCls} value={pf.budgetCeiling} onChange={(e) => setPf({ ...pf, budgetCeiling: e.target.value })} />
                  </Field>
                  <Field label="Trần thay đổi / ngày" hint={`hôm nay còn ${policy.capLeftToday}`}>
                    <input className={inputCls} value={pf.dailyChangeCap} onChange={(e) => setPf({ ...pf, dailyChangeCap: e.target.value })} />
                  </Field>
                  <Field label="Trần đề xuất đang mở">
                    <input className={inputCls} value={pf.maxOpenRequests} onChange={(e) => setPf({ ...pf, maxOpenRequests: e.target.value })} />
                  </Field>
                  <Field label="Hạn duyệt (giờ)" hint="quá hạn → expired, không áp dụng">
                    <input className={inputCls} value={pf.proposalTtlHours} onChange={(e) => setPf({ ...pf, proposalTtlHours: e.target.value })} />
                  </Field>
                  <Field label="Bước bid gợi ý (%)" hint="lower_bid hạ bao nhiêu %">
                    <input className={inputCls} value={pf.bidStepPct} onChange={(e) => setPf({ ...pf, bidStepPct: e.target.value })} />
                  </Field>
                  <Field label="Tiền tệ của sàn/trần">
                    <input className={inputCls} value={pf.currency} onChange={(e) => setPf({ ...pf, currency: e.target.value })} />
                  </Field>
                  <div className="col-span-2 md:col-span-3">
                    <Field label="Ghi chú guardrail" hint="lưu trong audit log">
                      <input className={inputCls} value={pf.notes} onChange={(e) => setPf({ ...pf, notes: e.target.value })} />
                    </Field>
                  </div>
                </div>
                <div className="mt-2 flex gap-2">
                  <Btn tone="primary" onClick={submitPolicy} disabled={pending}>
                    {pending ? "Đang lưu…" : "Lưu guardrail (có audit)"}
                  </Btn>
                  <Btn onClick={() => setEditingPolicy(false)}>Huỷ</Btn>
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="mb-3 text-[12.5px] font-semibold text-amber">
            Không đọc được guardrail của shop nào — kiểm tra quyền đọc shop (assignment module <code>ads</code>) và migration 0021.
          </p>
        )}
      </Panel>

      {/* ---------------- Gợi ý → tạo đề xuất ---------------- */}
      <Panel
        title="Gợi ý thay đổi từ số liệu"
        hint="view vexim_ppc_suggestions · before/after tính sẵn từ metrics 7 ngày · không tự ghi gì"
      >
        {grouped.length === 0 ? (
          <p className="text-[12.5px] font-medium text-muted">
            Chưa có gợi ý nào cho shop này. Cần ads-sync nhập <code>spSearchTerm</code> + <code>spTargeting</code> +{" "}
            <code>spCampaigns</code> và phải có spend thật; gợi ý chỉ sinh khi đủ số click tối thiểu trong guardrail (
            {policy?.suggestionMinClicks ?? "?"} click / {money(policy?.suggestionMinSpend ?? null, policy?.currency ?? null)} spend).
          </p>
        ) : (
          <>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Btn tone="primary" onClick={submitSuggestions} disabled={pending || pickedSuggestions.length === 0}>
                Tạo đề xuất từ {pickedSuggestions.length} dòng đã chọn
              </Btn>
              <Btn
                onClick={() =>
                  setPickedSuggestions(
                    pickedSuggestions.length === mySuggestions.filter((s) => !s.hasOpenRequest).length
                      ? []
                      : mySuggestions.filter((s) => !s.hasOpenRequest).map((s) => s.suggestionKey ?? `${s.entityType}|${s.amazonEntityId}|${s.label}`),
                  )
                }
              >
                {pickedSuggestions.length > 0 ? "Bỏ chọn tất cả" : "Chọn tất cả"}
              </Btn>
              <span className="text-[11.5px] font-medium text-soft">
                {mySuggestions.filter((s) => s.hasOpenRequest).length} dòng đã có đề xuất mở → không chọn được (tránh gọi Amazon hai lần)
              </span>
            </div>

            {grouped.map((g) => (
              <div key={g.kind} className="mb-3">
                <div className="mb-1 flex items-center gap-2">
                  <Chip tone={suggestionTone(g.kind)}>{g.kindLabel}</Chip>
                  <span className="text-[11.5px] font-bold text-soft">
                    {g.items.length} dòng · ưu tiên {g.priority}
                  </span>
                </div>
                <table className={tableCls.table}>
                  <thead>
                    <tr>
                      <th className={tableCls.th} style={{ width: 26 }} />
                      <th className={tableCls.th}>Thực thể</th>
                      <th className={tableCls.th}>Thay đổi</th>
                      <th className={`${tableCls.th} text-right`}>Spend 7d</th>
                      <th className={`${tableCls.th} text-right`}>Click</th>
                      <th className={`${tableCls.th} text-right`}>Đơn</th>
                      <th className={`${tableCls.th} text-right`}>ACOS</th>
                      <th className={tableCls.th}>Vì sao</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.items.slice(0, 30).map((s) => {
                      const key = s.suggestionKey ?? `${s.entityType}|${s.amazonEntityId}|${s.label}`;
                      const checked = pickedSuggestions.includes(key);
                      return (
                        <tr key={key} className={s.hasOpenRequest ? "opacity-55" : undefined}>
                          <td className={tableCls.td}>
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={s.hasOpenRequest}
                              onChange={() => toggle(pickedSuggestions, setPickedSuggestions, key)}
                              aria-label={`Chọn gợi ý ${s.label}`}
                            />
                          </td>
                          <td className={tableCls.td}>
                            <div className="font-bold">{s.label || s.amazonEntityId}</div>
                            <div className="text-[11px] font-medium text-soft">
                              {s.campaignName ?? s.campaignId}
                              {s.adGroupName ? ` · ${s.adGroupName}` : ""}
                              {s.keywordType ? ` · ${s.keywordType}` : ""}
                            </div>
                          </td>
                          <td className={tableCls.td}>
                            <div className="font-bold">
                              {s.currentNumber !== null && s.proposedNumber !== null
                                ? `${s.currentNumber} → ${s.proposedNumber} ${s.currency}`
                                : s.changeType === "create"
                                  ? `Phủ định (${NEGATIVE_MATCH_LABEL[s.matchType ?? "NEGATIVE_EXACT"] ?? s.matchType})`
                                  : `${s.changeType} → ${String(Object.values(s.afterValue ?? {})[0] ?? "?")}`}
                            </div>
                            <div className="text-[11px] font-medium text-soft">
                              {s.deltaPct !== null ? signedPct(s.deltaPct) : "chưa rõ giá hiện tại"}
                              {s.requiresApproval ? " · cần duyệt" : " · có thể tự duyệt"}
                              {s.currentNumber === null && (s.changeType === "bid" || s.changeType === "budget")
                                ? " · cron sẽ đọc Amazon để đối chiếu"
                                : ""}
                            </div>
                          </td>
                          <td className={tableCls.tdNum}>{money(s.spend7, s.currency)}</td>
                          <td className={tableCls.tdNum}>{s.clicks7}</td>
                          <td className={tableCls.tdNum}>{s.adOrders7}</td>
                          <td className={`${tableCls.tdNum} font-bold ${s.acos7 !== null && s.acosTarget !== null && s.acos7 > s.acosTarget ? "text-red" : ""}`}>
                            {s.acos7 !== null ? `${s.acos7.toFixed(0)}%` : "—"}
                          </td>
                          <td className={`${tableCls.td} text-[11.5px] font-medium text-muted`}>
                            {s.reason ?? "—"}
                            {s.hasOpenRequest ? <div className="mt-0.5 font-bold text-amber">đã có đề xuất mở</div> : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ))}
          </>
        )}
      </Panel>

      {/* ---------------- Hàng đợi duyệt ---------------- */}
      <Panel title="Hàng đợi duyệt" hint="chỉ admin / trưởng phòng PPC thấy nút duyệt (can_decide do DB tính)">
        {queue.length === 0 ? (
          <p className="text-[12.5px] font-medium text-muted">
            Không có đề xuất nào chờ duyệt
            {stats.approved + stats.applying > 0 ? ` — ${stats.approved + stats.applying} dòng đã duyệt đang chờ cron.` : "."}
          </p>
        ) : (
          <>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Btn tone="primary" onClick={() => decideBulk("approve")} disabled={pending || pickedRequests.length === 0}>
                Duyệt {pickedRequests.length || ""} dòng đã chọn
              </Btn>
              <Btn tone="danger" onClick={() => decideBulk("reject")} disabled={pending || pickedRequests.length === 0}>
                Từ chối {pickedRequests.length || ""} dòng
              </Btn>
              <input
                className={`${inputCls} max-w-[280px]`}
                placeholder="Ghi chú quyết định (lưu vào audit)"
                value={bulkNote}
                onChange={(e) => setBulkNote(e.target.value)}
              />
              <span className="text-[11.5px] font-medium text-soft">
                Dòng có <b>chưa rõ giá hiện tại</b> thì cron phải đọc Amazon mới đối chiếu được — duyệt là chấp nhận rủi ro đó.
              </span>
            </div>
            <table className={tableCls.table}>
              <thead>
                <tr>
                  <th className={tableCls.th} style={{ width: 26 }} />
                  <th className={tableCls.th}>Thay đổi</th>
                  <th className={tableCls.th}>Trạng thái</th>
                  <th className={tableCls.th}>Ai đề xuất</th>
                  <th className={tableCls.th}>Hạn duyệt</th>
                  <th className={tableCls.th}>Quyết định</th>
                </tr>
              </thead>
              <tbody>
                {queue.slice(0, 60).map((r) => (
                  <tr key={r.id}>
                    <td className={tableCls.td}>
                      <input
                        type="checkbox"
                        checked={pickedRequests.includes(r.id)}
                        disabled={!r.canDecide}
                        onChange={() => toggle(pickedRequests, setPickedRequests, r.id)}
                        aria-label={`Chọn đề xuất ${r.label}`}
                      />
                    </td>
                    <td className={tableCls.td}>
                      <div className="font-bold">{r.summary ?? r.label}</div>
                      <div className="text-[11px] font-medium text-soft">
                        {r.entityLabel} · {r.campaignName ?? r.campaignId}
                        {r.adGroupId ? ` · ad group ${r.adGroupId}` : ""}
                        {r.beforeNumber === null && (r.changeType === "bid" || r.changeType === "budget")
                          ? " · CHƯA BIẾT giá Amazon đang để"
                          : ""}
                      </div>
                      {r.reason ? <div className="text-[11px] font-medium text-muted">Lý do: {r.reason}</div> : null}
                    </td>
                    <td className={tableCls.td}>
                      <Chip tone={requestStatusTone(r.status)}>{r.statusLabel ?? r.status}</Chip>
                      <div className="mt-0.5 text-[11px] font-medium text-soft">
                        {r.requiresApproval ? "cần duyệt" : "tự duyệt theo guardrail"}
                        {r.deltaLabel ? ` · ${r.deltaLabel}` : ""}
                      </div>
                    </td>
                    <td className={tableCls.td}>
                      <div className="text-[12px] font-semibold">{r.proposedByName ?? "—"}</div>
                      <div className="text-[11px] font-medium text-soft">{agoText(r.ageHours)}</div>
                      {r.isMine ? <Chip tone="amber">bạn tự đề xuất — duyệt sẽ bị ghi chú “tự duyệt”</Chip> : null}
                    </td>
                    <td className={tableCls.td}>
                      {r.expiresInHours !== null ? (
                        <span className={`text-[12px] font-bold ${r.expiresInHours < 12 ? "text-red" : "text-muted"}`}>
                          còn {r.expiresInHours.toFixed(1)} giờ
                        </span>
                      ) : (
                        <span className="text-[12px] font-medium text-soft">không hết hạn</span>
                      )}
                    </td>
                    <td className={tableCls.td}>
                      {r.canDecide ? (
                        <span className="flex gap-1.5">
                          <Btn tone="primary" onClick={() => decideOne(r.id, "approve")} disabled={pending}>
                            Duyệt
                          </Btn>
                          <Btn tone="danger" onClick={() => decideOne(r.id, "reject")} disabled={pending}>
                            Từ chối
                          </Btn>
                        </span>
                      ) : (
                        <span className="text-[11.5px] font-medium text-soft">không có quyền duyệt</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Panel>

      {/* ---------------- Chờ cron + kết quả ---------------- */}
      {waiting.length > 0 ? (
        <Panel
          title="Đã duyệt — chờ cron áp dụng"
          hint={`cron ads-apply chạy ${props.cronSchedule} · mỗi lần ≤ ${policy?.dailyChangeCap ?? "?"} thay đổi/shop`}
        >
          <ul className="space-y-1 text-[12.5px] font-medium text-muted">
            {waiting.slice(0, 20).map((r) => (
              <li key={r.id}>
                <Chip tone={requestStatusTone(r.status)}>{r.statusLabel ?? r.status}</Chip>{" "}
                <b>{r.summary ?? r.label}</b> · {r.campaignName ?? r.campaignId}
                {r.decidedByName ? ` · ${r.decidedByName} duyệt ${r.decidedAt ? agoText(hoursSince(r.decidedAt)) : ""}` : ""}
                {r.status === "applying" ? ` · lần thử ${r.attempts}` : ""}
              </li>
            ))}
          </ul>
          {!writeEnabled ? (
            <p className="mt-2 text-[12px] font-bold text-amber">
              Cron sẽ KHÔNG gọi Amazon khi <code>ADS_WRITE_ENABLED</code> chưa bật — những dòng này vẫn nằm chờ, không mất.
            </p>
          ) : null}
        </Panel>
      ) : null}

      {results.length > 0 ? (
        <Panel title="Kết quả áp dụng gần đây" hint="applied / failed / skipped · lỗi Amazon ghi nguyên văn vào last_error">
          <table className={tableCls.table}>
            <thead>
              <tr>
                <th className={tableCls.th}>Thay đổi</th>
                <th className={tableCls.th}>Kết quả</th>
                <th className={tableCls.th}>Lúc nào</th>
                <th className={tableCls.th}>Chi tiết</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.id}>
                  <td className={tableCls.td}>
                    <div className="font-bold">{r.summary ?? r.label}</div>
                    <div className="text-[11px] font-medium text-soft">
                      {r.campaignName ?? r.campaignId}
                      {r.decidedByName ? ` · ${r.decidedByName} duyệt` : ""}
                    </div>
                  </td>
                  <td className={tableCls.td}>
                    <Chip tone={requestStatusTone(r.status)}>{r.statusLabel ?? r.status}</Chip>
                    {r.attempts > 1 ? <div className="mt-0.5 text-[11px] font-medium text-soft">{r.attempts} lần thử</div> : null}
                  </td>
                  <td className={tableCls.td}>
                    <span className="text-[12px] font-semibold">
                      {r.appliedAt ? agoText(hoursSince(r.appliedAt)) : r.decidedAt ? agoText(hoursSince(r.decidedAt)) : "—"}
                    </span>
                  </td>
                  <td className={`${tableCls.td} text-[11.5px] font-medium ${r.status === "failed" ? "text-red" : "text-muted"}`}>
                    {r.lastError ?? "—"}
                    {r.status === "failed" && r.canDecide ? (
                      <div className="mt-1">
                        <Btn tone="primary" onClick={() => decideOne(r.id, "approve")} disabled={pending}>
                          Duyệt lại để cron thử tiếp
                        </Btn>
                      </div>
                    ) : null}
                    {r.amazonResponse ? (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-[11px] font-bold text-soft">phản hồi Amazon</summary>
                        <pre className="mt-1 max-w-[520px] overflow-auto rounded-md bg-[#f7f9fc] p-2 text-[11px] font-medium">
                          {JSON.stringify(r.amazonResponse, null, 2).slice(0, 1200)}
                        </pre>
                      </details>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      ) : null}

      {/* ---------------- Phủ định tay + danh sách ---------------- */}
      <Panel title="Từ khoá phủ định" hint="thêm tay hoặc từ gợi ý — vẫn phải qua duyệt, cron tạo trên Amazon bằng POST /sp/negativeKeywords">
        <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-6">
          <div className="col-span-2">
            <Field label="Campaign">
              <select className={inputCls} value={negCampaign} onChange={(e) => setNegCampaign(e.target.value)}>
                {campaignOptions.length === 0 ? <option value="">(chưa đồng bộ campaign — chạy ads-sync)</option> : null}
                {campaignOptions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name ?? c.id}
                    {isSp(c.type) ? "" : ` — ${c.type} (chiều ghi chỉ mở cho SP)`}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Cấp phủ định">
            <select
              className={inputCls}
              value={negLevel}
              onChange={(e) => setNegLevel(e.target.value === "campaign" ? "campaign" : "ad_group")}
            >
              <option value="campaign">Cả campaign</option>
              <option value="ad_group">Một ad group</option>
            </select>
          </Field>
          <Field label="Ad group" hint={adGroupOptions.length === 0 ? "nhập adGroupId nếu chưa đồng bộ" : undefined}>
            {adGroupOptions.length > 0 && negLevel === "ad_group" ? (
              <select className={inputCls} value={negAdGroup} onChange={(e) => setNegAdGroup(e.target.value)}>
                <option value="">— chọn —</option>
                {adGroupOptions.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className={inputCls}
                value={negAdGroup}
                disabled={negLevel === "campaign"}
                placeholder={negLevel === "campaign" ? "(không cần)" : "adGroupId"}
                onChange={(e) => setNegAdGroup(e.target.value)}
              />
            )}
          </Field>
          <Field label="Kiểu phủ định">
            <select className={inputCls} value={negMatch} onChange={(e) => setNegMatch(e.target.value)}>
              <option value="NEGATIVE_EXACT">{NEGATIVE_MATCH_LABEL.NEGATIVE_EXACT}</option>
              <option value="NEGATIVE_PHRASE">{NEGATIVE_MATCH_LABEL.NEGATIVE_PHRASE}</option>
            </select>
          </Field>
          <Field label="Từ khoá (search term)">
            <input className={inputCls} value={negText} placeholder="free sample" onChange={(e) => setNegText(e.target.value)} />
          </Field>
          <div className="col-span-2 md:col-span-4">
            <Field label="Lý do (lưu vào audit)">
              <input
                className={inputCls}
                value={negReason}
                placeholder="12 click, 0 đơn, spend 8.40 USD"
                onChange={(e) => setNegReason(e.target.value)}
              />
            </Field>
          </div>
          <div className="col-span-2 flex items-end md:col-span-2">
            <Btn tone="primary" onClick={submitNegative} disabled={pending || !negText.trim() || !negCampaign}>
              {pending ? "Đang gửi…" : "Tạo đề xuất phủ định"}
            </Btn>
          </div>
        </div>

        {myNegatives.length === 0 ? (
          <p className="text-[12.5px] font-medium text-muted">
            Chưa có từ khoá phủ định nào được ghi nhận. Danh sách này nạp từ <code>ads.negative_keywords</code> (cron ghi khi
            áp dụng thành công, và lần đồng bộ sau nạp thêm những từ đã có sẵn trên Amazon).
          </p>
        ) : (
          <table className={tableCls.table}>
            <thead>
              <tr>
                <th className={tableCls.th}>Từ khoá</th>
                <th className={tableCls.th}>Kiểu</th>
                <th className={tableCls.th}>Cấp</th>
                <th className={tableCls.th}>Campaign</th>
                <th className={tableCls.th}>Nguồn</th>
                <th className={tableCls.th}>Trạng thái</th>
              </tr>
            </thead>
            <tbody>
              {myNegatives.slice(0, 60).map((n) => (
                <tr key={n.id}>
                  <td className={`${tableCls.td} font-bold`}>{n.keywordText}</td>
                  <td className={tableCls.td}>{n.matchLabel ?? NEGATIVE_MATCH_LABEL[n.matchType] ?? n.matchType}</td>
                  <td className={tableCls.td}>
                    {n.level === "campaign" ? "cả campaign" : `ad group ${n.adGroupName ?? n.adGroupId}`}
                  </td>
                  <td className={tableCls.td}>{n.campaignName ?? n.campaignId}</td>
                  <td className={tableCls.td}>
                    <Chip tone={n.source === "vexim" ? "blue" : "gray"}>{n.source === "vexim" ? "thêm từ VEXIM" : "có sẵn trên Amazon"}</Chip>
                  </td>
                  <td className={tableCls.td}>
                    <Chip tone={(n.state ?? "ENABLED").toUpperCase() === "ENABLED" ? "green" : "gray"}>{n.state ?? "ENABLED"}</Chip>
                    {n.amazonNegativeId ? (
                      <div className="mt-0.5 text-[11px] font-medium text-soft">id Amazon: {n.amazonNegativeId}</div>
                    ) : null}
                    {n.lastSyncedAt ? (
                      <div className="text-[11px] font-medium text-soft">cập nhật {agoText(hoursSince(n.lastSyncedAt))}</div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}

/** Chiều ghi chỉ mở cho Sponsored Products — campaign loại khác thì nói rõ. */
function isSp(type: string | null): boolean {
  const t = String(type ?? "").toLowerCase();
  return t === "" || t === "sp" || t === "sponsoredproducts" || t === "sponsored_products";
}

/** Đổi mốc ISO → số giờ tính từ lúc đó (để tái dùng agoText của phần đọc). */
function hoursSince(iso: string | null, now: Date = new Date()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (now.getTime() - t) / 3_600_000);
}
