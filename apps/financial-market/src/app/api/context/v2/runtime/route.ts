import { authorizedContextRuntime, executeFinancialRuntime } from "../../../../../server/runtime-v2";
export const runtime = "nodejs";
export async function POST(request: Request) {
  if (!authorizedContextRuntime(request)) return Response.json({ error: "authorization required" }, { status: 401 });
  try { return Response.json(await executeFinancialRuntime(await request.json())); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "runtime operation failed" }, { status: 400 }); }
}
