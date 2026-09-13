import type { Config } from "tailwindcss";

/**
 * Design tokens — đúng bảng màu wireframe đã được VEXIM duyệt
 * (xem /wireframes/index.html)
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
        green: "#0e9f6e",
        "green-soft": "#e6f7f0",
        red: "#e02424",
        "red-soft": "#fdeaea",
        amber: "#c27803",
        "amber-soft": "#fdf3e0",
        blue: "#2563eb",
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
