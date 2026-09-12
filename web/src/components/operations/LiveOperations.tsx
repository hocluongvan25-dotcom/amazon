import { PageHeader, Panel } from "@/components/ui";
import { readOperations } from "@/lib/data/operations";
import {
  breakdownRows,
  deadline,
  reconciliation,
  screens,
  text,
  validId,
  type DataRow,
  type Screen,
} from "@/lib/data/operations-model";
import { DataTable } from "./DataTable";

export async function LiveOperations({
  screen,
  id,
  detail = false,
}: {
  screen: Screen;
  id?: string;
  detail?: boolean;
}) {
  const finance = screen === "settlements" || screen === "events";
  let rows: DataRow[] = [],
    childRows: DataRow[] = [];
  let failed = false;
  const now = Date.now();
  const invalidId = detail && !validId(id);
  if (!invalidId) {
    try {
      rows = await readOperations(
        screen,
        detail ? { column: "id", value: id! } : undefined,
      );
      if (detail && rows.length) {
        childRows = await readOperations(
          screen === "orders" ? "items" : "events",
          {
            column: screen === "orders" ? "order_id" : "settlement_id",
            value:
              screen === "orders" ? rows[0].id : String(rows[0].settlement_id),
            sellerAccountId: String(rows[0].seller_account_id),
          },
        );
      }
      if (screen === "fbm")
        rows = rows
          .map((r) => deadline(r, now))
          .sort((a, b) => Number(a.deadlineSort) - Number(b.deadlineSort));
      if (screen === "settlements")
        rows = rows.map((r) => ({ ...r, reconciliation: reconciliation(r) }));
      if (screen !== "fbm") {
        const dateKey =
          screen === "orders"
            ? "purchase_date"
            : screen === "returns"
              ? "return_date"
              : screen === "events"
                ? "event_date"
                : "period_end";
        rows.sort(
          (a, b) =>
            text(b[dateKey]).localeCompare(text(a[dateKey])) ||
            a.id.localeCompare(b.id),
        );
      }
    } catch {
      failed = true;
    }
  }
  const spec = screens[screen];
  const nav = finance
    ? [
        ["/finance/settlements", "Kỳ settlement"],
        ["/finance/events", "Dòng tài chính"],
      ]
    : [
        ["/orders/list", "Đơn hàng"],
        ["/orders/fbm", "Queue FBM"],
        ["/orders/returns", "Returns & Refunds"],
      ];
  return (
    <>
      <PageHeader
        title={`${spec.title}${detail ? " · Chi tiết" : ""}`}
        sub="SUPABASE · theo phạm vi RLS của người đăng nhập"
        desc={`Chỉ đọc · tải lúc ${new Date(now).toISOString()} · dữ liệu DB có thể chưa được đồng bộ Amazon mới nhất. Không hiển thị PII người mua.`}
      />
      <nav className="mb-4 flex gap-4 text-sm text-accent-ink">
        {nav.map(([href, label]) => (
          <a key={href} href={href}>
            {label}
          </a>
        ))}
        <a href="">Tải lại dữ liệu</a>
      </nav>
      {failed ? (
        <Panel title="Không tải được dữ liệu">
          <p role="alert">
            Không thể đọc Supabase. Kiểm tra migration 0010/0011, quyền SELECT,
            RLS và phiên đăng nhập rồi tải lại. Không thay thế bằng dữ liệu
            demo.
          </p>
        </Panel>
      ) : invalidId || (detail && !rows.length) ? (
        <Panel title="Không tìm thấy">
          <p>
            Mã không hợp lệ, bản ghi không tồn tại hoặc bạn không có quyền xem.
            Hãy mở chi tiết từ danh sách.
          </p>
        </Panel>
      ) : (
        <>
          <DataTable
            rows={rows}
            columns={spec.columns.map((c) =>
              detail ? { ...c, link: undefined } : c,
            )}
            title={spec.title}
            amount={spec.amount}
            events={screen === "events"}
          />
          {detail && screen === "orders" && (
            <>
              <Panel title="Thông tin đơn (không PII)">
                <p>
                  Shop: {text(rows[0].shop)} · Vùng: {text(rows[0].ship_state)}{" "}
                  / {text(rows[0].ship_country)}
                </p>
                <p>
                  Hạn ship Amazon: {text(rows[0].latest_ship_date)} · AFN = FBA,
                  MFN = FBM.
                </p>
              </Panel>
              <DataTable
                rows={childRows}
                columns={screens.items.columns}
                title="Dòng hàng của đơn"
              />
            </>
          )}
          {detail && screen === "settlements" && (
            <>
              <DataTable
                rows={breakdownRows(rows[0].breakdown).map((r) => ({
                  ...r,
                  currency: rows[0].currency,
                }))}
                columns={[
                  { key: "label", label: "Nhóm phí / dòng tiền" },
                  { key: "amount", label: "Giá trị", money: "currency" },
                ]}
                title="Breakdown do worker ghi"
              />
              <DataTable
                rows={childRows}
                columns={screens.events.columns}
                title="Dòng tiền thuộc kỳ này"
                amount="amount"
                events
              />
            </>
          )}
          <Panel title="Phạm vi bản đọc">
            <p>
              {finance
                ? "Chưa tính lợi nhuận, TACOS, reserve hay bồi hoàn khi chưa có đủ nguồn. Đối soát chỉ xác nhận khi worker có reconciled_at; NULL chênh lệch một mình không chứng minh đã khớp."
                : "Không xác nhận ship, refund hay đọc thông tin người mua. Hạn FBM thiếu dữ liệu Amazon được gắn ƯỚC LƯỢNG (+24h giả định); không dùng làm SLA chính thức. Đếm ngược tính tại lúc tải, tải lại để cập nhật. Chưa suy tỷ lệ returns khi không có mẫu số cùng kỳ."}
            </p>
          </Panel>
        </>
      )}
    </>
  );
}
