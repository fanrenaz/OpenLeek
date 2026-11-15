import { contextRegistry } from "../../../../server/runtime";
export const runtime = "nodejs";
export async function GET(request: Request, { params }: { params: Promise<{ installationRef: string }> }) {
  const expected = process.env.OPENLEEK_CONTEXT_REGISTRY_MANAGEMENT_TOKEN;
  if (!expected || request.headers.get("authorization") !== `Bearer ${expected}`) return Response.json({ error: "management authorization required" }, { status: 401 });
  try { return Response.json(await (await contextRegistry()).resolve(decodeURIComponent((await params).installationRef)), { headers: { "cache-control": "no-store" } }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "resolution failed" }, { status: 404, headers: { "cache-control": "no-store" } }); }
}
export async function PATCH(request: Request, { params }: { params: Promise<{ installationRef: string }> }) {
  const expected = process.env.OPENLEEK_CONTEXT_REGISTRY_MANAGEMENT_TOKEN;
  if (!expected || request.headers.get("authorization") !== `Bearer ${expected}`) return Response.json({ error: "management authorization required" }, { status: 401 });
  try { const ref = decodeURIComponent((await params).installationRef); const body = await request.json() as { action?: string; state?: import("@openleek/contracts/context").ContextInstallationState; failure?: string }; const service = await contextRegistry(); if (body.action === "activate") return Response.json(await service.verifyAndActivate(ref)); if (body.action === "transition" && body.state) return Response.json(await service.transition(ref, body.state, body.failure)); return Response.json({ error: "invalid action" }, { status: 400 }); } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "operation failed" }, { status: 400 }); }
}
