import { newsContext } from "../../server/runtime";
export const runtime = "nodejs";
export async function GET() { try { await newsContext(); return Response.json({ status: "ready", service: "news-context" }); } catch (error) { return Response.json({ status: "not_ready", message: error instanceof Error ? error.message : "initialization failed" }, { status: 503 }); } }
