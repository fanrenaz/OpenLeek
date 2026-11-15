import { socialEnvironmentRouter } from "../../../../../server/router";
import { authorizedContextRuntime } from "../../../../../server/runtime-v2";
export const runtime = "nodejs";
export async function GET(request: Request) { return authorizedContextRuntime(request) ? Response.json(await socialEnvironmentRouter.createCaller({}).contextPlugin.descriptor({})) : Response.json({ error: "authorization required" }, { status: 401 }); }
