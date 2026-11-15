import { observerRunRounds } from "../../../../../../server/observer-runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ runId: string }> }) {
  try {
    const { runId } = await context.params;
    const url = new URL(request.url);
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") ?? 100)));
    const cursor = url.searchParams.get("cursor") ?? undefined;
    return Response.json(await observerRunRounds(runId, { ...(cursor === undefined ? {} : { cursor }), limit }), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Run observer timeline failed";
    return Response.json({ error: message.slice(0, 500) }, {
      status: /not found|unknown/i.test(message) ? 404 : 502,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
}
