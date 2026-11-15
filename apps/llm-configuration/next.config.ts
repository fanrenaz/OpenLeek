import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: process.env.OPENLEEK_OUTPUT_FILE_TRACING_ROOT,
  serverExternalPackages: ["pg"],
};

export default nextConfig;
