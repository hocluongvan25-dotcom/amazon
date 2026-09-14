"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Chip, tableCls } from "@/components/ui";
import { createClient } from "@/lib/supabase/client";
import {
  connectStatusOf,
  friendlyShopName,
  groupBySeller,
  MARKETPLACE_META,
  marketplaceLabel,
  type ConnectShopRow,
} from "@/lib/data/oauth-shared";

type Props = {
  shops: ConnectShopRow[];
};

/**
 * Tiêu đề card nhóm seller. Trước đây lấy displayName.split("·")[0] → với tên
 * kỹ thuật "P1 · US" ra "P1 · Seller P1" (mã thô, khó hiểu). Nay:
 *   - 1 shop  → tên thân thiện của shop đó
 *   - nhiều shop → phần tên chung (bỏ hậu tố nước) hoặc tên shop đầu tiên
 */
function groupTitle(g: { sellerId: string | null; shops: ConnectShopRow[] }): string {
  const names = g.shops.map((s) => friendlyShopName(s));
  if (names.length === 1) return names[0];
  // Tìm tiền tố chung có nghĩa (vd "Cửa hàng ABC US" + "Cửa hàng ABC CA" → "Cửa"…lấy prefix chung)
  const first = names[0].split(/[\s·-]+/)[0];
  if (first.length >= 3 && names.every((n) => n.startsWith(first))) return first;
  return names[0];
}

function ConfirmModal({
  shop,
  onClose,
  onConfirm,
}: {
  shop: ConnectShopRow | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  if (!shop) return null;
  const st = connectStatusOf(shop);
  const mp = marketplaceLabel(shop.marketplaceId);
  const isOverwrite = shop.hasToken;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-[480px] rounded-[14px] border border-line bg-card p-5 shadow-xl">
        <div className="text-[16px] font-extrabold">Xác nhận kết nối gian hàng</div>
        <div className="mt-3 rounded-[10px] border border-amber-soft bg-amber-soft/40 p-3 text-[13px] leading-snug">
          <div className="font-bold">
            {mp.flag} {friendlyShopName(shop)} · {mp.code} ({mp.name})
          </div>
          <div className="mt-1 text-soft">
            Seller ID: <span className="font-mono text-[12px]">{shop.sellerId ?? "—"}</span> · Marketplace ID:{" "}
            <span className="font-mono text-[12px]">{shop.marketplaceId}</span>
          </div>
          <div className="mt-1">
            Trạng thái hiện tại: <Chip tone={st.tone}>{st.label}</Chip>
          </div>
          {isOverwrite ? (
            <div className="mt-2 font-bold text-[#8a5602]">
              ⚠️ Gian hàng này ĐÃ có token. Kết nối lại sẽ GHI ĐÈ refresh token cũ trong DB. Nếu bấm nhầm
              sang shop khác, dữ liệu đồng bộ sẽ lưu sai shop/thị trường.
            </div>
          ) : (
            <div className="mt-2 text-soft">Shop chưa có token — kết nối sẽ tạo mới.</div>
          )}
        </div>

        <div className="mt-4 text-[12.5px] text-soft">
          Kiểm tra kỹ: bạn đang authorize cho đúng Seller Central account (đúng email chủ shop) và đúng
          marketplace {mp.code}. Sai shop = ghi đè token sai gian hàng.
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-[8px] border border-line px-4 py-2 text-[13px] font-bold hover:bg-[#f6f7f9]"
          >
            Hủy
          </button>
          <button
            onClick={onConfirm}
            className={`rounded-[8px] px-4 py-2 text-[13px] font-extrabold text-white ${
              isOverwrite ? "bg-amber hover:opacity-90" : "bg-accent hover:opacity-90"
            }`}
          >
            {isOverwrite ? "Ghi đè & Kết nối lại" : "Kết nối"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Modal đổi tên shop — gọi RPC vexim_rename_shop (phân quyền + audit ở DB, migration 0027). */
function RenameModal({
  shop,
  onClose,
  onRenamed,
}: {
  shop: ConnectShopRow | null;
  onClose: () => void;
  onRenamed: () => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!shop) return null;
  const mp = marketplaceLabel(shop.marketplaceId);

  const submit = async () => {
    const supabase = createClient();
    if (!supabase) {
      setError("Chưa cấu hình Supabase (chế độ demo) — không đổi tên được.");
      return;
    }
    setBusy(true);
    setError(null);
    const { data, error: rpcError } = await supabase.rpc("vexim_rename_shop", {
      p_seller: shop.sellerAccountId,
      p_name: name.trim(),
    });
    setBusy(false);
    if (rpcError) {
      // Lỗi từ RPC đã là tiếng Việt ([M0] …); PGRST202 = chưa chạy migration 0027
      setError(
        rpcError.code === "PGRST202"
          ? "Chức năng đổi tên chưa được bật trên database (cần chạy migration 0027)."
          : rpcError.message.replace(/^\[M0\]\s*/, ""),
      );
      return;
    }
    const row = (Array.isArray(data) ? data[0] : data) as { message?: string } | undefined;
    void row;
    onRenamed();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-[440px] rounded-[14px] border border-line bg-card p-5 shadow-xl">
        <div className="text-[16px] font-extrabold">Đổi tên gian hàng</div>
        <div className="mt-2 text-[13px] text-soft">
          {mp.flag} Tên hiện tại: <b>{friendlyShopName(shop)}</b> · {mp.code} ({mp.name})
        </div>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && name.trim().length >= 2 && !busy) void submit();
          }}
          placeholder='Ví dụ: "Cửa hàng ABC - US"'
          className="mt-3 w-full rounded-[9px] border border-line px-3 py-2 text-[13.5px]"
          maxLength={80}
        />
        <div className="mt-1 text-[11.5px] text-soft">
          2–80 ký tự, nên kèm thị trường (US/CA…) để phân biệt. Mọi lần đổi tên đều được ghi nhật ký.
        </div>
        {error ? <div className="mt-2 text-[12.5px] font-bold text-[#8c1d1d]">{error}</div> : null}
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="rounded-[8px] border border-line px-4 py-2 text-[13px] font-bold hover:bg-[#f6f7f9]"
          >
            Hủy
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy || name.trim().length < 2}
            className="rounded-[8px] bg-accent px-4 py-2 text-[13px] font-extrabold text-white hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Đang lưu…" : "Lưu tên mới"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Nút "+ Thêm shop / thị trường" (yêu cầu vận hành 09/2026): kết nối shop
 * thứ 2 hay mở thị trường mới thì TỰ THÊM khi cần — không seed sẵn hàng loạt
 * dòng "chưa kết nối" gây rối. Chọn marketplace (+ tên tuỳ chọn) → RPC
 * vexim_add_shop (0030, chỉ admin) tạo dòng production chờ kết nối → bấm
 * Kết nối để authorize; seller_id + tên thật từ Amazon tự điền sau OAuth.
 */
function AddShopModal({
  open,
  existingMarketplaces,
  onClose,
  onAdded,
}: {
  open: boolean;
  /** marketplace đã có shop production — để gợi ý, không cấm (seller khác vẫn thêm được sau khi kết nối) */
  existingMarketplaces: Set<string>;
  onClose: () => void;
  onAdded: (message: string) => void;
}) {
  const [marketplaceId, setMarketplaceId] = useState("ATVPDKIKX0DER");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const submit = async () => {
    const supabase = createClient();
    if (!supabase) {
      setError("Chưa cấu hình Supabase (chế độ demo) — không thêm shop được.");
      return;
    }
    setBusy(true);
    setError(null);
    const { data, error: rpcError } = await supabase.rpc("vexim_add_shop", {
      p_marketplace: marketplaceId,
      p_name: name.trim() === "" ? null : name.trim(),
    });
    setBusy(false);
    if (rpcError) {
      setError(
        rpcError.code === "PGRST202"
          ? "Chức năng thêm shop chưa được bật trên database (cần chạy migration 0030)."
          : rpcError.message.replace(/^\[M0\]\s*/, ""),
      );
      return;
    }
    const row = (Array.isArray(data) ? data[0] : data) as { message?: string } | undefined;
    setName("");
    onAdded(row?.message ?? "Đã thêm shop — bấm Kết nối để authorize với Amazon.");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-[460px] rounded-[14px] border border-line bg-card p-5 shadow-xl">
        <div className="text-[16px] font-extrabold">Thêm shop / thị trường</div>
        <div className="mt-2 text-[12.5px] leading-snug text-soft">
          Tạo một gian hàng mới để kết nối với Amazon. Sau khi bấm <b>Kết nối</b> và authorize xong,
          Seller ID và tên cửa hàng thật sẽ được tự động lấy về từ Amazon.
        </div>

        <label className="mt-3 block text-[12px] font-bold text-soft">
          Thị trường (marketplace)
          <select
            value={marketplaceId}
            onChange={(e) => setMarketplaceId(e.target.value)}
            className="mt-1 w-full rounded-[9px] border border-line px-3 py-2 text-[13.5px]"
          >
            {Object.entries(MARKETPLACE_META).map(([id, m]) => (
              <option key={id} value={id}>
                {m.flag} {m.code} · {m.name}
                {existingMarketplaces.has(id) ? " — đã có shop ở thị trường này" : ""}
              </option>
            ))}
          </select>
        </label>

        <label className="mt-3 block text-[12px] font-bold text-soft">
          Tên gian hàng (tuỳ chọn)
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !busy) void submit();
            }}
            placeholder='Để trống → tự đặt "Shop US", kết nối xong lấy tên thật từ Amazon'
            className="mt-1 w-full rounded-[9px] border border-line px-3 py-2 text-[13.5px]"
            maxLength={80}
          />
        </label>

        {error ? <div className="mt-2 text-[12.5px] font-bold text-[#8c1d1d]">{error}</div> : null}

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="rounded-[8px] border border-line px-4 py-2 text-[13px] font-bold hover:bg-[#f6f7f9]"
          >
            Hủy
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy}
            className="rounded-[8px] bg-accent px-4 py-2 text-[13px] font-extrabold text-white hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Đang thêm…" : "Thêm shop"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ShopRow({
  s,
  onConnect,
  onRename,
}: {
  s: ConnectShopRow;
  onConnect: (s: ConnectShopRow) => void;
  onRename: (s: ConnectShopRow) => void;
}) {
  const st = connectStatusOf(s);
  const mp = marketplaceLabel(s.marketplaceId);
  const label = s.hasToken ? "Kết nối lại" : "Kết nối";

  return (
    <tr>
      <td className={`${tableCls.td}`}>
        <div className="flex items-center gap-2">
          <span className="text-[16px]">{mp.flag}</span>
          <div>
            <div className="flex items-center gap-1.5 font-bold">
              {friendlyShopName(s)}
              <button
                onClick={() => onRename(s)}
                title="Đổi tên gian hàng"
                className="rounded px-1 text-[12px] text-soft opacity-60 hover:bg-[#eef1f5] hover:opacity-100"
              >
                ✏️
              </button>
            </div>
            <div className="text-[11px] text-soft">
              {mp.code} · {mp.name}
            </div>
          </div>
        </div>
      </td>
      <td className={tableCls.td}>
        <Chip tone={st.tone}>{st.label}</Chip>
        <div className="mt-1 text-[11.5px] text-soft">{st.hint}</div>
      </td>
      <td className={`${tableCls.td} text-right tabular-nums`}>
        {s.daysLeft === null ? "—" : `${s.daysLeft} ngày`}
      </td>
      <td className={tableCls.td}>
        {s.authorizedAt ? s.authorizedAt.slice(0, 10) : "chưa từng"}
        {s.refreshCount && s.refreshCount > 1 ? (
          <span className="text-soft"> · lần {s.refreshCount}</span>
        ) : null}
      </td>
      <td className={`${tableCls.td} text-right tabular-nums`}>{s.adsProfiles > 0 ? s.adsProfiles : "—"}</td>
      <td className={`${tableCls.td} text-right`}>
        <button
          onClick={() => onConnect(s)}
          className="inline-flex items-center rounded-[8px] bg-accent px-3 py-1.5 text-[12.5px] font-extrabold text-white hover:opacity-90"
        >
          {label}
        </button>
      </td>
    </tr>
  );
}

export function ShopConnectTable({ shops }: Props) {
  const router = useRouter();
  const [confirmShop, setConfirmShop] = useState<ConnectShopRow | null>(null);
  const [renameShop, setRenameShop] = useState<ConnectShopRow | null>(null);
  const [showMock, setShowMock] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addedMessage, setAddedMessage] = useState<string | null>(null);

  // Tách production vs mock để tránh rối mắt
  const prodShops = shops.filter((s) => (s.dataSource ?? "mock") !== "mock");
  const mockShops = shops.filter((s) => (s.dataSource ?? "mock") === "mock");

  const prodGroups = groupBySeller(prodShops);
  const mockGroups = groupBySeller(mockShops);

  const needing = shops.filter((s) => s.hasToken && (s.needsReauth || s.isExpired)).length;
  const notConnected = shops.filter((s) => !s.hasToken).length;

  const handleConfirm = () => {
    if (!confirmShop) return;
    window.location.href = `/api/oauth/amazon/start?seller=${encodeURIComponent(
      confirmShop.sellerAccountId,
    )}&confirm=1`;
  };

  if (shops.length === 0) {
    return (
      <>
        <div className="rounded-[10px] border border-dashed border-line px-3 py-6 text-center text-[13px] text-soft">
          Chưa có gian hàng nào trong hệ thống.
          <div className="mt-3">
            <button
              onClick={() => setAddOpen(true)}
              className="rounded-[9px] bg-accent px-4 py-2 text-[13px] font-extrabold text-white hover:opacity-90"
            >
              + Thêm shop / thị trường
            </button>
          </div>
          <div className="mt-2 text-[11.5px]">
            (Cần quyền quản trị viên. Nhân viên thường: nhờ Admin gán shop ở màn Người dùng &amp; phân quyền.)
          </div>
        </div>
        <AddShopModal
          open={addOpen}
          existingMarketplaces={new Set<string>()}
          onClose={() => setAddOpen(false)}
          onAdded={(message) => {
            setAddOpen(false);
            setAddedMessage(message);
            router.refresh();
          }}
        />
        {addedMessage ? (
          <div className="mt-3 rounded-[10px] border border-line bg-green-soft px-3 py-2.5 text-[12.5px] font-bold text-[#0b7a55]">
            ✓ {addedMessage}
          </div>
        ) : null}
      </>
    );
  }

  return (
    <>
      <div className="mb-3 flex flex-wrap gap-2 text-[12px]">
        <span className="rounded-full bg-green-soft px-2.5 py-1 font-bold text-[#0b7a55]">
          {prodShops.filter((s) => s.hasToken && !s.needsReauth && !s.isExpired).length} đang hoạt động
        </span>
        {needing > 0 ? (
          <span className="rounded-full bg-amber-soft px-2.5 py-1 font-bold text-[#8a5602]">
            {needing} sắp hết hạn
          </span>
        ) : null}
        {notConnected > 0 ? (
          <span className="rounded-full bg-[#eef1f5] px-2.5 py-1 font-bold text-muted">
            {notConnected} chưa kết nối
          </span>
        ) : null}
        <span className="rounded-full bg-[#eef1f5] px-2.5 py-1 text-soft">
          {prodGroups.length} seller · {prodShops.length} marketplace
        </span>
        <button
          onClick={() => setAddOpen(true)}
          className="ml-auto rounded-[9px] bg-accent px-3.5 py-1.5 text-[12.5px] font-extrabold text-white hover:opacity-90"
        >
          + Thêm shop / thị trường
        </button>
      </div>

      {addedMessage ? (
        <div className="mb-3 rounded-[10px] border border-line bg-green-soft px-3 py-2.5 text-[12.5px] font-bold text-[#0b7a55]">
          ✓ {addedMessage}
        </div>
      ) : null}

      {/* Production shops - grouped by seller */}
      {prodGroups.map((g) => (
        <div key={g.sellerKey} className="mb-4 rounded-[12px] border border-line bg-white">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <div>
              <div className="text-[14px] font-extrabold">
                {groupTitle(g)}
                {g.sellerId ? (
                  <>
                    {" "}· Seller <span className="font-mono text-[12px]">{g.sellerId}</span>
                  </>
                ) : null}
              </div>
              <div className="text-[11.5px] text-soft">
                {g.shops.length} marketplace: {g.shops.map((s) => marketplaceLabel(s.marketplaceId).code).join(", ")} ·{" "}
                {g.shops.map((s) => marketplaceLabel(s.marketplaceId).flag).join(" ")}
              </div>
            </div>
            <Chip tone="blue">{g.sellerId ? "Production" : "Custom"}</Chip>
          </div>

          <table className={tableCls.table}>
            <thead>
              <tr>
                <th className={tableCls.th}>Gian hàng · Marketplace</th>
                <th className={tableCls.th}>Trạng thái token</th>
                <th className={`${tableCls.th} text-right`}>Còn lại</th>
                <th className={tableCls.th}>Authorize lần cuối</th>
                <th className={tableCls.th}>Ads</th>
                <th className={tableCls.th} />
              </tr>
            </thead>
            <tbody>
              {g.shops.map((s) => (
                <ShopRow key={s.sellerAccountId} s={s} onConnect={setConfirmShop} onRename={setRenameShop} />
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {/* Mock / demo shops - collapsed by default to avoid clutter */}
      {mockShops.length > 0 ? (
        <div className="mt-6">
          <button
            onClick={() => setShowMock(!showMock)}
            className="mb-2 text-[12.5px] font-bold text-soft hover:text-ink"
          >
            {showMock ? "▼" : "▶"} {mockShops.length} gian hàng demo — bấm để {showMock ? "ẩn" : "hiện"}
          </button>

          {showMock ? (
            <div className="rounded-[12px] border border-dashed border-amber-soft bg-amber-soft/20 p-2">
              <div className="mb-2 px-2 text-[11.5px] font-bold text-[#8a5602]">
                ⚠️ Đây là shop mock/demo (data_source=mock) — không dùng trong vận hành thật. Đã ẩn mặc định để
                tránh rối mắt và bấm nhầm. Nếu cần test, hãy đổi data_source sang production và đặt tên thân
                thiện.
              </div>
              {mockGroups.map((g) => (
                <div key={g.sellerKey} className="mb-3 rounded-[10px] border border-line bg-white">
                  <div className="px-3 py-2 text-[12px] font-bold">
                    {g.sellerKey} · {g.shops.length} marketplace (mock)
                  </div>
                  <table className={tableCls.table}>
                    <tbody>
                      {g.shops.map((s) => (
                        <ShopRow key={s.sellerAccountId} s={s} onConnect={setConfirmShop} onRename={setRenameShop} />
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <ConfirmModal shop={confirmShop} onClose={() => setConfirmShop(null)} onConfirm={handleConfirm} />

      <AddShopModal
        open={addOpen}
        existingMarketplaces={new Set(prodShops.map((s) => s.marketplaceId))}
        onClose={() => setAddOpen(false)}
        onAdded={(message) => {
          setAddOpen(false);
          setAddedMessage(message);
          router.refresh();
        }}
      />

      <RenameModal
        shop={renameShop}
        onClose={() => setRenameShop(null)}
        onRenamed={() => {
          setRenameShop(null);
          router.refresh();
        }}
      />

      <div className="mt-4 rounded-[10px] border border-line bg-[#f8f9fb] px-3 py-2.5 text-[12px] text-soft">
        💡 Trước khi kết nối, hệ thống luôn hiển thị bước xác nhận với đầy đủ Seller ID và Marketplace — kiểm tra kỹ
        thông tin để tránh kết nối nhầm gian hàng.
      </div>
    </>
  );
}
