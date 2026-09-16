import type { Config } from "tailwindcss";
import twColors from "tailwindcss/colors";

/**
 * Design tokens — đúng bảng màu wireframe đã được VEXIM duyệt
 * (xem /wireframes/index.html)
 *
 * LƯU Ý (sự cố 16/09/2026): khai báo màu dạng CHUỖI (vd `blue: "#2563eb"`)
 * sẽ XÓA TOÀN BỘ thang màu mặc định blue-50..blue-950 của Tailwind → mọi class
 * bg-blue-700/text-red-800/bg-amber-100... KHÔNG được sinh ra, nút thành "chữ
 * trắng nền trắng". Phải khai báo dạng OBJECT có DEFAULT để vừa giữ màu thương
 * hiệu cho class không hậu tố (bg-blue) vừa giữ đủ thang số (bg-blue-700...).
 */
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0f1720",
        muted: "#5b6472",
        soft: "#8a93a3",
        bg: "#f4f6f9",
        card: "#ffffff",
        line: "#e5e8ee",
        accent: "#ff9900",
        "accent-ink": "#b25f00",
        "accent-soft": "#fff4e5",
        green: { ...twColors.green, DEFAULT: "#0e9f6e" },
        "green-soft": "#e6f7f0",
        red: { ...twColors.red, DEFAULT: "#e02424" },
        "red-soft": "#fdeaea",
        amber: { ...twColors.amber, DEFAULT: "#c27803" },
        "amber-soft": "#fdf3e0",
        blue: { ...twColors.blue, DEFAULT: "#2563eb" },
        "blue-soft": "#eaf1ff",
      },
      fontFamily: {
        sans: [
          "var(--font-inter)",
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
      },
    },
  },
  plugins: [],
};

export default config;
