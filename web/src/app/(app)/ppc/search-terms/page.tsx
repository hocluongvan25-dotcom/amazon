import { SearchTermsBoard } from "@/components/ppc/SearchTermsBoard";
import { NoAccess, PageHeader, Panel } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import { readAdsDiagnostics } from "@/lib/data/ads-health";
import { a3EmptyReason, stuckGate } from "@/lib/data/ads-health-model";
import { demoChanges, demoSearchTerms } from "@/lib/data/ppc-demo";
import {
  a3HasOpenChange,
  a3InFlightMap,
  a3ReadyToBlock,
  filterSearchTerms,
  type AdsSearchTermRaw,
} from "@/lib/data/ppc-model";
import { readAdsChanges, readAdsPermissions, readAdsSearchTerms } from "@/lib/data/ppc";
import type { PersonaKey } from "@/lib/roles";

const ALLOWED: PersonaKey[] = ["ceo", "op_ppc"];

/** Trần đọc về của `readAdsSearchTerms` (mặc định) — vượt thì phải nói ra, không im lặng cắt. */
const ROW_LIMIT = 3000;

/** Persona nào được bấm duyệt ở DEMO MODE (DB vẫn là chốt cuối ở chế độ thật). */
const DEMO_DECIDERS: PersonaKey[] = ["ceo"];

export default async function SearchTermsPage({
  searchParams,
}: {
  searchParams: Promise<{ campaign?: string; shop?: string }>;
}) {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;
  const sp = await searchParams;
  const campaignId = sp.campaign?.trim() || null;

  if (session.mode === "demo") {
    // Số trên tiêu đề đếm từ chính dữ liệu demo (không hard-code) để tiêu đề không lệch bảng.
    const rows = filterSearchTerms(demoSearchTerms, {
      campaignId: campaignId ?? undefined,
      minSpend: 0,
      minClicks: 0,
      onlyNoOrders: false,
    });
    const demoWaiting = rows.filter((r) => r.pending_suggestion_id !== null).length;
    const demoBlocked = rows.filter((r) => r.negative_keyword_id !== null).length;
    // Demo cũng phải thể hiện phần chống chặn trùng: nếu chỉ chế độ thật có thì
    // người nghiệm thu demo sẽ không bao giờ nhìn thấy nhánh này.
    const demoInFlight = a3InFlightMap(demoChanges);
    const demoFlying = rows.filter((r) => a3HasOpenChange(demoInFlight, r) !== null).length;
    return (
      <>
        <div className="mb-3 text-sm font-bold text-amber">DEMO · Dữ liệu minh họa (chưa nối Supabase)</div>
        <p className="mb-2 text-[12.5px] text-soft">
          Đang ở màn con <b>A3 — Search term &amp; chặn</b> · KPI/campaign tổng xem ở màn{" "}
          <a className="font-bold underline" href="/ppc">Quảng cáo (PPC)</a> · hàng đợi ghi Amazon ở màn{" "}
          <a className="font-bold underline" href="/ppc/approvals">Duyệt thay đổi (A4)</a>.
        </p>
        <PageHeader
          title="A3 — Search term &amp; Negative keyword"
          sub={`${rows.length} dòng demo · ${demoWaiting} gợi ý chờ duyệt · ${demoFlying} yêu cầu chờ ghi Amazon · ${demoBlocked} đã chặn`}
          desc="SOP-04: search term có click nhưng không ra đơn ⇒ gợi ý Negative (Exact/Phrase) kèm bằng chứng; duyệt là vào hàng đợi ghi Amazon."
        />
        <SearchTermsBoard
          rows={rows}
          inFlight={demoInFlight}
          canDecide={DEMO_DECIDERS.includes(session.persona)}
          campaignId={campaignId}
        />
        <Panel title="Vì sao màn này quan trọng" hint={`${demoChanges.length} dòng thay đổi trong demo`}>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-[13px] text-soft">
            <li>Mỗi gợi ý kèm BẰNG CHỨNG (click · chi · số đơn · lý do) — không phải "AI đoán".</li>
            <li>Duyệt một gợi ý = tạo yêu cầu thêm negative đi CÙNG đường ghi với đổi bid/ngân sách.</li>
            <li>Chặn negative không cần duyệt ngưỡng (hành động giảm chi tiêu) nhưng vẫn có nhật ký.</li>
          </ul>
        </Panel>
      </>
    );
  }

  let rows: AdsSearchTermRaw[] = [];
  let inFlight: ReturnType<typeof a3InFlightMap> = {};
  let failed: string | null = null;
  let inFlightError: string | null = null;
  let canDecide = false;
  let canWrite = false;
  try {
    const [data, perms] = await Promise.all([
      readAdsSearchTerms({ sellerAccountId: sp.shop ?? null, campaignId }),
      readAdsPermissions(sp.shop ?? null),
    ]);
    rows = data;
    canDecide = perms.canApprove;
    canWrite = perms.canWrite;
  } catch (error) {
    failed = error instanceof Error ? error.message : "Không đọc được dữ liệu search term";
  }

  // Đọc RIÊNG phần "yêu cầu chặn còn bay": thiếu dữ liệu này thì màn tưởng "chưa
  // chặn" và tạo yêu cầu trùng cho term vừa duyệt xong (xem a3InFlightMap). Nhưng
  // lỗi ở ĐÂY chỉ được làm mất lớp chống trùng (kèm cảnh báo đỏ), KHÔNG được làm
  // trắng cả bảng search term — bảng vẫn đọc được thì vẫn phải hiện.
  // Phải hỏi cả `failed` vì view `is_open` chỉ tính 3 trạng thái đang bay — ca
  // "đã lỗi, cần thử lại" mà lọc theo `is_open` sẽ bị ẩn mất.
  if (!failed) {
    try {
      inFlight = a3InFlightMap(
        await readAdsChanges({
          sellerAccountId: sp.shop ?? null,
          statuses: ["pending_approval", "approved", "applying", "failed"],
          limit: 300,
        }),
      );
    } catch (error) {
      inFlightError = error instanceof Error ? error.message : "Không đọc được hàng đợi thay đổi";
    }
  }

  // Trang trống phải nói được TẮC Ở ĐÂU — dùng lại đúng phần chẩn đoán 5 cổng của
  // màn A1 (credential → profile → cấu trúc → metrics → report). Đọc riêng để lỗi
  // chẩn đoán KHÔNG làm sập danh sách.
  let diagnostics: Awaited<ReturnType<typeof readAdsDiagnostics>> | null = null;
  if (rows.length === 0 && !failed) {
    try {
      diagnostics = await readAdsDiagnostics();
    } catch {
      diagnostics = null;
    }
  }

  /** Tên campaign khi mở từ A2 (chỉ có id trong URL) — lấy từ chính dữ liệu đã đọc. */
  const campaignName = campaignId
    ? (rows.find((r) => r.campaign_id === campaignId)?.campaign_name ?? null)
    : null;
  // "Đáng xem mà chưa ai làm gì" = đúng bộ lọc SOP-04 (≥5 click · chi ≥10 · 0 đơn)
  // VÀ chưa có gợi ý / chưa chặn — cùng định nghĩa với a3ReadyToBlock để con số
  // trên tiêu đề không lệch với cái người dùng lọc ra.
  const ready = a3ReadyToBlock(rows, {}, inFlight).length;
  const waiting = rows.filter((r) => r.pending_suggestion_id !== null).length;
  const blocked = rows.filter((r) => r.negative_keyword_id !== null).length;
  const flying = rows.filter((r) => a3HasOpenChange(inFlight, r) !== null).length;

  return (
    <>
      <PageHeader
        title="A3 — Search term &amp; Negative keyword"
        sub={`${rows.length} dòng dữ liệu · ${waiting} gợi ý chờ duyệt · ${flying} yêu cầu chờ ghi Amazon · ${blocked} đã chặn · ${ready} dòng đáng xem chưa ai làm gì`}
        desc="SOP-04: search term có click nhưng không ra đơn ⇒ gợi ý Negative (Exact/Phrase) kèm bằng chứng; duyệt là vào hàng đợi ghi Amazon (worker:ads-apply)."
      />

      {failed ? (
        <div className="mb-3 rounded-[10px] bg-red-soft px-3.5 py-2.5 text-[13px] font-semibold text-[#a01717]">
          Không đọc được dữ liệu: {failed}
        </div>
      ) : null}

      {/* Chỉ nói "không có quyền ghi" khi THỰC SỰ đọc được quyền: đọc lỗi (đứt mạng/thiếu
          migration) mà vẫn hiện băng này là đổ oan cho phân quyền. */}
      {/* Không đọc được hàng đợi ⇒ lớp chống chặn trùng đang TẮT. Phải nói ra, vì
          bấm chặn lúc này có thể tạo yêu cầu trùng cho term vừa duyệt. */}
      {inFlightError ? (
        <div className="mb-3 rounded-[10px] bg-red-soft px-3.5 py-2.5 text-[13px] font-semibold text-[#a01717]">
          Chưa kiểm tra được <b>yêu cầu chặn còn bay</b> ({inFlightError}) ⇒ cột <i>Thao tác</i> KHÔNG tự khoá được.
          Tải lại trang; nếu vẫn lỗi, xem màn <a className="underline" href="/ppc/approvals">Duyệt &amp; ghi (A4)</a>{" "}
          trước khi bấm chặn để không tạo yêu cầu trùng.
        </div>
      ) : null}

      {!canWrite && !failed ? (
        <div className="mb-3 rounded-[10px] bg-amber-soft px-3.5 py-2.5 text-[13px] font-semibold text-[#8a5602]">
          Tài khoản này KHÔNG có quyền ghi cho shop đang chọn — chỉ xem được. (Đổi shop hoặc xin quyền PPC.)
        </div>
      ) : null}

      {rows.length === 0 ? (
        <>
          {/* KHÔNG lặp lại panel 5 cổng của /ppc ở đây (trước đây hai màn trông y hệt
              nhau khi chưa có dữ liệu). Màn con chỉ nói: tắc ở cổng nào + vì sao RIÊNG
              màn search term trống. Chẩn đoán đầy đủ vẫn ở /ppc, có link sang. */}
          <Panel
            title="Vì sao màn này chưa có dòng search term nào"
            hint="A3 đọc view vexim_ads_search_terms (nguồn: report spSearchTerm)"
          >
            <p className="text-[13px] text-muted">
              {a3EmptyReason(
                diagnostics?.counts ?? {
                  profiles: null,
                  campaigns: null,
                  targets: null,
                  searchTerms: null,
                  metricRows: null,
                  lastMetricDay: null,
                },
                {
                  credentialsOk: diagnostics?.credentials.complete ?? false,
                  // `null` = không đọc nổi chẩn đoán; `ok: false` = Supabase không trả lời
                  // ⇒ cả hai đều là "không biết", phải nói ra chứ không đoán bừa.
                  hasReadError: diagnostics === null || diagnostics.ok === false,
                },
              )}
            </p>
            {(() => {
              const stuck = diagnostics ? stuckGate(diagnostics) : null;
              return stuck ? (
                <div className="mt-2 rounded-[10px] border border-amber/50 bg-amber-soft px-3 py-2.5 text-[12.5px]">
                  <b>⛔ Đang tắc ở {stuck.label}</b> — {stuck.detail}.
                  <div className="mt-1 font-semibold text-[#8a5602]">Việc cần làm: {stuck.fix}</div>
                </div>
              ) : (
                <div className="mt-2 rounded-[10px] border border-line px-3 py-2.5 text-[12.5px] text-soft">
                  Không cổng nào đang chặn ⇒ dữ liệu cấu trúc đã về, chỉ còn thiếu dòng search term (report bất đồng bộ).
                </div>
              );
            })()}
            <p className="mt-2 text-[12.5px] text-soft">
              Chẩn đoán đầy đủ (5 cổng · trạng thái từng lần xin report · nguyên văn lỗi Amazon) nằm ở màn{" "}
              <a className="font-bold underline" href="/ppc">Quảng cáo (PPC)</a>.
            </p>
          </Panel>

          <Panel
            title="Nạp dữ liệu search term bằng cách nào"
            hint="màn A3 đọc view vexim_ads_search_terms · report nguồn: spSearchTerm"
          >
            <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-[13px] text-soft">
              <li>
                <b>Nhanh nhất — không cần shell:</b> mở màn{" "}
                <a className="font-bold underline" href="/ppc">Quảng cáo (PPC)</a> rồi bấm{" "}
                <b>“▶ Chạy đồng bộ Amazon Ads ngay”</b>. Nút này chạy đúng 2 job của cron: đồng bộ cấu trúc rồi kéo 5
                report (màn A3 chỉ ĐỌC, không tự chạy job).
              </li>
              <li>
                <b>Trên máy có shell:</b> trong thư mục <code>worker/</code> chạy{" "}
                <code>npm run worker:ads-pull -- --kind=search-terms --days=30</code> (làm{" "}
                <code>worker:ads-sync</code> trước nếu shop chưa có profile Ads). Bản report cũ: đổi <code>--days</code>,
                tối đa 31 ngày/lần.
              </li>
              <li>
                <b>Chờ cron 03:00 UTC</b> (<code>/api/cron/report-pull</code>) — cron tự chạy hằng ngày, phần Ads bật
                mặc định.
              </li>
              <li>
                <b>App Amazon Ads chưa được duyệt role?</b> Tải report tay trong Ads console rồi nạp file đã giải nén:{" "}
                <code>{"cd worker && npm run worker:ads-pull -- --search-terms=<file.json>"}</code> — đi ĐÚNG pipeline
                parse → DB như chế độ API, nên số liệu không lệch luật.
              </li>
            </ol>
            <p className="mt-2 text-[12.5px] text-soft">
              Gợi ý negative (Exact/Phrase) do job tổng hợp sinh kèm bằng chứng sau khi có dữ liệu; quay lại màn này để
              duyệt. Report v3 là <b>bất đồng bộ</b>: lần đầu có thể Amazon còn <code>PENDING</code> — chờ 1–2 phút rồi
              chạy lại (job tự nhớ report cũ, không xin trùng).
            </p>
          </Panel>
        </>
      ) : (
        <>
        <p className="mb-2 text-[12.5px] text-soft">
          Đang ở màn con <b>A3 — Search term &amp; chặn</b> · số liệu campaign/KPI tổng ở màn{" "}
          <a className="font-bold underline" href="/ppc">Quảng cáo (PPC)</a> · hàng đợi ghi Amazon ở màn{" "}
          <a className="font-bold underline" href="/ppc/approvals">Duyệt thay đổi (A4)</a>.
        </p>
        <SearchTermsBoard
          rows={rows}
          canDecide={canDecide}
          campaignId={campaignId}
          campaignName={campaignName}
          truncated={rows.length >= ROW_LIMIT}
          inFlight={inFlight}
        />
        </>
      )}
    </>
  );
}
