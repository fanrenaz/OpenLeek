import { authorizedContextRuntime, executeSocialRuntime } from "../../../../../server/runtime-v2";
export const runtime = "nodejs";
export async function POST(request: Request) {
  if (!authorizedContextRuntime(request)) return Response.json({ error: "authorization required" }, { status: 401 });
  try { return Response.json(await executeSocialRuntime(await request.json())); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "runtime operation failed" }, { status: 400 }); }
}
