import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: process.env.OPENLEEK_OUTPUT_FILE_TRACING_ROOT,
  transpilePackages: ["@openleek/contracts", "@openleek/trpc"],
  async rewrites() {
    const financial = process.env.OPENLEEK_FINANCIAL_MARKET_URL ?? "http://financial-market:3000";
    const social = process.env.OPENLEEK_SOCIAL_ENVIRONMENT_URL ?? "http://social-environment:3000";
    return {
      beforeFiles: [
        { source: "/contexts/financial/runs/:path*", destination: `${financial}/observer/runs/:path*` },
        { source: "/contexts/financial/observer-api", destination: `${financial}/observer-api` },
        { source: "/contexts/financial/_next/:path*", destination: `${financial}/_next/:path*` },
        { source: "/contexts/social/runs/:path*", destination: `${social}/observer/runs/:path*` },
        { source: "/contexts/social/observer-api", destination: `${social}/observer-api` },
        { source: "/contexts/social/_next/:path*", destination: `${social}/_next/:path*` },
      ],
    };
  },
};

export default createNextIntlPlugin("./src/i18n/request.ts")(nextConfig);
