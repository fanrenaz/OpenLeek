import { financialMarketRevisionService } from "../../server/runtime";
import { hasObserverAccess } from "../../server/observer-access";
import { financialObserverQuerySchema, queryFinancialObserver } from "../../application/observer-query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!hasObserverAccess(request)) return Response.json({ error: "observer access required" }, { status: 401 });
  const url = new URL(request.url);
  const runId = url.searchParams.get("runId")?.trim();
  const revisionRef = url.searchParams.get("revisionRef")?.trim();
  if (!runId || !revisionRef) return Response.json({ error: "runId and revisionRef are required" }, { status: 400 });
  const view = url.searchParams.get("view") ?? "snapshot";
  try {
    const service = await financialMarketRevisionService();
    const input = financialObserverQuerySchema.parse({
      runId,
      revisionRef,
      view,
      depth: optionalInteger(url.searchParams.get("depth")),
      roundId: optionalInteger(url.searchParams.get("roundId")),
      side: url.searchParams.get("side") ?? undefined,
      cursor: url.searchParams.get("cursor") ?? undefined,
      limit: optionalInteger(url.searchParams.get("limit")),
    });
    return Response.json(await queryFinancialObserver(service, input), noStore());
  } catch (error) {
    return observerError(error);
  }
}

function optionalInteger(value: string | null): number | undefined {
  if (value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("invalid numeric observer parameter");
  return parsed;
}

function noStore(): ResponseInit {
  return { headers: { "Cache-Control": "private, no-store" } };
}

function observerError(error: unknown) {
  const message = error instanceof Error ? error.message : "observer request failed";
  const status = /unknown|not found/i.test(message) ? 404 : /committed|precondition/i.test(message) ? 409 : 400;
  return Response.json({ error: message.slice(0, 500) }, { status, ...noStore() });
}
