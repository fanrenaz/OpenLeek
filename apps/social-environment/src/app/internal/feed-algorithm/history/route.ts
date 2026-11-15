import { socialEnvironmentService } from "../../../../server/runtime";

export const runtime = "nodejs";

interface HistoryRequest {
  operation?: "all" | "round";
  cursor?: string;
  roundId?: number;
}

/**
 * Runner-only committed-history endpoint. Its opaque capability deliberately
 * has no Agent identity, MCP tool rights, or resource scope.
 */
export async function POST(request: Request) {
  try {
    const capability = bearer(request.headers.get("authorization"));
    if (capability === undefined) return Response.json({ error: "missing feed algorithm history capability" }, { status: 401 });
    const body = await request.json().catch(() => null) as HistoryRequest | null;
    if (body?.operation !== "all" && body?.operation !== "round") {
      return Response.json({ error: "invalid feed algorithm history operation" }, { status: 400 });
    }
    const result = await (await socialEnvironmentService()).readFeedAlgorithmHistory({
      capability,
      operation: body.operation,
      ...(body.cursor === undefined ? {} : { cursor: body.cursor }),
      ...(body.roundId === undefined ? {} : { roundId: body.roundId }),
    });
    return Response.json(
      body.operation === "all" ? result : { record: result },
      { headers: { "cache-control": "no-store" } },
    );
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
