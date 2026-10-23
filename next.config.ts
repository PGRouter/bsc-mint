import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    optimizePackageImports: ["viem/chains"],
  },
};

export default nextConfig;
