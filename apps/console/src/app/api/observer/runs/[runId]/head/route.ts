import { observerRunHead } from "../../../../../../server/observer-runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ runId: string }> }) {
  try {
    const { runId } = await context.params;
    return Response.json(await observerRunHead(runId), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return responseError(error);
  }
}
function responseError(error: unknown) {
  const message = error instanceof Error ? error.message : "Run observer head failed";
  return Response.json({ error: message.slice(0, 500) }, {
    status: /not found|unknown/i.test(message) ? 404 : 502,
    headers: { "Cache-Control": "private, no-store" },
  });
}
