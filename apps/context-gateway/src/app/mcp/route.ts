import { gateway } from "../../server/runtime";
export const runtime = "nodejs";
export async function POST(request: Request) { const match = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization")?.trim() ?? ""); if (!match?.[1]) return Response.json({ error: "bearer credential required" }, { status: 401 }); return (await gateway()).forward(match[1], await request.json().catch(() => null)); }
