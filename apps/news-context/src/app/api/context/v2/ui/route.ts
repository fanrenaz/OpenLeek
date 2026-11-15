import { authorized } from "../../../../../server/auth";
import { newsUiModuleSource } from "../../../../../server/ui-module";
export const runtime = "nodejs";
export async function GET(request: Request) { if (!authorized(request)) return new Response("authorization required", { status: 401 }); return new Response(newsUiModuleSource, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=31536000, immutable" } }); }
