import { newsContext } from "../../../server/runtime";

export const runtime = "nodejs";

type RequestBody = {
  id?: string | number;
  method?: string;
  params?: { uri?: string; cursor?: string };
};

export async function POST(request: Request) {
  const token = bearer(request);
  if (!token) return rpc(null, -32001, "authorization required", 401);
  const body = await request.json().catch(() => null) as RequestBody | null;
  const id = body?.id ?? null;
  try {
    if (body?.method === "initialize") return rpcResult(id, { protocolVersion: "2025-06-18", capabilities: { resources: { listChanged: false } }, serverInfo: { name: "openleek-news-context", version: "2.0.0" } });
    if (body?.method === "notifications/initialized") return new Response(null, { status: 202 });
    const service = await newsContext();
    if (body?.method === "tools/list") return rpcResult(id, { tools: [] });
    if (body?.method === "resources/list") return rpcResult(id, await service.listDailyResources(token, body.params?.cursor));
    if (body?.method === "resources/read" && body.params?.uri) return resourceResult(body.params.uri, await service.readDailyResource(token, body.params.uri), id);
    return rpc(id, -32601, "method or capability not found", 404);
  } catch (error) {
    return rpc(id, -32602, error instanceof Error ? error.message : "invalid request", 400);
  }
}

function bearer(request: Request) { const value = request.headers.get("authorization"); return value?.startsWith("Bearer ") ? value.slice(7) : undefined; }
function resourceResult(uri: string, value: unknown, id: string | number | null) { return rpcResult(id, { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(value) }] }); }
function rpcResult(id: string | number | null, result: unknown) { return Response.json({ jsonrpc: "2.0", id, result }, { headers: { "cache-control": "no-store" } }); }
function rpc(id: string | number | null, code: number, message: string, status: number) { return Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { status, headers: { "cache-control": "no-store" } }); }
