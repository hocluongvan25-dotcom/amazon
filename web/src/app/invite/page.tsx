import type { Metadata } from "next";
import InviteClient from "./InviteClient";

export const metadata: Metadata = {
  title: "Đặt mật khẩu — Lời mời VEXIM Ops",
  description: "Đặt mật khẩu cho tài khoản được mời vào VEXIM Ops.",
};

export default function InvitePage() {
  return <InviteClient />;
}
