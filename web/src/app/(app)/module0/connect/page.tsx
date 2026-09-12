/**
 * /module0/connect — BẢNG ĐIỀU KHIỂN KẾT NỐI AMAZON (Module 0: OAuth & multi-tenant).
 *
 * Trang này trả lời đúng 3 câu hỏi của người vận hành:
 *   1. Shop nào đã kết nối, shop nào chưa? (bảng shop × service)
 *   2. Token nào sắp chết? (đếm ngược hạn re-authorize 365 ngày — Amazon chỉ gửi
 *      email nhắc cho CHỦ SHOP, developer không nhận được gì, nên phải tự đếm)
 *   3. Làm gì tiếp? (nút Authorize cho người có phiên + link có chữ ký để GỬI CHỦ
 *      SHOP, và ô nạp refresh token có sẵn)
 *
 * Dữ liệu từ view `vexim_connections` (SECURITY DEFINER + tự lọc
 * iam.can_read_seller_account → mỗi người chỉ thấy shop mình phụ trách). View
 * KHÔNG có cột token nào, nên trang này không thể lộ refresh token dù bị soi HTML.
 */
import Link from "next/link";

import { CopyField, ImportTokenForm } from "@/components/module0/ConnectionActions";
import { Chip, KpiCard, KpiGrid, NoAccess, PageHeader, Panel, tableCls } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import { readConnectionRows, readOAuthEventRows } from "@/lib/data/connections";
import {
  EVENT_COLUMNS,
  REAUTH_HINT,
  REAUTH_LABEL,
  REAUTH_TONE,
  SERVICES,
  SERVICE_SHORT,
  daysLabel,
  eventLine,
  eventTone,
  formatDate,
  formatDateTime,
  groupConnectionsByShop,
  reauthCell,
  summarizeConnections,
  type ConnectionUiRow,
  type OAuthEventUiRow,
  type ShopConnection,
} from "@/lib/data/connections-model";
import { buildStartLink, loadOAuthConfig, type OAuthService } from "@/lib/oauth";
import type { PersonaKey } from "@/lib/roles";

/** CEO quản lý mọi kết nối; op_ppc cần token Ads để chạy Module 5. */
const ALLOWED: PersonaKey[] = ["ceo", "op_ppc"];

export const dynamic = "force-dynamic";

type Props = {
  searchParams: Promise<{
    oauth?: string;
    service?: string;
    shop?: string;
    reason?: string;
    detail?: string;
    reauthorizeAt?: string;
    daysToReauth?: string;
  }>;
};

/* ------------------------------------------------------------------ */
/* Banner kết quả trả về từ /api/amazon/oauth/callback                 */
/* ------------------------------------------------------------------ */
function ResultBanner({ sp }: { sp: Awaited<Props["searchParams"]> }) {
  if (!sp.oauth) return null;
  const svc = sp.service === "ads" ? "Ads API" : sp.service === "spapi" ? "SP-API" : sp.service;

  if (sp.oauth === "ok") {
    const days = sp.daysToReauth ? Number(sp.daysToReauth) : null;
    return (
      <div className="mb-4 rounded-[13px] border border-[#bfe6d3] bg-[#f2fbf7] px-4 py-3">
        <div className="text-[13.5px] font-extrabold text-[#0b7a55]">
          Đã lưu refresh token {svc} — hạn re-authorize {formatDate(sp.reauthorizeAt ?? null)}
          {days !== null && Number.isFinite(days) ? ` (còn ${days.toLocaleString("vi-VN")} ngày)` : ""}.
        </div>
        <div className="mt-0.5 text-[12.5px] text-[#0b7a55]">
          Token đã mã hoá AES-256-GCM (<code>enc:v1:</code>) trong <code>connections.oauth_tokens</code>; cron sẽ tự
          đổi access token mỗi giờ. Hệ thống tự nhắc trước 30 ngày khi tới hạn 365 ngày.
        </div>
      </div>
    );
  }

  const denied = sp.oauth === "denied";
  return (
    <div className="mb-4 rounded-[13px] border border-[#f2c9c9] bg-[#fdf4f4] px-4 py-3">
      <div className="text-[13.5px] font-extrabold text-[#a01717]">
        {denied ? `Chủ shop chưa cấp quyền ${svc}.` : `Kết nối ${svc} thất bại.`}{" "}
        {sp.reason ? <span className="font-mono text-[12px]">({sp.reason})</span> : null}
      </div>
      {sp.detail ? <div className="mt-0.5 text-[12.5px] text-[#a01717]">{sp.detail}</div> : null}
      <div className="mt-1 text-[12px] text-muted">
        Không có token nào được ghi. Bấm Authorize lại ở bảng dưới — mỗi link chỉ dùng được MỘT lần trong 10 phút.
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Ô một service trong bảng                                            */
/* ------------------------------------------------------------------ */
function ServiceCell({
  row,
  service,
  linkReady,
  startHref,
  signedLink,
}: {
  row: ConnectionUiRow | null;
  service: OAuthService;
  linkReady: boolean;
  startHref: string;
  signedLink: string | null;
}) {
  const state = row?.reauthState ?? "missing";
  const tone = row ? REAUTH_TONE[row.reauthState] : "gray";
  const label = row ? REAUTH_LABEL[row.reauthState] : REAUTH_LABEL.missing;
  const isReauth = state === "due_soon" || state === "overdue" || state === "expired" || state === "revoked";

  return (
    <td className={tableCls.td}>
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip tone={tone}>{label}</Chip>
          <span className="text-[11.5px] text-soft">{row ? reauthCell(row) : "—"}</span>
        </div>

        {row?.tokenSource ? (
          <span className="text-[11px] text-soft">
            nguồn: {row.tokenSource === "oauth" ? "chủ shop authorize" : row.tokenSource}
            {row.scope ? ` · scope ${row.scope}` : ""}
          </span>
        ) : null}

        {row?.lastError ? (
          <span className="text-[11.5px] font-semibold text-[#a01717]">lỗi cuối: {row.lastError.slice(0, 120)}</span>
        ) : null}

        <div className="flex flex-wrap items-center gap-1.5">
          {linkReady ? (
            <a
              href={startHref}
              className="rounded-md border border-line bg-white px-2 py-1 text-[11.5px] font-extrabold text-accent-ink hover:bg-[#f2f6ff]"
            >
              {isReauth ? "Kết nối lại" : row ? "Authorize lại" : "Authorize"}
            </a>
          ) : (
            <span className="rounded-md bg-[#eef1f5] px-2 py-1 text-[11.5px] font-bold text-muted">
              thiếu credential {SERVICE_SHORT[service]}
            </span>
          )}
        </div>

        {signedLink ? (
          <details className="text-[11px]">
            <summary className="cursor-pointer font-bold text-soft hover:text-accent-ink">
              Link gửi chủ shop (không cần tài khoản VEXIM)
            </summary>
            <div className="mt-1">
              <CopyField value={signedLink} label={`Link authorize ${SERVICE_SHORT[service]}`} />
              <div className="mt-1 text-[11px] text-muted">
                Chữ ký phủ (dịch vụ · shop) nên không đổi đích được. Link sống 10 phút kể từ lúc bấm.
              </div>
            </div>
          </details>
        ) : null}
      </div>
    </td>
  );
}

/* ------------------------------------------------------------------ */
/* SOP — giữ lại để người mới biết luồng chạy thế nào                  */
/* ------------------------------------------------------------------ */
const STEPS = [
  {
    n: 1,
    title: "Bấm Authorize (hoặc gửi link cho chủ shop)",
    detail:
      "SP-API: trang consent của Seller Central (cần AMAZON_SP_API_APPLICATION_ID). Ads API: Login with Amazon /ap/oa với scope ads::campaign_management.",
  },
  {
    n: 2,
    title: "Chủ shop đồng ý trên Amazon",
    detail:
      "Amazon redirect về /api/amazon/oauth/callback kèm code (SP-API trả tham số spapi_oauth_code). Code chỉ sống 5 phút và state chỉ dùng được MỘT lần.",
  },
  {
    n: 3,
    title: "Đổi code lấy refresh token rồi mã hoá",
    detail:
      "LWA trả access_token (1 giờ) + refresh_token (dài hạn). Server mã hoá AES-256-GCM thành enc:v1:… trước khi ghi connections.oauth_tokens — không có bước nào lưu plaintext.",
  },
  {
    n: 4,
    title: "Cron tự đổi access token",
    detail:
      "Worker/cron gọi LWA bằng refresh token mỗi khi access token hết hạn, cập nhật last_refresh_at. 429 thì không retry dồn.",
  },
  {
    n: 5,
    title: "Đếm ngược 365 ngày",
    detail:
      "reauthorize_at = ngày authorize + 365. Cron /api/cron/oauth-reauth (01:30 UTC) nhắc trước 30 ngày, quá hạn thì chuyển token sang expired và bật cảnh báo đỏ.",
  },
];

export default async function ConnectPage({ searchParams }: Props) {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;
  const sp = await searchParams;

  const config = loadOAuthConfig();
  let rows: ConnectionUiRow[] = [];
  let events: OAuthEventUiRow[] = [];
  let failed: string | null = null;
  try {
    rows = await readConnectionRows();
    events = await readOAuthEventRows(25);
  } catch (error) {
    failed = error instanceof Error ? error.message : "Không đọc được trạng thái kết nối";
  }

  const shops: ShopConnection[] = groupConnectionsByShop(rows);
  const summary = summarizeConnections(rows);
  const secret = config.stateSecret;
  const linkFor = (service: OAuthService, shopId: string) =>
    secret ? buildStartLink({ baseUrl: config.baseUrl, service, shop: shopId, secret }) : null;

  return (
    <>
      <PageHeader
        title="Kết nối Amazon"
        sub="Module 0 · OAuth & multi-tenant · SOP-11"
        desc="Refresh token của từng shop, hạn re-authorize 365 ngày, và link gửi chủ shop. Trang này không bao giờ hiện token — view vexim_connections không có cột token."
      />

      <ResultBanner sp={sp} />

      {failed ? (
        <Panel title="Trạng thái kết nối" hint="không đọc được dữ liệu">
          <p className="text-[13px] text-amber">
            {failed}. Kiểm tra migration <code>0020_module0_oauth_module5_ppc_read.sql</code> đã chạy trên Supabase
            chưa (view <code>vexim_connections</code> + 5 RPC <code>vexim_oauth_*</code>).
          </p>
        </Panel>
      ) : (
        <>
          <KpiGrid>
            <KpiCard
              label="Shop bạn thấy"
              value={String(summary.shops)}
              sub={`${summary.connectedTokens} token đã lưu (mỗi shop tối đa 2: SP-API + Ads)`}
            />
            <KpiCard
              label="Đang kết nối tốt"
              value={String(summary.ok)}
              sub={summary.overdue > 0 ? `${summary.overdue} token đã quá hạn/chết` : "chưa có token nào quá hạn"}
              tone={summary.overdue > 0 ? "down" : "up"}
            />
            <KpiCard
              label="Gần tới hạn nhất"
              value={summary.nearestDays === null ? "—" : daysLabel(summary.nearestDays)}
              sub={summary.nearestShop ?? "chưa có token nào để đếm"}
              tone={
                summary.nearestDays === null
                  ? "flat"
                  : summary.nearestDays <= 0
                    ? "down"
                    : summary.nearestDays <= 30
                      ? "warn"
                      : "flat"
              }
            />
            <KpiCard
              label="Shop cần hành động"
              value={String(summary.shopsNeedingAction)}
              sub={summary.missing > 0 ? `${summary.missing} service chưa kết nối` : "đủ cả hai service"}
              tone={summary.shopsNeedingAction > 0 ? "warn" : "up"}
            />
          </KpiGrid>

          {config.problems.length > 0 ? (
            <Panel title="Cấu hình OAuth chưa đủ" hint="thiếu gì thì sửa cái đó, không đoán">
              <ul className="flex flex-col gap-1.5">
                {config.problems.map((p) => (
                  <li key={p} className="flex gap-2 text-[12.5px] text-[#8a5602]">
                    <span aria-hidden>⚠️</span>
                    <span>{p}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[12px] text-muted">
                Redirect URI đang dùng: <code>{config.redirectUri}</code> — phải KHỚP TUYỆT ĐỐI giá trị khai trong app
                Amazon (SP-API: Developer Central → OAuth redirect URL; Ads: Security profile → OAuth redirect URL).
              </p>
            </Panel>
          ) : null}

          <Panel
            title="Shop × dịch vụ"
            hint="hạn re-authorize = ngày authorize + 365 ngày · Amazon chỉ email nhắc cho CHỦ SHOP nên hệ thống phải tự đếm"
          >
            {shops.length === 0 ? (
              <p className="text-[13px] text-muted">
                Chưa có shop nào bạn được quyền thấy trong <code>connections.seller_accounts</code>. Nhờ super_admin
                gán bạn vào <code>iam.assignments</code> (RLS lọc theo đó).
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className={tableCls.table}>
                  <thead>
                    <tr>
                      <th className={tableCls.th}>Shop</th>
                      <th className={tableCls.th}>SP-API</th>
                      <th className={tableCls.th}>Ads API</th>
                      <th className={tableCls.th}>Việc phải làm</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shops.map((shop) => (
                      <tr key={shop.sellerAccountId}>
                        <td className={tableCls.td}>
                          <div className="text-[13px] font-extrabold">{shop.shop}</div>
                          <div className="text-[11px] text-soft">
                            {shop.marketplace ?? "chưa rõ marketplace"}
                            {shop.dataSource === "production" ? "" : ` · ${shop.dataSource ?? "?"}`}
                          </div>
                          <div className="mt-0.5 font-mono text-[10.5px] text-soft">
                            {shop.sellerAccountId.slice(0, 8)}…
                          </div>
                        </td>

                        {SERVICES.map((svc) => {
                          const row = shop.byService[svc];
                          const ready = svc === "ads" ? !!config.services.ads : !!config.services.spapi;
                          return (
                            <ServiceCell
                              key={svc}
                              row={row}
                              service={svc}
                              linkReady={ready && !!secret}
                              startHref={`/api/amazon/oauth/start?service=${svc}&shop=${encodeURIComponent(shop.sellerAccountId)}`}
                              signedLink={ready ? linkFor(svc, shop.sellerAccountId) : null}
                            />
                          );
                        })}

                        <td className={tableCls.td}>
                          {shop.actions.length === 0 ? (
                            <span className="text-[12px] text-[#0b7a55]">Không cần làm gì — cả hai service còn hạn.</span>
                          ) : (
                            <ul className="flex flex-col gap-1">
                              {shop.actions.map((a) => (
                                <li key={a} className="text-[12px] text-ink">
                                  • {a}
                                </li>
                              ))}
                            </ul>
                          )}
                          {REAUTH_HINT[shop.worstState] ? (
                            <div className="mt-1 text-[11.5px] text-muted">{REAUTH_HINT[shop.worstState]}</div>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <Panel
            title="Nạp refresh token có sẵn"
            hint="dùng khi đã giữ token (ví dụ AMAZON_ADS_REFRESH_TOKEN) — khỏi cần chủ shop bấm"
          >
            <ImportTokenForm
              shops={shops.map((s) => ({ id: s.sellerAccountId, name: s.shop }))}
              services={SERVICES.filter((s) => (s === "ads" ? !!config.services.ads : !!config.services.spapi))}
              envToken={{
                spapi: !!config.services.spapi?.envRefreshToken,
                ads: !!config.services.ads?.envRefreshToken,
              }}
            />
          </Panel>

          <Panel
            title="Nhật ký luồng kết nối"
            hint={`20 sự kiện gần nhất · bảng connections.oauth_events (không chứa token)`}
          >
            {events.length === 0 ? (
              <p className="text-[13px] text-muted">
                Chưa có sự kiện nào. Bấm Authorize ở bảng trên, hoặc POST{" "}
                <code>/api/amazon/oauth/import</code> để nạp token — mọi lượt đều được ghi lại ở đây.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className={tableCls.table}>
                  <thead>
                    <tr>
                      <th className={tableCls.th}>Thời điểm</th>
                      <th className={tableCls.th}>Sự kiện</th>
                      <th className={tableCls.th}>Trạng thái</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((e) => (
                      <tr key={e.id}>
                        <td className={`${tableCls.td} whitespace-nowrap text-[12px] text-soft`}>
                          {formatDateTime(e.createdAt)}
                        </td>
                        <td className={tableCls.td}>
                          <span className="text-[12.5px]">{eventLine(e)}</span>
                          <span className="ml-2 font-mono text-[10.5px] text-soft">{e.event}</span>
                        </td>
                        <td className={tableCls.td}>
                          <Chip tone={eventTone(e)}>{e.status ?? "—"}</Chip>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-2 text-[11.5px] text-soft">
              Cột đọc từ view: <code>{EVENT_COLUMNS.join(", ")}</code>. RPC ghi sự kiện đã chặn chuỗi giống credential
              nên nhật ký không thể rò token.
            </p>
          </Panel>

          <Panel title="Luồng chạy thế nào" hint="5 bước từ lúc bấm tới lúc cron tự nuôi token">
            <ol className="flex flex-col">
              {STEPS.map((s) => (
                <li key={s.n} className="flex gap-3 border-b border-dashed border-[#eef0f4] py-2.5 last:border-0">
                  <span className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-full bg-[#eef1f5] text-[13px] font-extrabold text-soft">
                    {s.n}
                  </span>
                  <div>
                    <div className="text-[13.5px] font-bold">{s.title}</div>
                    <div className="text-[12px] text-soft">{s.detail}</div>
                  </div>
                </li>
              ))}
            </ol>
          </Panel>

          <Panel title="Điều kiện để chạy thật trên production">
            <div className="flex flex-col gap-2 text-[13px]">
              <Row tone="green" text="Migration 0020: bảng oauth_tokens/oauth_states/oauth_events + 5 RPC + 2 view (535 test xanh)." />
              <Row
                tone={config.services.spapi ? "green" : "amber"}
                text={
                  config.services.spapi
                    ? `Credential SP-API đã cấu hình (vùng ${config.services.spapi.region}${
                        config.services.spapi.applicationId ? ", có application_id → dùng trang consent Seller Central" : ", chưa có application_id → đang dùng luồng LWA /ap/oa"
                      }).`
                    : "Chưa có AMAZON_LWA_CLIENT_ID/SECRET → chưa sinh được link SP-API."
                }
              />
              <Row
                tone={config.services.ads ? "green" : "amber"}
                text={
                  config.services.ads
                    ? `Credential Ads API đã cấu hình (vùng ${config.services.ads.region}, scope ${config.services.ads.scope}).`
                    : "Chưa có AMAZON_ADS_CLIENT_ID/SECRET → Module 5 (PPC) chưa đọc được dữ liệu thật."
                }
              />
              <Row
                tone={config.tokenKey ? "green" : "red"}
                text={
                  config.tokenKey
                    ? "OAUTH_TOKEN_ENC_KEY đã đặt — token lưu dạng enc:v1: (AES-256-GCM)."
                    : "CHƯA đặt OAUTH_TOKEN_ENC_KEY → RPC 0020 TỪ CHỐI lưu token (fail-closed)."
                }
              />
              <Row
                tone="amber"
                text="Amazon duyệt app SP-API production (Developer Profile) — vẫn đang chờ; luồng Ads API không phụ thuộc việc này."
              />
            </div>
            <p className="mt-2 text-[12px] text-muted">
              Xem thêm <Link className="font-bold text-accent-ink underline" href="/ppc">Module 5 · PPC</Link> (dùng
              token Ads ở đây) và <code>docs/ke-hoach-trien-khai-theo-module.md</code>.
            </p>
          </Panel>
        </>
      )}
    </>
  );
}

function Row({ tone, text }: { tone: "green" | "amber" | "red"; text: string }) {
  return (
    <div className="flex items-center gap-2.5 rounded-[10px] border border-line px-3 py-2.5">
      <Chip tone={tone}>{tone === "green" ? "Sẵn" : tone === "amber" ? "Chờ" : "Thiếu"}</Chip>
      <span>{text}</span>
    </div>
  );
}
