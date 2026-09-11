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
  count?: number;
  personas: PersonaKey[];
};

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
      { href: "/health", label: "Vận hành & Health", icon: "🛡️", count: 5, personas: ["ceo"] },
      { href: "/listing", label: "Listing & Nội dung", icon: "🏷️", count: 7, personas: ["ceo"] },
      { href: "/pricing", label: "Giá & Buy Box", icon: "💲", count: 12, personas: ["ceo"] },
      { href: "/ppc", label: "Quảng cáo (PPC)", icon: "📈", count: 3, personas: ["ceo", "op_ppc"] },
      { href: "/fulfillment", label: "Kho vận & FBA", icon: "📦", count: 5, personas: ["ceo", "lead_fulfill"] },
      { href: "/orders", label: "Đơn hàng & CSKH", icon: "💬", count: 4, personas: ["ceo"] },
      { href: "/finance", label: "Tài chính & Đối soát", icon: "💰", count: 6, personas: ["ceo"] },
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
      { href: "/module0/sync-health", label: "Sức khỏe đồng bộ", icon: "❤️‍🩹", personas: ["ceo"] },
      { href: "/module0/api-usage", label: "Mức dùng API", icon: "🧮", personas: ["ceo"] },
      { href: "/module0/audit-log", label: "Nhật ký thao tác", icon: "🧾", personas: ["ceo"] },
      { href: "/module0/users", label: "Người dùng & quyền", icon: "👥", personas: ["ceo"] },
    ],
  },
];

export function navFor(persona: PersonaKey) {
  return NAV.map((g) => ({
    ...g,
    items: g.items.filter((it) => it.personas.includes(persona)),
  })).filter((g) => g.items.length > 0);
}
