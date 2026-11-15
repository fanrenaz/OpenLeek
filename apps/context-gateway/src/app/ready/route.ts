import { gateway } from "../../server/runtime";
export const runtime = "nodejs";
export async function GET() { try { await gateway(); return Response.json({ status: "ready", service: "context-gateway" }); } catch (error) { return Response.json({ status: "not_ready", message: error instanceof Error ? error.message : "initialization failed" }, { status: 503 }); } }
