import { socialMcpPermissionsSchema } from "@openleek/contracts/agent";
import { contextRuntimeOperationSchema, contextRuntimeResultSchema, type ContextRuntimeOperation, type DynamicContextRevision } from "@openleek/contracts/context";
import { socialEnvironmentConfigurationSchema, socialNetworkSelectionSchema } from "@openleek/contracts/world";
import { z } from "zod";
import { socialEnvironmentService } from "./runtime";
import type { SocialContextRevision } from "../application/revision-model";

const configurationSchema = socialEnvironmentConfigurationSchema.and(z.object({ socialNetwork: socialNetworkSelectionSchema.optional() }));
const external = (revision: { ref: string; runId: string; roundId: number; digest: string; parentRevisionRef?: string; sourceManifestRef?: string }): DynamicContextRevision => ({ ...revision, context: "social" });
const internal = (revision: DynamicContextRevision): SocialContextRevision => ({ ref: revision.ref, context: "social_environment", runId: revision.runId, roundId: revision.roundId, digest: revision.digest, ...(revision.parentRevisionRef ? { parentRevisionRef: revision.parentRevisionRef } : {}), ...(revision.sourceManifestRef ? { sourceManifestRef: revision.sourceManifestRef } : {}) });
const actorId = (agentId: string) => `actor:${agentId}`;
export const projectSocialScope = (scope: { scopeId: string; runId: string; roundId: number; agentId: string; principalId: string; turnId: string; attemptId?: string; expiresAt: string }) => ({
  scopeId: scope.scopeId,
  runId: scope.runId,
  roundId: scope.roundId,
  agentId: scope.agentId,
  principalId: scope.principalId,
  turnId: scope.turnId,
  attemptId: scope.attemptId!,
  expiresAt: scope.expiresAt,
});

export function authorizedContextRuntime(request: Request) {
  const expected = process.env.OPENLEEK_CONTEXT_BEARER_TOKEN;
  return Boolean(expected && request.headers.get("authorization") === `Bearer ${expected}`);
}

export async function executeSocialRuntime(inputValue: unknown) {
  const input = contextRuntimeOperationSchema.parse(inputValue);
  const service = await socialEnvironmentService();
  if (input.operation === "validate") { configurationSchema.parse(input.configuration); return contextRuntimeResultSchema.parse({ acknowledged: true }); }
  if (input.operation === "initialize") {
    const config = configurationSchema.parse(input.configuration);
    const { socialNetwork, ...base } = config;
    const actors = input.participants.map((participant) => ({ actorId: actorId(participant.agentId), displayName: participant.displayName, maximumActionsPerRound: Number(participant.accountPolicy.maximumActionsPerRound ?? 5) }));
    const relationships = socialNetwork ? (await service.resolveSocialNetwork({ ...socialNetwork, seed: `${input.run.seed}:social-network`, population: input.participants.map((participant) => ({ ...participant.profile, actorId: actorId(participant.agentId) })) })).relationships.map((relationship) => ({ actorId: actorId(input.participants.find((participant) => participant.profile.slotId === relationship.followerSlotId)!.agentId), targetActorId: actorId(input.participants.find((participant) => participant.profile.slotId === relationship.followeeSlotId)!.agentId) })) : [];
    const section = { exposurePolicy: base.exposurePolicy, feedSize: base.feedSize, audienceReception: base.audienceReception, actors, relationships, ...(base.ranking ? { ranking: base.ranking } : {}), ...(base.feedAlgorithm ? { feedAlgorithm: base.feedAlgorithm } : {}) };
    return contextRuntimeResultSchema.parse({ revision: external(await service.initializeRevision(input.run.runId, section, input.mutation, input.run.seed)) });
  }
  if (input.operation === "bind") {
    const bindings = await service.provisionMcpBindings({ runId: input.runId, roundId: input.revision.roundId, revision: internal(input.revision), agents: input.participants.map((participant) => ({ agentId: participant.agentId, principalId: participant.principalId, actorId: actorId(participant.agentId), permissions: socialMcpPermissionsSchema.parse({ tools: participant.tools, resources: participant.resources }) })) });
    const bearerByAgent = new Map(input.participants.map((participant) => [participant.agentId, participant.bearerToken]));
    return contextRuntimeResultSchema.parse({ bindings: bindings.map(({ agentId, endpoint }) => ({ contextId: "social", agentId, endpoint, bearerToken: bearerByAgent.get(agentId)!, tools: input.participants.find((participant) => participant.agentId === agentId)!.tools, resources: input.participants.find((participant) => participant.agentId === agentId)!.resources })) });
  }
  if (input.operation === "freeze") return contextRuntimeResultSchema.parse({ revision: external(await service.freezeFullSnapshot({ runId: input.runId, roundId: input.roundId, baseline: internal(input.baseline), mutation: input.mutation })) });
  if (input.operation === "open_scope") return contextRuntimeResultSchema.parse({ scope: projectSocialScope(await service.openMcpScope({ runId: input.runId, roundId: input.roundId, agentId: input.agentId, principalId: input.principalId, revision: internal(input.revision), turnId: input.turnId, attemptId: input.attemptId })) });
  if (input.operation === "close_scope") { await service.closeMcpScope({ runId: input.runId, scopeId: input.scopeId }); return contextRuntimeResultSchema.parse({ acknowledged: true }); }
  if (input.operation === "settlement") { const value = await service.settlementStatus(input); return contextRuntimeResultSchema.parse({ settlement: { settled: value.settled, pendingCount: value.pendingIntentCount + value.pendingOutboxCount, rejectedCount: 0 } }); }
  if (input.operation === "seal") return contextRuntimeResultSchema.parse({ revision: external(await service.sealCandidateRevision({ runId: input.runId, roundId: input.roundId, baseRevision: internal(input.baseline), readRevision: internal(input.readRevision), finalFailedTurnIds: input.finalFailedTurnIds, mutation: input.mutation })) });
  if (input.operation === "publish") { await service.commitCandidateRevision({ runId: input.runId, roundId: input.roundId, candidateRevision: internal(input.candidate), mutation: input.mutation }); return contextRuntimeResultSchema.parse({ revision: input.candidate }); }
  if (input.operation === "fork") { const config = configurationSchema.parse(input.configuration); return contextRuntimeResultSchema.parse({ revision: external(await service.forkRevision({ sourceRunId: input.sourceRunId, sourceRevision: internal(input.sourceRevision), targetRunId: input.targetRun.runId, mutation: input.mutation, ...(config.feedAlgorithm ? { feedAlgorithm: config.feedAlgorithm } : {}) })) }); }
  await service.revokeMcpBindings({ runId: input.runId });
  return contextRuntimeResultSchema.parse({ acknowledged: true });
}
