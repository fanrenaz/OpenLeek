import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { financialMarketRouter } from "../../../../server/router";

export const runtime = "nodejs";

function handler(request: Request) {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: request,
    router: financialMarketRouter,
    createContext: () => ({}),
  });
}

export { handler as GET, handler as POST };
