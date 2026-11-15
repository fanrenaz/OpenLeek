import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

import { agentExecutionRuntime } from "../../../../server/runtime";

export const runtime = "nodejs";

async function handler(request: Request) {
  const runtime = await agentExecutionRuntime();
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: request,
    router: runtime.router,
    createContext: () => ({}),
  });
}

export { handler as GET, handler as POST };
