"use client";

/**
 * Bảng gian hàng Amazon + 3 hành động của màn Kết nối shop (SOP-11):
 *   • [Kết nối]/[Kết nối lại] — OAuth LWA (modal xác nhận chống ghi đè)
 *   • [⤓ Đồng bộ tên shop Amazon] — lấy storeName từ Sellers API v1
 *   • [+ Thêm shop mới] và [Xoá] — quản lý danh sách shop (migration 0032)
 *
 * DỌN GIAO DIỆN 16/09/2026: bỏ mọi khối chữ hướng dẫn MD1000/MD9100 và SQL thủ
 * công (đã tự động hoá bằng migration 0024/0032), shop demo (data_source='mock')
 * không còn hiện ở màn này.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Chip, tableCls } from "@/components/ui";
import {
  connectStatusOf,
  groupBySeller,
  marketplaceLabel,
  type ConnectShopRow,
} from "@/lib/data/oauth-shared";
import { SHOP_MARKETPLACES, validateNewShop, type NewShopValidation } from "@/lib/data/shop-admin-model";
import { createShopAction, deleteShopAction, syncStoreNamesAction } from "./actions";

type Props = {
  shops: ConnectShopRow[];
};

/* -------------------------------------------------------------------------- */
/* Modal xác nhận kết nối (chống ghi đè token)                                 */
/* -------------------------------------------------------------------------- */
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
            Seller ID: <span className="font-mono text-[12px]">{shop.sellerId ?? "— (tự điền khi authorize)"}</span> ·
            Marketplace ID: <span className="font-mono text-[12px]">{shop.marketplaceId}</span>
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

/* -------------------------------------------------------------------------- */
/* Modal THÊM SHOP MỚI                                                         */
/* -------------------------------------------------------------------------- */
export function AddShopModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [displayName, setDisplayName] = useState("");
  const [marketplace, setMarketplace] = useState(SHOP_MARKETPLACES[0]?.id ?? "ATVPDKIKX0DER");
  const [sellerId, setSellerId] = useState("");
  const [errors, setErrors] = useState<NewShopValidation["errors"]>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  if (!open) return null;

  const submit = async () => {
    // Kiểm tra ngay ở client bằng CÙNG luật với server (shop-admin-model)
    const valid = validateNewShop({ displayName, marketplace, sellerId });
    setErrors(valid.errors);
    if (!valid.ok) return;

    setBusy(true);
    setResult(null);
    try {
      const res = await createShopAction({
        displayName: valid.value.displayName,
        marketplace: valid.value.marketplace,
        sellerId: valid.value.sellerId,
      });
      setResult({ ok: res.ok, text: res.message });
      if (res.ok) {
        setDisplayName("");
        setSellerId("");
        setErrors({});
        router.refresh();
      } else {
        setErrors(res.fieldErrors);
      }
    } catch (e) {
      setResult({ ok: false, text: `Thêm shop lỗi: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-[520px] rounded-[14px] border border-line bg-card p-5 shadow-xl">
        <div className="text-[16px] font-extrabold">Thêm shop mới</div>
        <div className="mt-1 text-[12.5px] text-soft">
          Khai shop trước, rồi bấm [Kết nối] để shop authorize trên Seller Central. Hệ thống tự nhận
          Seller ID và tên shop Amazon sau khi authorize.
        </div>

        <div className="mt-4 flex flex-col gap-3 text-[13px]">
          <label className="flex flex-col gap-1">
            <span className="font-bold">Tên gọi nội bộ *</span>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="VD: VEXIM US - Chính · Shop khách A - US"
              className="rounded-[8px] border border-line px-3 py-2"
              maxLength={120}
            />
            {errors.displayName ? <span className="text-[11.5px] text-[#8c1d1d]">{errors.displayName}</span> : null}
          </label>

          <label className="flex flex-col gap-1">
            <span className="font-bold">Marketplace *</span>
            <select
              value={marketplace}
              onChange={(e) => setMarketplace(e.target.value)}
              className="rounded-[8px] border border-line px-3 py-2"
            >
              {SHOP_MARKETPLACES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.flag} {m.code} · {m.name} ({m.id})
                </option>
              ))}
            </select>
            {errors.marketplace ? <span className="text-[11.5px] text-[#8c1d1d]">{errors.marketplace}</span> : null}
          </label>

          <label className="flex flex-col gap-1">
            <span className="font-bold">
              Seller ID <span className="font-normal text-soft">(để trống nếu chưa biết)</span>
            </span>
            <input
              value={sellerId}
              onChange={(e) => setSellerId(e.target.value)}
              placeholder="VD: AQMVYI4HJTI4C"
              className="rounded-[8px] border border-line px-3 py-2 font-mono"
              maxLength={32}
            />
            {errors.sellerId ? <span className="text-[11.5px] text-[#8c1d1d]">{errors.sellerId}</span> : null}
          </label>
        </div>

        {result ? (
          <div
            className={`mt-3 rounded-[10px] border px-3 py-2 text-[12.5px] ${
              result.ok
                ? "border-[#c9e9d5] bg-[#f2fbf5] text-[#17683a]"
                : "border-[#f2c9c9] bg-[#fdf3f3] text-[#8c1d1d]"
            }`}
          >
            {result.text}
          </div>
        ) : null}

        <div className="mt-4 rounded-[10px] border border-line bg-[#f8f9fb] px-3 py-2 text-[11.5px] text-soft">
          Shop mới ở trạng thái <b>chưa kết nối</b> — worker không đồng bộ cho tới khi có token và được bật
          đồng bộ (SOP-11 bước 3).
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-[8px] border border-line px-4 py-2 text-[13px] font-bold hover:bg-[#f6f7f9]"
          >
            Đóng
          </button>
          <button
            onClick={submit}
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

/* -------------------------------------------------------------------------- */
/* Modal XOÁ SHOP (2 bước: đếm dữ liệu → xác nhận)                             */
/* -------------------------------------------------------------------------- */
export function DeleteShopModal({
  shop,
  onClose,
}: {
  shop: ConnectShopRow | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<"ask" | "deps" | "done">("ask");
  const [dependencies, setDependencies] = useState("");
  const [message, setMessage] = useState("");

  if (!shop) return null;

  const run = async (confirm: boolean) => {
    setBusy(true);
    try {
      const res = await deleteShopAction({ sellerAccountId: shop.sellerAccountId, confirm });
      setMessage(res.message);
      if (res.deleted) {
        setStep("done");
        router.refresh();
      } else if (res.requiresConfirm) {
        setDependencies(res.dependenciesText);
        setStep("deps");
      } else {
        setStep("done");
      }
    } catch (e) {
      setMessage(`Xoá shop lỗi: ${e instanceof Error ? e.message : String(e)}`);
      setStep("done");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-[520px] rounded-[14px] border border-line bg-card p-5 shadow-xl">
        <div className="text-[16px] font-extrabold">Xoá shop khỏi hệ thống</div>

        {step !== "done" ? (
          <div className="mt-3 rounded-[10px] border border-[#f2c9c9] bg-[#fdf3f3] p-3 text-[13px] leading-snug text-[#8c1d1d]">
            <div className="font-bold">
              {marketplaceLabel(shop.marketplaceId).flag} {shop.displayName} ·{" "}
              {marketplaceLabel(shop.marketplaceId).code}
            </div>
            <div className="mt-1">
              Seller ID: <span className="font-mono text-[12px]">{shop.sellerId ?? "—"}</span> · Token:{" "}
              {shop.hasToken ? "đã kết nối" : "chưa kết nối"}
            </div>
            <div className="mt-2">
              Xoá shop sẽ xoá theo <b>refresh token</b> và <b>toàn bộ dữ liệu đã đồng bộ</b> của shop
              (listing, đơn hàng, tồn kho, cảnh báo…). Không khôi phục được.
            </div>
          </div>
        ) : null}

        {step === "deps" ? (
          <div className="mt-3 rounded-[10px] border border-[#f2e2c9] bg-[#fdfaf3] p-3 text-[12.5px] text-[#7a5a12]">
            <div className="font-bold">Shop còn dữ liệu/kết nối — kiểm tra trước khi xoá:</div>
            <div className="mt-1">{dependencies || "Không có dữ liệu đã đồng bộ."}</div>
            <div className="mt-1">{message}</div>
          </div>
        ) : null}

        {step === "done" ? (
          <div className="mt-3 rounded-[10px] border border-line bg-[#f8f9fb] px-3 py-2.5 text-[12.5px]">
            {message}
            {shop.hasToken && step === "done" ? null : null}
          </div>
        ) : null}

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-[8px] border border-line px-4 py-2 text-[13px] font-bold hover:bg-[#f6f7f9]"
          >
            {step === "done" ? "Đóng" : "Hủy"}
          </button>
          {step === "ask" ? (
            <button
              onClick={() => run(false)}
              disabled={busy}
              className="rounded-[8px] bg-[#8c1d1d] px-4 py-2 text-[13px] font-extrabold text-white hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "Đang kiểm tra…" : "Xoá shop"}
            </button>
          ) : null}
          {step === "deps" ? (
            <button
              onClick={() => run(true)}
              disabled={busy}
              className="rounded-[8px] bg-[#8c1d1d] px-4 py-2 text-[13px] font-extrabold text-white hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "Đang xoá…" : "Xác nhận xoá hẳn"}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Một dòng shop                                                               */
/* -------------------------------------------------------------------------- */
function ShopRow({
  s,
  onConnect,
  onSyncName,
  onDelete,
  syncing,
}: {
  s: ConnectShopRow;
  onConnect: (s: ConnectShopRow) => void;
  onSyncName: (s: ConnectShopRow) => void;
  onDelete: (s: ConnectShopRow) => void;
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
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={() => onConnect(s)}
            className="inline-flex items-center rounded-[8px] bg-accent px-3 py-1.5 text-[12.5px] font-extrabold text-white hover:opacity-90"
          >
            {label}
          </button>
          <button
            onClick={() => onDelete(s)}
            className="rounded-[8px] border border-line px-2.5 py-1.5 text-[12px] font-bold text-soft hover:border-[#8c1d1d] hover:text-[#8c1d1d]"
            title="Xoá shop khỏi hệ thống (kèm token + dữ liệu đã đồng bộ)"
          >
            Xoá
          </button>
        </div>
      </td>
    </tr>
  );
}

/* -------------------------------------------------------------------------- */
/* Bảng chính                                                                  */
/* -------------------------------------------------------------------------- */
export function ShopConnectTable({ shops }: Props) {
  const router = useRouter();
  const [confirmShop, setConfirmShop] = useState<ConnectShopRow | null>(null);
  const [deleteShopTarget, setDeleteShopTarget] = useState<ConnectShopRow | null>(null);
  const [showAdd, setShowAdd] = useState(false);
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

  // Tách production vs mock: shop demo (data_source='mock') không thuộc vận hành
  // thật — hiện chỉ khi bấm mở, để bảng chính luôn gọn.
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
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setShowAdd(true)}
            className="rounded-[8px] bg-accent px-3 py-1.5 text-[12px] font-extrabold text-white hover:opacity-90"
            title="Khai shop mới trước khi authorize trên Seller Central"
          >
            + Thêm shop mới
          </button>
          <button
            onClick={() => handleSyncName()}
            disabled={syncingName || prodShops.length === 0}
            className="rounded-[8px] border border-accent px-3 py-1.5 text-[12px] font-extrabold text-accent hover:bg-accent hover:text-white disabled:opacity-50"
            title="Gọi Sellers API v1 (getMarketplaceParticipations) cho từng shop và lưu storeName vào DB"
          >
            {syncingName ? "Đang lấy tên shop…" : "⤓ Đồng bộ tên shop Amazon"}
          </button>
        </div>
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
              (bấm [Kết nối] nếu shop chưa authorize).
            </div>
          ) : null}
        </div>
      ) : null}

      {prodShops.length === 0 ? (
        <div className="mb-4 rounded-[10px] border border-dashed border-line px-3 py-6 text-center text-[13px] text-soft">
          Chưa có gian hàng nào. Bấm <b>[+ Thêm shop mới]</b> để khai shop, rồi bấm [Kết nối] để authorize trên
          Seller Central.
        </div>
      ) : null}

      {/* Shop thật — nhóm theo seller (một seller nhiều marketplace ⇒ 1 card) */}
      {prodGroups.map((g) => (
        <div key={g.sellerKey} className="mb-4 rounded-[12px] border border-line bg-white">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <div>
              <div className="text-[14px] font-extrabold">
                {g.shops[0]?.displayName.split("·")[0].trim() || g.sellerKey} ·{" "}
                {g.sellerId ? (
                  <>
                    Seller <span className="font-mono text-[12px]">{g.sellerId}</span>
                  </>
                ) : (
                  <span className="text-[12px] font-bold text-soft">Chưa có Seller ID (tự điền khi authorize)</span>
                )}
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
            <Chip tone={g.sellerId ? "blue" : "amber"}>{g.sellerId ? "Đã có Seller ID" : "Chưa authorize"}</Chip>
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
                  onDelete={setDeleteShopTarget}
                  syncing={syncingName}
                />
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {/* Shop demo (data_source='mock') — mặc định ẩn; chỉ hiện khi người dùng mở */}
      {mockShops.length > 0 ? (
        <div className="mt-6">
          <button
            onClick={() => setShowMock(!showMock)}
            className="mb-2 text-[12.5px] font-bold text-soft hover:text-ink"
          >
            {showMock ? "▼" : "▶"} {mockShops.length} gian hàng demo ({mockGroups.length} seller) — bấm để{" "}
            {showMock ? "ẩn" : "hiện"}
          </button>

          {showMock ? (
            <div className="rounded-[12px] border border-dashed border-amber-soft bg-amber-soft/20 p-2">
              <div className="mb-2 px-2 text-[11.5px] font-bold text-[#8a5602]">
                ⚠️ Shop demo (data_source=mock) — không dùng trong vận hành thật. Xoá bằng nút [Xoá] ở từng dòng.
              </div>
              {mockGroups.map((g) => (
                <div key={g.sellerKey} className="mb-3 rounded-[10px] border border-line bg-white">
                  <div className="px-3 py-2 text-[12px] font-bold">
                    {g.sellerKey} · {g.shops.length} marketplace (demo)
                  </div>
                  <table className={tableCls.table}>
                    <tbody>
                      {g.shops.map((s) => (
                        <ShopRow
                          key={s.sellerAccountId}
                          s={s}
                          onConnect={setConfirmShop}
                          onSyncName={handleSyncName}
                          onDelete={setDeleteShopTarget}
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
      <AddShopModal open={showAdd} onClose={() => setShowAdd(false)} />
      <DeleteShopModal shop={deleteShopTarget} onClose={() => setDeleteShopTarget(null)} />
    </>
  );
}
