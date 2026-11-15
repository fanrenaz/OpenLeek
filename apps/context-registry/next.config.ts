import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  distDir: process.env.OPENLEEK_NEXT_DIST_DIR ?? ".next",
  output: "standalone",
  outputFileTracingRoot: process.env.OPENLEEK_OUTPUT_FILE_TRACING_ROOT,
  transpilePackages: ["@openleek/contracts", "@openleek/trpc"],
  serverExternalPackages: ["pg"],
};
export default nextConfig;
