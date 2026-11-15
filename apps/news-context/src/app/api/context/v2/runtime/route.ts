import { contextRuntimeOperationSchema, contextRuntimeResultSchema } from "@openleek/contracts/context";
import { projectNewsRevision, projectNewsScope } from "../../../../../server/news";
import { authorized } from "../../../../../server/auth";
import { newsContext } from "../../../../../server/runtime";

export const runtime = "nodejs";
export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ error: "authorization required" }, { status: 401 });
  try {
    const input = contextRuntimeOperationSchema.parse(await request.json());
    const service = await newsContext();
    if (input.operation === "validate") {
      await service.validateRuntimeScenario(String(input.configuration.scenarioVersionRef));
      return Response.json(contextRuntimeResultSchema.parse({ acknowledged: true }));
    }
    if (input.operation === "initialize") return Response.json(contextRuntimeResultSchema.parse({ revision: projectNewsRevision(await service.initialize({ runId: input.run.runId, scenarioVersionRef: String(input.configuration.scenarioVersionRef), clock: input.run.clock })) }));
    if (input.operation === "bind") {
      const bindings = await service.bind({ runId: input.runId, agents: input.participants.map((participant) => ({ agentId: participant.agentId, principalId: participant.principalId, bearerToken: participant.bearerToken, tools: participant.tools, resources: participant.resources })) });
      const participants = new Map(input.participants.map((participant) => [participant.agentId, participant]));
      return Response.json(contextRuntimeResultSchema.parse({ bindings: bindings.map(({ context, agentId, endpoint }) => ({ contextId: context, agentId, endpoint, bearerToken: participants.get(agentId)!.bearerToken, tools: participants.get(agentId)!.tools, resources: participants.get(agentId)!.resources })) }));
    }
    if (input.operation === "freeze") return Response.json(contextRuntimeResultSchema.parse({ revision: projectNewsRevision(await service.freeze({ runId: input.runId, roundId: input.roundId, baselineRef: input.baseline.ref })) }));
    if (input.operation === "open_scope") return Response.json(contextRuntimeResultSchema.parse({ scope: projectNewsScope(await service.openScope({ runId: input.runId, roundId: input.roundId, agentId: input.agentId, principalId: input.principalId, revisionRef: input.revision.ref, turnId: input.turnId, attemptId: input.attemptId })) }));
    if (input.operation === "close_scope") { await service.closeScope(input); return Response.json(contextRuntimeResultSchema.parse({ acknowledged: true })); }
    if (input.operation === "settlement") return Response.json(contextRuntimeResultSchema.parse({ settlement: { settled: true, pendingCount: 0, rejectedCount: 0 } }));
    if (input.operation === "seal") return Response.json(contextRuntimeResultSchema.parse({ revision: input.readRevision }));
    if (input.operation === "publish") return Response.json(contextRuntimeResultSchema.parse({ revision: projectNewsRevision(await service.commit(input.candidate.ref)) }));
    if (input.operation === "fork") return Response.json(contextRuntimeResultSchema.parse({ revision: projectNewsRevision(await service.fork({ sourceRevisionRef: input.sourceRevision.ref, targetRunId: input.targetRun.runId, targetClock: input.targetRun.clock })) }));
    await service.revokeRun(input.runId);
    return Response.json(contextRuntimeResultSchema.parse({ acknowledged: true }));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "runtime operation failed" }, { status: 400 });
  }
}
