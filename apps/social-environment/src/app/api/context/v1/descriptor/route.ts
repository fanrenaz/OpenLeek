import { socialEnvironmentRouter } from "../../../../../server/router";
export const runtime = "nodejs";
export async function GET() { return Response.json(await socialEnvironmentRouter.createCaller({}).contextPlugin.descriptor({})); }
