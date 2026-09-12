/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Cho phép Next.js transpile worker/src (TypeScript, dùng ESM import bên ngoài web)
  transpilePackages: [],
  experimental: {
    externalDir: true,
  },
};

export default nextConfig;
