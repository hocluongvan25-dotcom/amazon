import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "VEXIM Ops — Quản trị vận hành Amazon",
  description:
    "Nền tảng quản trị vận hành sàn Amazon cho VEXIM: dashboard theo phòng ban, tồn kho, giá & Buy Box, quảng cáo, tài chính — kết nối SP-API chính thức của Amazon.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
