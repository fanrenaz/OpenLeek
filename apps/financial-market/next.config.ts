import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  assetPrefix: "/contexts/financial",
  outputFileTracingRoot: process.env.OPENLEEK_OUTPUT_FILE_TRACING_ROOT,
  transpilePackages: ["@openleek/contracts", "@openleek/trpc"],
  serverExternalPackages: ["pg"],
};

export default nextConfig;
