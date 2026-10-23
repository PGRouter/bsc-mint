import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/snapshot": ["./data/bsc-indexer-seed.json.gz"],
    "/api/klines": ["./data/bsc-indexer-seed.json.gz"],
  },
  experimental: {
    optimizePackageImports: ["viem/chains"],
  },
};

export default nextConfig;
