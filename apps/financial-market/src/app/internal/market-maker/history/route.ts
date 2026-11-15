import { financialMarketRevisionService } from "../../../../server/runtime";

export const runtime = "nodejs";

interface HistoryRequest {
  operation?: "all" | "round" | "makerAccount" | "participantBaseline";
  cursor?: string;
  roundId?: number;
}

/**
 * Runner-only committed-history endpoint. It is deliberately separate from
 * MCP: the opaque capability has no agent identity, tool rights, or resource
 * scope and is valid only during one Market Maker execution.
 */
export async function POST(request: Request) {
  try {
    const capability = bearer(request.headers.get("authorization"));
    if (capability === undefined) return Response.json({ error: "missing market maker history capability" }, { status: 401 });
    const body = await request.json().catch(() => null) as HistoryRequest | null;
    if (
      body?.operation !== "all"
      && body?.operation !== "round"
      && body?.operation !== "makerAccount"
      && body?.operation !== "participantBaseline"
    ) {
      return Response.json({ error: "invalid market maker history operation" }, { status: 400 });
    }
    const result = await (await financialMarketRevisionService()).readMarketMakerHistory({
      capability,
      operation: body.operation,
      ...(body.cursor === undefined ? {} : { cursor: body.cursor }),
      ...(body.roundId === undefined ? {} : { roundId: body.roundId }),
    });
    if (body.operation === "all") return Response.json(result, { headers: { "cache-control": "no-store" } });
    if (body.operation === "round") return Response.json({ record: result }, { headers: { "cache-control": "no-store" } });
    if (body.operation === "makerAccount") return Response.json({ account: result }, { headers: { "cache-control": "no-store" } });
    return Response.json({ baseline: result }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 403, headers: { "cache-control": "no-store" } },
    );
  }
}

function bearer(header: string | null): string | undefined {
  if (header === null) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}
