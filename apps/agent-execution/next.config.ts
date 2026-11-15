import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: process.env.OPENLEEK_OUTPUT_FILE_TRACING_ROOT,
  transpilePackages: ["@openleek/contracts", "@openleek/trpc"],
  // ws relies on native Node module behavior (including its optional binary
  // helpers), so it must not be rewritten inside a Next server chunk.
  serverExternalPackages: ["pg", "ws"],
  // The public research runtime is Codex-only. `ws` remains explicitly traced
  // because the app-server client is loaded by the Node server at runtime.
  outputFileTracingIncludes: {
    "/*": [
      "../../node_modules/ws/**/*",
      "../../node_modules/zod/**/*",
    ],
  },
};

export default nextConfig;
