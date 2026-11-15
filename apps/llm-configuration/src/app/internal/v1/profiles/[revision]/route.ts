import { authFailure, profile, requireConsumer } from "../../../../../server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ revision: string }> }) {
  try {
    const consumer = new URL(request.url).searchParams.get("consumer");
    if (consumer !== "hindsight") return Response.json({ error: "invalid consumer" }, { status: 400 });
    await requireConsumer(request);
    const route = new URL(request.url).searchParams.get("route");
    if (!route) return Response.json({ error: "route is required" }, { status: 400 });
    return await profile((await context.params).revision, route);
  } catch (error) {
    return authFailure(error);
  }
}
