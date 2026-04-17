/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Next.js 14 App Router is default. Keep output small and avoid SSR for document data
  // (data fetching happens on the client so we can coordinate with WebSocket state).
  experimental: {
    // no experimental flags needed for the MVP
  },
  images: {
    // demo image server (mock presign) — allow any remote host so local uploads can be viewed
    remotePatterns: [{ protocol: "http", hostname: "**" }, { protocol: "https", hostname: "**" }],
  },
};

export default nextConfig;
