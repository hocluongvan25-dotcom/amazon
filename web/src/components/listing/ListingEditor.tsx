"use client";

/**
 * L3 — Trình soạn listing (client).
 * Form ĐỘNG theo product type: mỗi trường gắn một attribute Amazon, viền đỏ khi
 * vượt hạn mức. Kiểm tra chạy ngay trên máy (validateListingDraft) và lặp lại ở
 * server khi lưu — snapshot `validation` trong DB là cổng chặn của trigger 0014.
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { Chip, Panel } from "@/components/ui";
import {
  DRAFT_STATUS_LABEL,
  FIELDS,
  FIELD_GROUPS,
  MAX_BULLETS,
  MAX_IMAGES,
  availableActions,
  checkPublishGate,
  getFulfillment,
  getImageUrls,
  getOffer,
  getParentageLevel,
  getParentSku,
  getTextAttribute,
  getTextList,
  getVariationTheme,
  isHttpsImageUrl,
  isImageAttribute,
  setFulfillment,
  setImageUrls,
  setOffer,
  setParentSku,
  setParentageLevel,
  setTextAttribute,
  setTextList,
  setVariationTheme,
  validateListingDraft,
  type ActionKey,
  type DraftStatus,
  type ListingRequirements,
  type ListingDraftPayload,
  type PublishRestrictions,
  type ValidationIssue,
} from "@/lib/listing/editor-model.ts";

export type EditorInitial = {
  draftId: string | null;
  status: DraftStatus;
  payload: ListingDraftPayload;
  revision: number;
  asin: string | null;
  submittedBy?: string | null;
};

export type EditorHistoryRow = {
  revision: number;
  stage: string;
  stageLabel: string;
  note?: string | null;
  changedFields?: string[];
  createdAt: string;
};

export type ListingEditorProps = {
  mode: "demo" | "supabase";
  sellerAccountId: string;
  shop: string;
  sku: string;
  productType: string;
  requirements: ListingRequirements;
  marketplaceId: string;
  locale: string;
  initial: EditorInitial;
  history: EditorHistoryRow[];
  actor: { userId: string | null; canWrite: boolean; isApprover: boolean };
  /** JSON Schema product type nếu worker đã tải (chưa có → hạn mức mặc định) */
  productTypeSchema?: unknown;
  /** Kết quả getListingsRestrictions gần nhất (worker lưu trong publish_issues) */
  restrictions?: PublishRestrictions | null;
};

const TONE: Record<string, string> = {
  ERROR: "text-[#a01717]",
  WARNING: "text-[#8a5602]",
  INFO: "text-soft",
};

export function ListingEditor(props: ListingEditorProps) {
  const router = useRouter();
  const [payload, setPayload] = useState<ListingDraftPayload>(props.initial.payload);
  const [status, setStatus] = useState<DraftStatus>(props.initial.status);
  const [revision, setRevision] = useState(props.initial.revision);
  const [draftId, setDraftId] = useState<string | null>(props.initial.draftId);
  const [history, setHistory] = useState<EditorHistoryRow[]>(props.history);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "err" | "info"; text: string } | null>(null);
  const [showOnlyErrors, setShowOnlyErrors] = useState(false);

  const brand = getTextAttribute(payload, "brand") || null;

  const validation = useMemo(
    () =>
      validateListingDraft({
        payload,
        productType: props.productType,
        marketplaceId: props.marketplaceId,
        locale: props.locale,
        requirements: props.requirements,
        productTypeSchema: props.productTypeSchema ?? null,
        brand,
      }),
    [payload, props.productType, props.marketplaceId, props.locale, props.requirements, props.productTypeSchema, brand],
  );

  const gate = useMemo(
    () =>
      checkPublishGate({
        status,
        validation,
        restrictions: props.restrictions ?? null,
        isNewListing: !props.initial.asin,
        requirements: props.requirements,
        asin: props.initial.asin,
      }),
    [status, validation, props.restrictions, props.initial.asin, props.requirements],
  );

  const actions = availableActions(
    { status, validationErrorCount: validation.errorCount, submittedBy: props.initial.submittedBy },
    props.actor,
  );

  const editable = status === "draft" || status === "rejected" || status === "failed";
  const demo = props.mode === "demo";

  const visibleIssues = validation.issues.filter((i) => (showOnlyErrors ? i.severity === "ERROR" : true));

  async function post(body: Record<string, unknown>, label: string) {
    if (demo) {
      setMessage({ tone: "err", text: "DEMO MODE: chưa cấu hình Supabase nên thao tác không được lưu." });
      return null;
    }
    setBusy(label);
    setMessage(null);
    try {
      const res = await fetch("/api/listing/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        setMessage({ tone: "err", text: String(data.error ?? `Lỗi HTTP ${res.status}`) });
        return null;
      }
      if (Array.isArray(data.history)) setHistory(data.history as EditorHistoryRow[]);
      if (data.draftId) setDraftId(String(data.draftId));
      if (typeof data.revision === "number") setRevision(data.revision);
      if (typeof data.status === "string") setStatus(data.status as DraftStatus);
      router.refresh();
      return data;
    } catch (error) {
      setMessage({ tone: "err", text: (error as Error).message });
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function handleSave() {
    const data = await post(
      {
        action: "save",
        draftId: draftId,
        sellerAccountId: props.sellerAccountId,
        sku: props.sku,
        asin: props.initial.asin,
        productType: props.productType,
        requirements: props.requirements,
        marketplaceId: props.marketplaceId,
        locale: props.locale,
        payload,
        brand,
      },
      "save",
    );
    if (data) {
      const changed = Array.isArray(data.changedFields) ? (data.changedFields as string[]) : [];
      setMessage({
        tone: "ok",
        text: `Đã lưu bản nháp (revision ${data.revision}). ${changed.length} attribute thay đổi. ${validation.errorCount} lỗi ERROR cần sửa trước khi gửi duyệt.`,
      });
    }
  }

  async function handleAction(action: ActionKey) {
    if (!draftId) {
      setMessage({ tone: "err", text: "Lưu bản nháp trước đã." });
      return;
    }
    const data = await post({ action, draftId, note: note || undefined }, action);
    if (data) {
      setMessage({ tone: "ok", text: `Đã chuyển trạng thái → ${DRAFT_STATUS_LABEL[(data.status as DraftStatus) ?? status]}` });
      setNote("");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {demo ? (
        <div className="rounded-[13px] border border-amber/40 bg-amber-soft px-4 py-2.5 text-[12.5px] font-bold text-[#8a5602]">
          DEMO MODE — xem và kiểm tra hạn mức được, nhưng KHÔNG lưu/duyệt/publish được (thiếu Supabase + worker).
        </div>
      ) : null}

      {/* Nói RÕ vì sao form chỉ để đọc — trước đây chỉ có tooltip trên nút bị mờ nên
          người dùng tưởng "nhấn vào không nhập được liệu" mà không biết đường sửa. */}
      {!demo && !props.actor.canWrite ? (
        <div
          role="alert"
          className="rounded-[13px] border border-amber/40 bg-amber-soft px-4 py-2.5 text-[12.5px] text-[#8a5602]"
        >
          <b>Tài khoản này chưa có quyền ghi trên shop “{props.shop}” nên form đang ở chế độ chỉ đọc.</b>
          <div className="mt-1">
            Quyền ghi đến từ 1 trong 2 nguồn: (1) vai trò <code>super_admin</code> (ghi được mọi shop), hoặc (2)
            một dòng <code>iam.assignments</code> có <code>can_write = true</code> cho đúng shop này. Cách cấp:
            đăng nhập bằng tài khoản <code>super_admin</code> → <b>Module 0 → Người dùng</b> → nút{" "}
            <b>Quyền</b> → chọn vai trò <b>Dept Lead</b> (Trưởng phòng) hoặc <b>Operator</b> và tick shop này —
            hệ thống tự gán đủ module kèm quyền ghi cho shop đó.
          </div>
          <div className="mt-1">
            Đây là chặn THẬT ở tầng dữ liệu (RLS + trigger 0014 kiểm lại khi lưu), không phải lỗi giao diện —
            nội dung bên dưới vẫn xem được bình thường.
          </div>
        </div>
      ) : null}

      {/* ---------------- Thanh trạng thái + hành động ---------------- */}
      <section className="rounded-[13px] border border-line bg-card px-[18px] py-4">
        <div className="flex flex-wrap items-center gap-3">
          <Chip tone={status === "published" ? "green" : status === "pending_approval" ? "amber" : status === "failed" ? "red" : "gray"}>
            {DRAFT_STATUS_LABEL[status]}
          </Chip>
          <span className="text-[12.5px] font-semibold text-soft">
            SKU {props.sku} · {props.shop} · {props.productType} · revision {revision}
            {props.initial.asin ? ` · ASIN ${props.initial.asin}` : " · chưa có ASIN (listing mới)"}
          </span>
        </div>

        {!editable ? (
          <div className="mt-2 text-[12px] text-soft">
            Nội dung bị khoá ở trạng thái này (trigger 0014 chặn sửa payload sau khi gửi duyệt/đã publish) —{" "}
            {status === "published" ? "bấm “Mở lại để sửa” để tạo bản sửa mới." : "chờ trưởng phòng xử lý hoặc rút lại."}
          </div>
        ) : null}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleSave}
            disabled={!props.actor.canWrite || !editable || busy !== null}
            className="rounded-[9px] bg-ink px-3.5 py-2 text-[12.5px] font-bold text-white disabled:opacity-40"
            title={!props.actor.canWrite ? "Không có quyền ghi trên shop này" : !editable ? "Nội dung đang bị khoá" : "Lưu thành revision mới"}
          >
            {busy === "save" ? "Đang lưu…" : "Lưu nháp"}
          </button>

          {actions.map((a) => (
            <button
              key={a.action}
              type="button"
              onClick={() => handleAction(a.action)}
              disabled={!a.enabled || busy !== null}
              title={a.disabledReason}
              className={`rounded-[9px] border px-3.5 py-2 text-[12.5px] font-bold disabled:opacity-40 ${
                a.action === "approve"
                  ? "border-line bg-green-soft text-[#0b7a55]"
                  : a.action === "reject"
                    ? "border-line bg-red-soft text-[#a01717]"
                    : "border-line bg-white"
              }`}
            >
              {busy === a.action ? "Đang xử lý…" : a.label}
            </button>
          ))}

          {actions.some((a) => a.needsNote) ? (
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Lý do duyệt / từ chối (lưu vào lịch sử)"
              className="min-w-[240px] flex-1 rounded-[9px] border border-line px-3 py-2 text-[12.5px]"
            />
          ) : null}
        </div>

        {message ? (
          <div className={`mt-3 rounded-[9px] px-3 py-2 text-[12.5px] font-semibold ${message.tone === "err" ? "bg-red-soft text-[#a01717]" : "bg-green-soft text-[#0b7a55]"}`}>
            {message.text}
          </div>
        ) : null}
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
        {/* ---------------- Form động ---------------- */}
        <div>
          {FIELD_GROUPS.map((group) => {
            const fields = FIELDS.filter((f) => f.group === group.key);
            return (
              <Panel key={group.key} title={group.label} hint={group.hint}>
                <div className="flex flex-col gap-3">
                  {fields.map((field) => (
                    <FieldControl
                      key={field.attribute}
                      field={field}
                      payload={payload}
                      onChange={setPayload}
                      disabled={!editable || !props.actor.canWrite}
                      validation={validation}
                      locale={props.locale}
                      marketplaceId={props.marketplaceId}
                    />
                  ))}
                </div>
              </Panel>
            );
          })}
        </div>

        {/* ---------------- Kiểm tra + lịch sử ---------------- */}
        <div>
          <Panel
            title="Kiểm tra hạn mức Amazon"
            hint={validation.source === "vexim-policy" ? "hạn mức mặc định" : "theo JSON Schema product type"}
          >
            <div className="mb-2 flex flex-wrap items-center gap-2 text-[12px] font-bold">
              <span className={validation.errorCount > 0 ? "text-[#a01717]" : "text-[#0b7a55]"}>
                {validation.errorCount} lỗi ERROR
              </span>
              <span className="text-[#8a5602]">{validation.warningCount} cảnh báo</span>
              <span className="text-soft">{validation.infoCount} thông tin</span>
              <label className="ml-auto flex items-center gap-1.5 font-medium text-soft">
                <input type="checkbox" checked={showOnlyErrors} onChange={(e) => setShowOnlyErrors(e.target.checked)} />
                chỉ lỗi
              </label>
            </div>

            <div className="max-h-[320px] overflow-auto pr-1">
              {visibleIssues.length === 0 ? (
                <div className="text-[12.5px] text-soft">Không có vấn đề nào — bản nháp đạt hạn mức.</div>
              ) : (
                <ul className="flex flex-col gap-2">
                  {visibleIssues.map((issue, index) => (
                    <IssueRow key={`${issue.code}-${index}`} issue={issue} />
                  ))}
                </ul>
              )}
            </div>

            <div className="mt-3 border-t border-line pt-2">
              {Object.entries(validation.limits).slice(0, 8).map(([attribute, limit]) => (
                <div key={attribute} className="flex items-center justify-between gap-2 py-0.5 text-[11.5px]">
                  <span className="truncate text-soft">{limit.label}</span>
                  <span className={limit.max != null && limit.used > limit.max ? "font-bold text-[#a01717]" : "font-semibold"}>
                    {limit.used}
                    {limit.max != null ? `/${limit.max}` : ""} {limit.unit === "bytes" ? "byte" : "ký tự"}
                  </span>
                </div>
              ))}
            </div>
          </Panel>

          <Panel title="Cổng publish" hint="kiểm tra trước khi gửi Amazon">
            {gate.ok ? (
              <div className="text-[12.5px] font-bold text-[#0b7a55]">Đủ điều kiện publish.</div>
            ) : (
              <ul className="mb-2 flex flex-col gap-1.5">
                {gate.blockers.map((b) => (
                  <li key={b} className="text-[12px] font-semibold text-[#a01717]">
                    • {b}
                  </li>
                ))}
              </ul>
            )}
            {gate.warnings.map((w) => (
              <div key={w} className="text-[11.5px] text-[#8a5602]">
                ⚠ {w}
              </div>
            ))}
          </Panel>

          <Panel title="Lịch sử thay đổi" hint="catalog.listing_draft_revisions (append-only)">
            {history.length === 0 ? (
              <div className="text-[12.5px] text-soft">Chưa có lịch sử — bản nháp chưa được lưu lần nào.</div>
            ) : (
              <ol className="flex flex-col gap-2">
                {history.map((row) => (
                  <li key={`${row.revision}-${row.stage}`} className="border-l-2 border-line pl-2.5 text-[12px]">
                    <div className="font-bold">
                      #{row.revision} · {row.stageLabel}
                    </div>
                    <div className="text-soft">{new Date(row.createdAt).toLocaleString("vi-VN")}</div>
                    {row.note ? <div className="text-soft">“{row.note}”</div> : null}
                    {row.changedFields && row.changedFields.length > 0 ? (
                      <div className="text-soft">đổi: {row.changedFields.slice(0, 6).join(", ")}{row.changedFields.length > 6 ? "…" : ""}</div>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

function IssueRow({ issue }: { issue: ValidationIssue }) {
  return (
    <li className="text-[12px] leading-snug">
      <span className={`font-extrabold ${TONE[issue.severity]}`}>{issue.severity}</span>{" "}
      <span className="font-semibold">{issue.message}</span>
      {issue.hint ? <div className="text-soft">{issue.hint}</div> : null}
      <div className="text-[11px] text-soft">
        {issue.code}
        {issue.amazonCode ? ` · Amazon ${issue.amazonCode}` : ""}
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* Ảnh xem trước bên phải ô nhập link ảnh                              */
/* ------------------------------------------------------------------ */

/**
 * Ảnh nhỏ cạnh ô nhập link (yêu cầu 16/09/2026): dán link vào là thấy ngay ảnh
 * thật — khỏi mở tab khác mới biết mình vừa dán đúng ảnh nào.
 *
 *    • link rỗng            → không hiện gì (ô nhập vẫn gọn như cũ)
 *    • link không phải https → hiện chip "URL?" (cùng luật với cổng validation)
 *    • link https nhưng tải lỗi (404, chặn hotlink, không phải file ảnh)
 *                           → hiện chip "lỗi" + tooltip, KHÔNG hiện icon ảnh vỡ
 *    • tải được             → thumbnail 48×48, bấm vào mở ảnh gốc ở tab mới
 *
 * `key` ở nơi gọi được đặt theo URL ⇒ đổi link là component mới, trạng thái "lỗi"
 * của link cũ tự được xoá (không cần useEffect).
 */
function ImagePreview({ url, label }: { url: string; label: string }) {
  const [failed, setFailed] = useState(false);
  const clean = url.trim();
  // Đợi người dùng gõ/paste xong 0,5s mới thử tải: tránh việc vừa gõ nửa link đã
  // nháy chip "lỗi", mà vẫn thấy ảnh gần như tức thì khi dán link hoàn chỉnh.
  const [attempt, setAttempt] = useState(clean);
  useEffect(() => {
    if (clean === attempt) return;
    const timer = setTimeout(() => {
      setFailed(false);
      setAttempt(clean);
    }, 500);
    return () => clearTimeout(timer);
  }, [clean, attempt]);

  if (clean === "") return null;
  if (clean !== attempt) return null; // đang gõ → chưa kết luận gì

  if (!isHttpsImageUrl(clean)) {
    return (
      <span
        title={`Link ảnh phải bắt đầu bằng https:// — đang là: ${clean}`}
        className="mt-1 grid h-12 w-12 shrink-0 place-items-center rounded-[9px] border border-dashed border-red-400 text-[10px] font-extrabold text-[#a01717]"
      >
        URL?
      </span>
    );
  }

  if (failed) {
    return (
      <span
        title={`Không tải được ảnh từ link này (404 / chặn hotlink / không phải file ảnh): ${clean}`}
        className="mt-1 grid h-12 w-12 shrink-0 place-items-center rounded-[9px] border border-dashed border-amber text-[10px] font-extrabold text-[#8a5602]"
      >
        lỗi
      </span>
    );
  }

  return (
    <a
      href={clean}
      target="_blank"
      rel="noreferrer"
      title={`${label} — bấm để mở ảnh gốc ở tab mới\n${clean}`}
      className="mt-1 block h-12 w-12 shrink-0"
    >
      <img
        src={clean}
        alt={`Xem trước ${label}`}
        loading="lazy"
        onError={() => setFailed(true)}
        className="h-12 w-12 rounded-[9px] border border-line bg-white object-contain"
      />
    </a>
  );
}

/* ------------------------------------------------------------------ */
/* Điều khiển từng trường                                             */
/* ------------------------------------------------------------------ */

function FieldControl({
  field,
  payload,
  onChange,
  disabled,
  validation,
  locale,
  marketplaceId,
}: {
  field: (typeof FIELDS)[number];
  payload: ListingDraftPayload;
  onChange: (next: ListingDraftPayload) => void;
  disabled: boolean;
  validation: ReturnType<typeof validateListingDraft>;
  locale: string;
  marketplaceId: string;
}) {
  const limit = validation.limits[field.limitAttribute ?? field.attribute];
  const opts = { locale, marketplaceId };
  const over = limit?.max != null && limit.used > limit.max;
  const inputCls = `w-full rounded-[9px] border px-3 py-2 text-[13px] disabled:bg-black/5 ${
    over ? "border-red-400" : "border-line"
  }`;

  const header = (
    <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
      <span className="text-[12.5px] font-bold">
        {field.label}
        {field.required ? <span className="text-[#a01717]"> *</span> : <span className="text-soft"> (tuỳ chọn)</span>}
      </span>
      {limit ? (
        <span className={`text-[11.5px] font-semibold ${over ? "text-[#a01717]" : "text-soft"}`}>
          {limit.used}
          {limit.max != null ? `/${limit.max}` : ""} {limit.unit === "bytes" ? "byte" : "ký tự"}
        </span>
      ) : null}
    </div>
  );

  switch (field.kind) {
    case "title":
    case "highlight":
    case "text": {
      return (
        <div>
          {header}
          <input
            className={inputCls}
            disabled={disabled}
            value={getTextAttribute(payload, field.attribute)}
            onChange={(e) => onChange(setTextAttribute(payload, field.attribute, e.target.value, opts))}
            placeholder={field.attribute === "brand" ? "Thương hiệu đã đăng ký" : undefined}
          />
          <div className="mt-1 text-[11px] text-soft">{field.help}</div>
        </div>
      );
    }

    case "textarea": {
      return (
        <div>
          {header}
          <textarea
            className={`${inputCls} min-h-[96px]`}
            disabled={disabled}
            value={getTextAttribute(payload, field.attribute)}
            onChange={(e) => onChange(setTextAttribute(payload, field.attribute, e.target.value, opts))}
          />
          <div className="mt-1 text-[11px] text-soft">{field.help}</div>
        </div>
      );
    }

    case "bullets": {
      const bullets = getTextList(payload, "bullet_point");
      const rows = [...bullets];
      while (rows.length < Math.min(MAX_BULLETS, bullets.length + 1)) rows.push("");
      return (
        <div>
          {header}
          <div className="flex flex-col gap-2">
            {rows.map((value, index) => (
              <div key={index} className="flex items-start gap-2">
                <span className="mt-2 w-4 text-[11px] font-bold text-soft">{index + 1}</span>
                <input
                  className={inputCls}
                  disabled={disabled}
                  value={value}
                  onChange={(e) => {
                    const next = [...rows];
                    next[index] = e.target.value;
                    onChange(setTextList(payload, "bullet_point", next, opts));
                  }}
                />
                {rows.length > 1 ? (
                  <button
                    type="button"
                    disabled={disabled}
                    className="mt-1.5 text-[11.5px] font-bold text-soft disabled:opacity-40"
                    onClick={() => onChange(setTextList(payload, "bullet_point", rows.filter((_, i) => i !== index), opts))}
                  >
                    xoá
                  </button>
                ) : null}
              </div>
            ))}
            {rows.length < MAX_BULLETS ? (
              <button
                type="button"
                disabled={disabled}
                className="self-start text-[11.5px] font-bold text-soft disabled:opacity-40"
                onClick={() => onChange(setTextList(payload, "bullet_point", [...rows, ""], opts))}
              >
                + thêm bullet ({rows.length}/{MAX_BULLETS})
              </button>
            ) : null}
          </div>
          <div className="mt-1 text-[11px] text-soft">{field.help}</div>
        </div>
      );
    }

    case "images": {
      const isMain = field.attribute === "main_product_image_locator";
      const attributes = isMain
        ? ["main_product_image_locator"]
        : Array.from({ length: MAX_IMAGES - 1 }, (_, i) => `other_product_image_locator_${i + 1}`);
      return (
        <div>
          {header}
          <div className="flex flex-col gap-2">
            {attributes.map((attribute) => {
              const urls = getImageUrls(payload, attribute);
              const url = urls[0] ?? "";
              const label = attribute === "main_product_image_locator" ? "Ảnh chính" : `Ảnh ${attribute.split("_").pop()}`;
              return (
                <div key={attribute} className="flex items-start gap-2">
                  <span className="mt-2 w-[92px] shrink-0 text-[11px] font-semibold text-soft">{label}</span>
                  <input
                    className={`${inputCls} min-w-0 flex-1`}
                    disabled={disabled}
                    placeholder="https://m.media-amazon.com/images/I/....jpg"
                    value={url}
                    onChange={(e) => onChange(setImageUrls(payload, attribute, e.target.value ? [e.target.value] : []))}
                  />
                  {/* Ảnh xem trước: dán link vào là thấy ngay ảnh thật ở bên phải ô nhập */}
                  <ImagePreview url={url} label={label} />
                </div>
              );
            })}
          </div>
          <div className="mt-1 text-[11px] text-soft">
            {field.help} Dán link ảnh (https) vào ô — ảnh xem trước hiện ngay bên phải ô đó; bấm vào ảnh để mở
            tab mới xem kích thước thật.
          </div>
        </div>
      );
    }

    case "offer": {
      const offer = getOffer(payload);
      return (
        <div>
          {header}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <label className="flex flex-col gap-0.5 text-[11px] font-bold text-soft">
              audience
              <input
                className={inputCls}
                disabled={disabled}
                placeholder="ALL"
                value={offer.audience}
                onChange={(e) => onChange(setOffer(payload, { audience: e.target.value }))}
              />
            </label>
            <label className="flex flex-col gap-0.5 text-[11px] font-bold text-soft">
              currency
              <input
                className={inputCls}
                disabled={disabled}
                placeholder="USD"
                value={offer.currency}
                onChange={(e) => onChange(setOffer(payload, { currency: e.target.value }))}
              />
            </label>
            <label className="flex flex-col gap-0.5 text-[11px] font-bold text-soft">
              Giá bán (có thuế)
              <input
                className={inputCls}
                disabled={disabled}
                placeholder="129.99"
                value={offer.price}
                onChange={(e) => onChange(setOffer(payload, { price: parseNumberOrNull(e.target.value) }))}
              />
            </label>
            <label className="flex flex-col gap-0.5 text-[11px] font-bold text-soft">
              Giá niêm yết
              <input
                className={inputCls}
                disabled={disabled}
                placeholder="159.99"
                value={offer.listPrice}
                onChange={(e) => onChange(setOffer(payload, { listPrice: parseNumberOrNull(e.target.value) }))}
              />
            </label>
          </div>
          <div className="mt-1 text-[11px] text-soft">{field.help}</div>
        </div>
      );
    }

    case "fulfillment": {
      const fulfillment = getFulfillment(payload);
      return (
        <div>
          {header}
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-0.5 text-[11px] font-bold text-soft">
              Kênh
              <select
                className={inputCls}
                disabled={disabled}
                value={fulfillment.channel}
                onChange={(e) => onChange(setFulfillment(payload, { channel: e.target.value }))}
              >
                {["DEFAULT", "AMAZON_NA", "AMAZON_EU", "AMAZON_FE", "AMAZON_JP"].map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-0.5 text-[11px] font-bold text-soft">
              Số lượng
              <input
                className={inputCls}
                disabled={disabled}
                placeholder="42"
                value={fulfillment.quantity}
                onChange={(e) => onChange(setFulfillment(payload, { quantity: parseIntegerOrNull(e.target.value) }))}
              />
            </label>
          </div>
          <div className="mt-1 text-[11px] text-soft">{field.help}</div>
        </div>
      );
    }

    case "variation": {
      const isParentField = field.attribute === "parentage_level";
      if (isParentField) {
        const level = getParentageLevel(payload);
        return (
          <div>
            {header}
            <select
              className={inputCls}
              disabled={disabled}
              value={level}
              onChange={(e) => onChange(setParentageLevel(payload, (e.target.value || "NONE") as "NONE" | "PARENT" | "CHILD"))}
            >
              <option value="NONE">NONE — sản phẩm đơn</option>
              <option value="PARENT">PARENT — sản phẩm cha</option>
              <option value="CHILD">CHILD — sản phẩm con</option>
            </select>
            {getParentageLevel(payload) === "CHILD" ? (
              <input
                className={`${inputCls} mt-2`}
                disabled={disabled}
                placeholder="parent_sku"
                value={getParentSku(payload)}
                onChange={(e) => onChange(setParentSku(payload, e.target.value))}
              />
            ) : null}
            <div className="mt-1 text-[11px] text-soft">{field.help}</div>
          </div>
        );
      }
      return (
        <div>
          {header}
          <input
            className={inputCls}
            disabled={disabled}
            placeholder="COLOR / SIZE / COLOR_SIZE"
            value={getVariationTheme(payload)}
            onChange={(e) => onChange(setVariationTheme(payload, e.target.value))}
          />
          <div className="mt-1 text-[11px] text-soft">{field.help}</div>
        </div>
      );
    }

    default:
      return null;
  }
}

function parseNumberOrNull(value: string): number | null {
  const raw = value.trim();
  if (!raw) return null;
  // Cho phép cả "129.99" và "129,99"; bỏ dấu phân cách nghìn
  const normalized = raw.replace(/[^\d.,-]/g, "").replace(/\.(?=\d{3}\b)/g, "").replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseIntegerOrNull(value: string): number | null {
  const parsed = parseNumberOrNull(value);
  return parsed == null ? null : Math.trunc(parsed);
}

/** Các attribute ảnh thực tế có trong payload (dùng khi đếm ảnh ở panel). */
export function imageAttributeList(payload: ListingDraftPayload): string[] {
  return Object.keys(payload).filter(isImageAttribute);
}
