import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { socialEnvironmentRouter } from "../../../../server/router";

export const runtime = "nodejs";

function handler(request: Request) {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: request,
    router: socialEnvironmentRouter,
    createContext: () => ({}),
  });
}

export { handler as GET, handler as POST };
