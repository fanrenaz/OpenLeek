import { authorizedContextRuntime } from "../../../../../server/runtime-v2";
import { financialUiModuleSource } from "../../../../../server/ui-module";
export const runtime = "nodejs";
export async function GET(request: Request) { if (!authorizedContextRuntime(request)) return new Response("authorization required", { status: 401 }); return new Response(financialUiModuleSource, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=31536000, immutable" } }); }
