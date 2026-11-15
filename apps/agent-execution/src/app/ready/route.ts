import { agentExecutionRuntime } from "../../server/runtime";

export const runtime = "nodejs";

export async function GET() {
  try {
    const service = await agentExecutionRuntime();
    await service.ready();
    return Response.json({ status: "ready", service: "agent-execution", backend: service.backend.name });
  } catch (error) {
    return Response.json(
      { status: "not_ready", service: "agent-execution", message: error instanceof Error ? error.message : "initialization failed" },
      { status: 503 },
    );
  }
}
