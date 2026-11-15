import { z } from "zod";

import { agentExecutionRuntime } from "../../../../../server/runtime";

export const runtime = "nodejs";

const requestSchema = z.object({
  sessionId: z.string().min(1).max(500),
  turnId: z.string().min(1).max(500),
  cwd: z.string().min(1).max(4_096),
  toolName: z.string().min(1).max(500),
  toolUseId: z.string().min(1).max(500),
}).strict();

export async function POST(request: Request): Promise<Response> {
  try {
    const input = requestSchema.parse(await request.json());
    const service = await agentExecutionRuntime();
    return Response.json(await service.codexToolCallBudget(request.headers.get("authorization"), input));
  } catch (error) {
    if (error instanceof Error && error.message === "invalid_hook_token") return Response.json({ error: "invalid_token" }, { status: 401 });
    if (error instanceof z.ZodError) return Response.json({ error: "invalid_request" }, { status: 400 });
    return Response.json({ error: "budget_unavailable" }, { status: 503 });
  }
}
