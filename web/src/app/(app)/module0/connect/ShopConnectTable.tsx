"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Chip, tableCls } from "@/components/ui";
import {
  connectStatusOf,
  groupBySeller,
  marketplaceLabel,
  type ConnectShopRow,
} from "@/lib/data/oauth-shared";
import { syncStoreNamesAction } from "./actions";

type Props = {
  shops: ConnectShopRow[];
};

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
            {mp.flag} {shop.displayName} · {mp.code} ({mp.name})
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

function ShopRow({
  s,
  onConnect,
  onSyncName,
  syncing,
}: {
  s: ConnectShopRow;
  onConnect: (s: ConnectShopRow) => void;
  onSyncName: (s: ConnectShopRow) => void;
  syncing: boolean;
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
            <div className="font-bold">{s.displayName}</div>
            <div className="text-[11px] text-soft">
              {mp.code} · {mp.name} · <span className="font-mono">{s.marketplaceId.slice(0, 8)}…</span>
            </div>
            {/* TÊN SHOP TRÊN AMAZON — storeName của Sellers API v1 (KHÁC displayName ở trên) */}
            <div className="mt-0.5 text-[11.5px]">
              {s.storeName ? (
                <span className="text-soft">
                  🏪 Tên trên Amazon: <b className="text-ink">“{s.storeName}”</b>
                  {s.storeNameSyncedAt ? (
                    <span className="text-[10.5px] text-soft"> · cập nhật {s.storeNameSyncedAt.slice(0, 10)}</span>
                  ) : null}
                </span>
              ) : (
                <button
                  onClick={() => onSyncName(s)}
                  disabled={syncing || !s.hasToken}
                  className="rounded-[6px] border border-dashed border-line px-1.5 py-0.5 text-[11px] font-bold text-soft hover:border-accent hover:text-accent disabled:opacity-50"
                  title={
                    s.hasToken
                      ? "Gọi Sellers API (getMarketplaceParticipations) để lấy storeName"
                      : "Shop chưa authorize — chưa có refresh token để gọi API"
                  }
                >
                  ⤓ Chưa có tên Amazon — bấm để lấy
                </button>
              )}
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
  const [showMock, setShowMock] = useState(false);
  const [syncingName, setSyncingName] = useState(false);
  const [nameSync, setNameSync] = useState<{ ok: boolean; message: string } | null>(null);
  const [, startTransition] = useTransition();

  /**
   * Đồng bộ TÊN SHOP AMAZON (storeName) — chạy ở server (server action) vì cần
   * refresh token của shop (service_role). Không truyền sellerAccountId = quét
   * tất cả shop; truyền = chỉ shop đó.
   */
  const handleSyncName = (shop?: ConnectShopRow) => {
    if (syncingName) return;
    setSyncingName(true);
    setNameSync(null);
    startTransition(async () => {
      try {
        const res = await syncStoreNamesAction(
          shop ? { sellerAccountId: shop.sellerAccountId } : undefined,
        );
        setNameSync({ ok: res.ok, message: res.message });
        if (res.ok) router.refresh();
      } catch (e) {
        setNameSync({
          ok: false,
          message: `Đồng bộ tên shop lỗi: ${e instanceof Error ? e.message : String(e)}`,
        });
      } finally {
        setSyncingName(false);
      }
    });
  };

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
      <div className="rounded-[10px] border border-dashed border-line px-3 py-6 text-center text-[13px] text-soft">
        Bạn chưa được gán shop nào. Nhờ quản trị viên gán shop ở màn Người dùng & phân quyền.
      </div>
    );
  }

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-[12px]">
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
          onClick={() => handleSyncName()}
          disabled={syncingName}
          className="ml-auto rounded-[8px] border border-accent px-3 py-1 text-[12px] font-extrabold text-accent hover:bg-accent hover:text-white disabled:opacity-50"
          title="Gọi Sellers API v1 (getMarketplaceParticipations) cho từng shop và lưu storeName vào DB"
        >
          {syncingName ? "Đang lấy tên shop…" : "⤓ Đồng bộ tên shop Amazon"}
        </button>
      </div>

      {nameSync ? (
        <div
          className={`mb-3 rounded-[10px] border px-3 py-2.5 text-[12.5px] ${
            nameSync.ok
              ? "border-[#c9e9d5] bg-[#f2fbf5] text-[#17683a]"
              : "border-[#f2e2c9] bg-[#fdfaf3] text-[#7a5a12]"
          }`}
        >
          <b>Đồng bộ tên shop Amazon:</b> {nameSync.message}
          {!nameSync.ok ? (
            <div className="mt-1 text-[11.5px]">
              Tên shop lấy từ <code>getMarketplaceParticipations.storeName</code> — cần refresh token của shop
              (bấm [Kết nối] nếu shop chưa authorize). Gọi <code>/api/amazon/whoami</code> để xem chi tiết API.
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Production shops - grouped by seller */}
      {prodGroups.map((g) => (
        <div key={g.sellerKey} className="mb-4 rounded-[12px] border border-line bg-white">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <div>
              <div className="text-[14px] font-extrabold">
                {g.shops[0]?.displayName.split("·")[0].trim() || g.sellerKey} · Seller{" "}
                <span className="font-mono text-[12px]">{g.sellerId ?? g.sellerKey}</span>
              </div>
              <div className="text-[11.5px] text-soft">
                {g.shops.length} marketplace: {g.shops.map((s) => marketplaceLabel(s.marketplaceId).code).join(", ")} ·{" "}
                {g.shops.map((s) => marketplaceLabel(s.marketplaceId).flag).join(" ")}
              </div>
              <div className="mt-0.5 text-[11.5px] text-soft">
                🏪 Tên shop trên Amazon:{" "}
                {g.shops
                  .map((s) => `${marketplaceLabel(s.marketplaceId).code}=${s.storeName ? `“${s.storeName}”` : "chưa có"}`)
                  .join(" · ")}
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
                <ShopRow
                  key={s.sellerAccountId}
                  s={s}
                  onConnect={setConfirmShop}
                  onSyncName={handleSyncName}
                  syncing={syncingName}
                />
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
            {showMock ? "▼" : "▶"} {mockShops.length} gian hàng demo / chưa cấu hình ({mockGroups.length} seller) — bấm để{" "}
            {showMock ? "ẩn" : "hiện"} (tránh bấm nhầm ghi đè token production)
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
                        <ShopRow
                          key={s.sellerAccountId}
                          s={s}
                          onConnect={setConfirmShop}
                          onSyncName={handleSyncName}
                          syncing={syncingName}
                        />
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

      <div className="mt-4 rounded-[10px] border border-line bg-[#f8f9fb] px-3 py-2.5 text-[12px] text-soft">
        <b>Chống ghi đè:</b> Mỗi nút [Kết nối] giờ có xác nhận hiển thị rõ Seller ID, Marketplace ID, cờ quốc gia và
        cảnh báo ghi đè. Nhóm theo seller giúp P1·US + P2·CA (cùng seller AQMVYI4HJTI4C) nằm chung 1 card, không còn 8
        dòng rời rạc dễ bấm nhầm. Tên kỹ thuật A1/B1/P1 nên đổi trong DB thành tên thân thiện như &quot;VEXIM US
        Main&quot; / &quot;VEXIM CA&quot; qua màn quản trị hoặc SQL.
      </div>
    </>
  );
}
