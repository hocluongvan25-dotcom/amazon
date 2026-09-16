"use client";

/**
 * Thanh tiến trình điều hướng toàn cục (kiểu nprogress, ~30 dòng, 0 dependency).
 *
 * VÌ SAO CẦN (phản hồi 17/09/2026): bấm link "← Về trang phân tích" hay các
 * link chuyển trang khác KHÔNG có hiệu ứng gì trong lúc Next.js tải route →
 * người dùng không biết nút có ăn hay không, bấm lặp. Thanh này hiện ngay khi
 * click link nội bộ và ẩn khi đường dẫn đã đổi.
 *
 * KHÔNG phủ các nút bấm tự gọi router.push (vd "Xem kết quả phân tích") — nút
 * đó có trạng thái 'Đang mở…' riêng ngay tại chỗ.
 */
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

export function NavProgress() {
  const [active, setActive] = useState(false);
  const pathname = usePathname();
  const startedAt = useRef(0);

  // Bắt click vào link nội bộ (capture để đón trước handler khác).
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // tab mới
      const el = e.target as HTMLElement | null;
      const a = el?.closest?.("a");
      if (!a) return;
      const href = a.getAttribute("href");
      if (!href || href.startsWith("#")) return;
      if (a.target === "_blank" || a.hasAttribute("download")) return;
      try {
        const url = new URL(href, window.location.origin);
        if (url.origin !== window.location.origin) return;
        if (
          url.pathname === window.location.pathname &&
          url.search === window.location.search
        ) {
          return; // cùng trang — không phải điều hướng
        }
      } catch {
        return;
      }
      startedAt.current = Date.now();
      setActive(true);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  // Đường dẫn đổi xong → giữ tối thiểu 300ms cho mượt rồi ẩn.
  useEffect(() => {
    if (!active) return;
    const wait = Math.max(0, 300 - (Date.now() - startedAt.current));
    const t = setTimeout(() => setActive(false), wait);
    return () => clearTimeout(t);
  }, [pathname, active]);

  // An toàn: điều hướng hỏng/thôi → không treo thanh mãi (tối đa 8s).
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => setActive(false), 8_000);
    return () => clearTimeout(t);
  }, [active]);

  if (!active) return null;
  return (
    <div aria-hidden className="fixed inset-x-0 top-0 z-[100] h-[3px] overflow-hidden">
      <div className="nav-progress-bar h-full w-1/3 rounded-full bg-accent" />
    </div>
  );
}
