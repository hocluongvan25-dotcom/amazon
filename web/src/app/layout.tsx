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
      <head>
        {/* Inter — đồng nhất Mac/Windows, hỗ trợ tiếng Việt */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap&subset=vietnamese"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
