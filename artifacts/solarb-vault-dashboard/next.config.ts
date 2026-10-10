import type { NextConfig } from "next";

const replitDevDomain = process.env.REPLIT_DEV_DOMAIN
  ?.replace(/^https?:\/\//, "")
  .split("/")[0];

const nextConfig: NextConfig = {
  output: "export",
  devIndicators: false,
  images: {
    unoptimized: true,
  },
  allowedDevOrigins: [
    "*.replit.dev",
    "*.repl.co",
    "localhost",
    "127.0.0.1",
    ...(replitDevDomain ? [replitDevDomain] : []),
  ],
};

export default nextConfig;
