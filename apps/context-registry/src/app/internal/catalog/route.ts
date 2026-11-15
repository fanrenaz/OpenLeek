import { contextRegistry } from "../../../server/runtime";
export const runtime = "nodejs";
export async function GET(request: Request) { const expected = process.env.OPENLEEK_CONTEXT_REGISTRY_MANAGEMENT_TOKEN; if (!expected || request.headers.get("authorization") !== `Bearer ${expected}`) return Response.json({ error: "management authorization required" }, { status: 401 }); return Response.json({ contexts: await (await contextRegistry()).catalog() }, { headers: { "cache-control": "no-store" } }); }
