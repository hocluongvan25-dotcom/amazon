/**
 * Hệ vai trò & phạm vi — phản chiếu bảng iam.app_role + iam.departments
 * trong supabase/migrations/0001_init.sql.
 *
 * DEMO MODE dùng 4 persona (khớp wireframe đã duyệt) để kiểm chứng phân
 * quyền theo phòng. SUPABASE MODE sẽ map từ iam.role_assignments.
 */
export type PersonaKey = "ceo" | "lead_fulfill" | "op_ppc" | "client";

export type Persona = {
  key: PersonaKey;
  label: string;
  scope: string;
  org: string;
  shop: string;
  bell: number;
  avatar: string;
};

export const PERSONAS: Record<PersonaKey, Persona> = {
  ceo: {
    key: "ceo",
    label: "Ban điều hành VEXIM",
    scope: "Toàn quyền — thấy mọi phòng ban, mọi shop, mọi tác vụ.",
    org: "Khách hàng: Tất cả",
    shop: "Shop: Tất cả (14)",
    bell: 7,
    avatar: "NA",
  },
  lead_fulfill: {
    key: "lead_fulfill",
    label: "Trưởng phòng Kho vận & FBA",
    scope:
      "Chỉ thấy dashboard Kho vận & FBA của phòng mình. Không thấy Tài chính, PPC, CSKH của phòng khác.",
    org: "Khách hàng: 5 KH có kho FBA",
    shop: "Shop: 9 shop có FBA",
    bell: 2,
    avatar: "MT",
  },
  op_ppc: {
    key: "op_ppc",
    label: "Operator PPC — 5 shop được gán",
    scope:
      "Chỉ thấy dashboard Quảng cáo, chỉ 5 shop được gán (RBAC + RLS ở tầng database).",
    org: "Khách hàng: theo gán",
    shop: "Shop: 5 shop được gán",
    bell: 1,
    avatar: "TQ",
  },
  client: {
    key: "client",
    label: "Client Viewer — Doanh nghiệp A",
    scope:
      "Chỉ đọc · chỉ 2 shop của doanh nghiệp mình · không thấy thông tin nội bộ VEXIM.",
    org: "Khách hàng: Doanh nghiệp A",
    shop: "Shop: 2 shop của bạn",
    bell: 0,
    avatar: "DA",
  },
};

export type NavItem = {
  href: string;
  label: string;
  icon: string;
  personas: PersonaKey[];
};

/**
 * BADGE SỐ BÊN CẠNH MENU — CHỈ HIỆN KHI CÓ SỐ THẬT TỪ DB.
 *
 * Trước đây `NavItem.count` là số MOCK viết cứng (5 · 7 · 12 · 3…) nằm trong file
 * này ⇒ Ops nhìn thấy "12 việc cần xử lý" ở màn Giá rồi đi tìm 12 việc không có.
 * Từ nay badge lấy từ `readNavBadges()` (đếm thật bằng view/RPC, có RLS) truyền
 * xuống qua prop `badges`; chưa nối được query ⇒ **KHÔNG hiện gì** (thà trống còn
 * hơn số sai).
 */
export type NavBadges = Record<string, number>;

/** Badge chỉ có nghĩa khi > 0 và là số hữu hạn (null/NaN/0 ⇒ ẩn). */
export function badgeOf(badges: NavBadges | undefined, href: string): number | null {
  const n = badges?.[href];
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * Một mục menu có đang được chọn không.
 *
 * Cách cũ (`pathname.startsWith(href + "/")`) làm `/ppc` và `/ppc/search-terms`
 * CÙNG sáng khi đang ở `/ppc/search-terms` — hai dòng cam một lúc. Cách đúng:
 * so khớp theo BIÊN ĐOẠN (`/ppc` khớp `/ppc` và `/ppc/...`, không khớp `/ppcx`),
 * rồi chỉ chọn mục KHỚP DÀI NHẤT (xem `activeHrefFor`) — nghĩa là mục con thắng
 * mục cha, còn `/ppc/campaigns/C-1` (không có trong menu) vẫn làm sáng `/ppc`.
 */
export function isNavActive(pathname: string, href: string): boolean {
  if (!pathname || !href) return false;
  const clean = pathname.split("?")[0].split("#")[0];
  if (clean === href) return true;
  return clean.startsWith(href.endsWith("/") ? href : `${href}/`);
}

/**
 * Href của mục menu DUY NHẤT được sáng: mục khớp dài nhất.
 * `["/ppc", "/ppc/search-terms"]` + `/ppc/search-terms` ⇒ `/ppc/search-terms`.
 * `["/ppc", "/ppc/search-terms"]` + `/ppc/campaigns/C-DEMO-01` ⇒ `/ppc`.
 */
export function activeHrefFor(hrefs: string[], pathname: string): string | null {
  let best: string | null = null;
  for (const href of hrefs) {
    if (!isNavActive(pathname, href)) continue;
    if (best === null || href.length > best.length) best = href;
  }
  return best;
}

export const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: "Dashboard",
    items: [
      { href: "/dashboard", label: "Tổng quan", icon: "📊", personas: ["ceo"] },
    ],
  },
  {
    group: "Phòng ban",
    items: [
      { href: "/health", label: "Vận hành & Health", icon: "🛡️", personas: ["ceo"] },
      { href: "/listing", label: "Listing & Nội dung", icon: "🏷️", personas: ["ceo"] },
      { href: "/listing/editor", label: "Soạn listing (L3)", icon: "✍️", personas: ["ceo"] },
      { href: "/pricing", label: "Giá & Buy Box", icon: "💲", personas: ["ceo"] },
      { href: "/ppc", label: "Quảng cáo (PPC)", icon: "📈", personas: ["ceo", "op_ppc"] },
      { href: "/ppc/search-terms", label: "Search term & chặn (A3)", icon: "🚫", personas: ["ceo", "op_ppc"] },
      { href: "/ppc/approvals", label: "Duyệt thay đổi (P3)", icon: "✅", personas: ["ceo", "op_ppc"] },
      { href: "/fulfillment", label: "Kho vận & FBA", icon: "📦", personas: ["ceo", "lead_fulfill"] },
      { href: "/orders", label: "Đơn hàng & CSKH", icon: "💬", personas: ["ceo"] },
      { href: "/finance", label: "Tài chính & Đối soát", icon: "💰", personas: ["ceo"] },
      { href: "/finance/costs", label: "Giá vốn (F3/F4/P1)", icon: "🏷️", personas: ["ceo"] },
      { href: "/finance/claims", label: "Bồi hoàn FBA (F3)", icon: "🧾", personas: ["ceo"] },
      { href: "/finance/profit", label: "Lợi nhuận SKU (F4)", icon: "💹", personas: ["ceo"] },
      { href: "/research", label: "Thẩm định R&D (M8)", icon: "🔬", personas: ["ceo"] },
    ],
  },
  {
    group: "Khách hàng",
    items: [
      { href: "/client", label: "Client Viewer", icon: "🏢", personas: ["ceo", "client"] },
    ],
  },
  {
    group: "Hạ tầng vận hành",
    items: [
      { href: "/module0/connect", label: "Kết nối shop", icon: "🔌", personas: ["ceo"] },
      { href: "/module0/sync-health", label: "Sức khỏe đồng bộ", icon: "🩺", personas: ["ceo"] },
      { href: "/module0/api-usage", label: "Mức dùng API", icon: "🧮", personas: ["ceo"] },
      { href: "/module0/audit-log", label: "Nhật ký thao tác", icon: "🧾", personas: ["ceo"] },
      { href: "/module0/users", label: "Người dùng & quyền", icon: "👥", personas: ["ceo"] },
    ],
  },
  {
    group: "Tài khoản",
    items: [
      { href: "/profile", label: "Trang cá nhân", icon: "👤", personas: ["ceo", "lead_fulfill", "op_ppc", "client"] },
    ],
  },
];

export function navFor(persona: PersonaKey) {
  return NAV.map((g) => ({
    ...g,
    items: g.items.filter((it) => it.personas.includes(persona)),
  })).filter((g) => g.items.length > 0);
}
