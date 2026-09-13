import type { Metadata } from "next";
import ViLanding from "@/components/landing/ViLanding";

export const metadata: Metadata = {
  title: "VEXIM Ops — Nền tảng quản trị vận hành Amazon",
  description:
    "Nền tảng quản trị vận hành Amazon đa gian hàng, kết nối chính thức SP-API & Ads API. Dashboard theo phòng ban, cảnh báo thất thoát doanh thu, giữ Buy Box, tối ưu ACOS/TACOS.",
};

export default function LandingPage() {
  return <ViLanding />;
}
