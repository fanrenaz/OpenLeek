import { socialMcpPermissionsSchema } from "@openleek/contracts/agent";
import { deleteDraftInputSchema, deleteVersionInputSchema, type AssetDeletionResult, type AssetTombstone } from "@openleek/contracts/assets";
import { checkpointSchema, committedFactQuerySchema, contextRevisionSchema } from "@openleek/contracts/context";
import { dataDictionarySourceSchema } from "@openleek/contracts/data-dictionary";
import { identifierSchema, mutationHeaderSchema } from "@openleek/contracts/core";
import { socialCommittedFactsSchema } from "@openleek/contracts/observability";
import { candidateActionSchema, socialObservationSchema } from "@openleek/contracts/experiment";
import { socialEnvironmentSectionSchema } from "@openleek/contracts/world";
import { domainProcedure, OpenLeekDomainError, t } from "@openleek/trpc";
import { z } from "zod";
import { SocialDomainError } from "../application/errors";
import type { SocialAction, SocialSection } from "../domain/models";
import type {
  ExportedSocialFacts,
  Mutation,
  SocialCheckpoint,
  SocialObservation,
  SocialPost,
  SocialSummary,
} from "../domain/models";
import type { FeedAlgorithmDraft, FeedAlgorithmLimits, FeedAlgorithmVersion, SocialNetworkDraft, SocialNetworkLimits, SocialNetworkVersion } from "../domain/models";
import type { SocialNetworkParticipant, SocialNetworkValidation } from "../application/http-social-network-executor";
import type { FeedAlgorithmValidation } from "../application/feed-algorithm-executor";
import type { SocialContextRevision, SocialMcpAgent, SocialMcpBinding, SocialMcpScope } from "../application/revision-model";
import { socialObserverQuerySchema, type SocialObserverQuery } from "../application/observer-query";
import { socialDataDictionary } from "../domain/data-dictionary";

export interface SocialEnvironmentRouterPort {
  listSocialNetworks(includeDeleted?: boolean): { drafts: SocialNetworkDraft[]; versions: SocialNetworkVersion[]; tombstones?: AssetTombstone[] } | Promise<{ drafts: SocialNetworkDraft[]; versions: SocialNetworkVersion[]; tombstones?: AssetTombstone[] }>;
  getSocialNetworkDraft(networkId: string, includeDeleted?: boolean): SocialNetworkDraft | Promise<SocialNetworkDraft>;
  getSocialNetworkVersion(versionRef: string, includeDeleted?: boolean): SocialNetworkVersion | Promise<SocialNetworkVersion>;
  saveSocialNetworkDraft(input: { networkId?: string; expectedRevision?: number; name: string; source: string; defaultConfig: Record<string, unknown>; configSchema?: Record<string, unknown>; dependencies?: string[]; limits?: SocialNetworkLimits }): Promise<SocialNetworkDraft>;
  validateSocialNetwork(input: { networkId: string; source?: string; dependencies?: string[]; limits?: SocialNetworkLimits }): Promise<SocialNetworkValidation>;
  publishSocialNetwork(input: { networkId: string; expectedRevision: number }): Promise<SocialNetworkVersion>;
  deleteSocialNetworkDraft(input: { networkId: string; expectedRevision: number; idempotencyKey: string }): Promise<AssetDeletionResult>;
  deleteSocialNetworkVersion(input: { versionRef: string; idempotencyKey: string }): Promise<AssetDeletionResult>;
  resolveSocialNetwork(input: { versionRef: string; config: Record<string, unknown>; seed: string; population: readonly SocialNetworkParticipant[] }): Promise<{ relationships: Array<{ followerSlotId: string; followeeSlotId: string }> }>;
  listFeedAlgorithms(includeDeleted?: boolean): { drafts: FeedAlgorithmDraft[]; versions: FeedAlgorithmVersion[]; tombstones?: AssetTombstone[] } | Promise<{ drafts: FeedAlgorithmDraft[]; versions: FeedAlgorithmVersion[]; tombstones?: AssetTombstone[] }>;
  getFeedAlgorithmDraft(algorithmId: string, includeDeleted?: boolean): FeedAlgorithmDraft | Promise<FeedAlgorithmDraft>;
  getFeedAlgorithmVersion(versionRef: string, includeDeleted?: boolean): FeedAlgorithmVersion | Promise<FeedAlgorithmVersion>;
  saveFeedAlgorithmDraft(input: {
    algorithmId?: string;
    expectedRevision?: number;
    name: string;
    source: string;
    defaultConfig: Record<string, unknown>;
    configSchema?: Record<string, unknown>;
    dependencies?: string[];
    limits?: FeedAlgorithmLimits;
  }): Promise<FeedAlgorithmDraft>;
  validateFeedAlgorithm(input: { algorithmId: string; source?: string; dependencies?: string[]; limits?: FeedAlgorithmLimits }): Promise<FeedAlgorithmValidation>;
  publishFeedAlgorithm(input: { algorithmId: string; expectedRevision: number }): Promise<FeedAlgorithmVersion>;
  deleteFeedAlgorithmDraft(input: { algorithmId: string; expectedRevision: number; idempotencyKey: string }): Promise<AssetDeletionResult>;
  deleteFeedAlgorithmVersion(input: { versionRef: string; idempotencyKey: string }): Promise<AssetDeletionResult>;
  previewFeedAlgorithm(input: { versionRef: string; config: Record<string, unknown>; runId: string; revisionRef: string; seed: string }): Promise<{ feeds: Array<{ actorId: string; postIds: string[] }> }>;
  validateSection(section: SocialSection): void | Promise<void>;
  initialize(runId: string, section: SocialSection, mutation: Mutation): Promise<SocialCheckpoint>;
  observe(
    runId: string,
    roundId: number,
    actorIds: readonly string[],
    mutation: Mutation,
  ): Promise<readonly SocialObservation[]>;
  apply(
    runId: string,
    roundId: number,
    actions: readonly SocialAction[],
    mutation: Mutation,
  ): Promise<readonly SocialPost[]>;
  seal(runId: string, roundId: number, mutation: Mutation): Promise<SocialCheckpoint>;
  publish(
    runId: string,
    roundId: number,
    checkpointRef: string,
    mutation: Mutation,
  ): Promise<SocialCheckpoint>;
  fork(
    sourceRunId: string,
    targetRunId: string,
    sourceCheckpointRef: string,
    mutation: Mutation,
  ): Promise<SocialCheckpoint>;
  summary(runId: string, roundId: number, checkpointRef: string): SocialSummary | Promise<SocialSummary>;
  exportFacts(
    runId: string,
    roundId: number,
    checkpointRef: string,
  ): ExportedSocialFacts | Promise<ExportedSocialFacts>;
  exportCommittedRevisionFacts(runId: string, revisionRef: string): ExportedSocialFacts | Promise<ExportedSocialFacts>;
  observer(input: SocialObserverQuery): unknown | Promise<unknown>;
  committedFollowerCount(runId: string, actorId: string): number | Promise<number>;
  initializeRevision(runId: string, section: SocialSection, mutation: Mutation, simulationSeed?: number): Promise<SocialContextRevision>;
  freezeFullSnapshot(input: {
    runId: string;
    roundId: number;
    baseline: SocialContextRevision;
    mutation: Mutation;
  }): Promise<SocialContextRevision>;
  provisionMcpBindings(input: {
    runId: string;
    roundId: number;
    revision: SocialContextRevision;
    agents: readonly SocialMcpAgent[];
  }): Promise<readonly SocialMcpBinding[]>;
  openMcpScope(input: {
    runId: string;
    roundId: number;
    agentId: string;
    principalId: string;
    revision: SocialContextRevision;
    turnId: string;
    attemptId?: string;
  }): Promise<SocialMcpScope>;
  closeMcpScope(input: { runId: string; scopeId: string }): Promise<void>;
  revokeMcpBindings(input: { runId: string }): Promise<void>;
  settlementStatus(input: { runId: string; roundId: number; finalFailedTurnIds: readonly string[] }): { settled: boolean; pendingIntentCount: number; pendingOutboxCount: number } | Promise<{ settled: boolean; pendingIntentCount: number; pendingOutboxCount: number }>;
  sealCandidateRevision(input: {
    runId: string;
    roundId: number;
    baseRevision: SocialContextRevision;
    readRevision: SocialContextRevision;
    finalFailedTurnIds: readonly string[];
    mutation: Mutation;
  }): Promise<SocialContextRevision>;
  commitCandidateRevision(input: {
    runId: string;
    roundId: number;
    candidateRevision: SocialContextRevision;
    mutation: Mutation;
  }): Promise<SocialContextRevision>;
  forkRevision(input: {
    sourceRunId: string;
    targetRunId: string;
    sourceRevision: SocialContextRevision;
    mutation: Mutation;
    feedAlgorithm?: { versionRef: string; config: Record<string, unknown> };
  }): Promise<SocialContextRevision>;
}

const roundIdSchema = z.number().int().positive();
// MCP principals are registered once, against the immutable initial revision
// before the first executable round is opened.  All turn and mutation APIs
// continue to use `roundIdSchema` and therefore require a positive round.
const bindingRoundIdSchema = z.number().int().nonnegative();
const socialCommandSchema = z.object({
  runId: identifierSchema,
  roundId: roundIdSchema,
  mutation: mutationHeaderSchema,
});

const committedRoundQuerySchema = committedFactQuerySchema.extend({
  roundId: z.number().int().nonnegative(),
  committedCheckpointRef: identifierSchema,
});
const committedRevisionQuerySchema = committedFactQuerySchema.extend({
  revisionRef: identifierSchema,
});

const revisionInputSchema = z.object({
  ref: identifierSchema,
  context: z.literal("social_environment"),
  runId: identifierSchema,
  roundId: z.number().int().nonnegative(),
  digest: z.string().regex(/^[a-f0-9]{64}$/i),
  parentRevisionRef: identifierSchema.optional(),
  sourceManifestRef: identifierSchema.optional(),
}).strict();

const socialMcpAgentSchema = z.object({
  agentId: identifierSchema,
  principalId: identifierSchema,
  actorId: identifierSchema,
  permissions: socialMcpPermissionsSchema,
}).strict();
const socialMcpBindingSchema = z.object({
  context: z.literal("social"),
  agentId: identifierSchema,
  endpoint: z.string().url(),
}).strict();
const socialMcpScopeSchema = z.object({
  scopeId: identifierSchema,
  runId: identifierSchema,
  roundId: roundIdSchema,
  principalId: identifierSchema,
  agentId: identifierSchema,
  actorId: identifierSchema,
  readRevisionRef: identifierSchema,
  turnId: identifierSchema,
  attemptId: identifierSchema.optional(),
  expiresAt: z.string().datetime(),
}).strict();
const feedAlgorithmLimitsSchema = z.object({
  maxRuntimeMs: z.number().int().min(1).max(60_000),
  maxMemoryMb: z.number().int().min(64).max(1_024),
}).strict();
const feedAlgorithmDraftInputSchema = z.object({
  algorithmId: identifierSchema.optional(),
  expectedRevision: z.number().int().positive().optional(),
  name: z.string().min(1).max(240),
  source: z.string().min(1).max(250_000),
  defaultConfig: z.record(z.string(), z.unknown()).default({}),
  configSchema: z.record(z.string(), z.unknown()).optional(),
  dependencies: z.array(z.string().min(1).max(100)).max(5).optional(),
  limits: feedAlgorithmLimitsSchema.optional(),
}).strict();
const feedAlgorithmRankedFeedSchema = z.object({
  actorId: identifierSchema,
  postIds: z.array(identifierSchema).max(1_000),
}).strict();

/**
 * The only Social transport surface.  It is constructed by the Social Next
 * service, while Experiment and Console reach it through a network tRPC
 * client rather than importing this module.
 */
export function createSocialEnvironmentRouter(service: SocialEnvironmentRouterPort) {
  return t.router({
    dataDictionary: t.router({
      catalog: domainProcedure
        .input(z.object({}).strict())
        .output(dataDictionarySourceSchema)
        .query(() => socialDataDictionary),
    }),
    socialNetworks: domainProcedure.input(z.object({ includeDeleted: z.boolean().optional() }).strict()).query(async ({ input }) => invoke(async () => service.listSocialNetworks(input.includeDeleted))),
    socialNetworkDraft: domainProcedure.input(z.object({ networkId: identifierSchema, includeDeleted: z.boolean().optional() }).strict()).query(async ({ input }) => invoke(async () => service.getSocialNetworkDraft(input.networkId, input.includeDeleted))),
    socialNetworkVersion: domainProcedure.input(z.object({ versionRef: identifierSchema, includeDeleted: z.boolean().optional() }).strict()).query(async ({ input }) => invoke(async () => service.getSocialNetworkVersion(input.versionRef, input.includeDeleted))),
    saveSocialNetworkDraft: domainProcedure.input(z.object({ networkId: identifierSchema.optional(), expectedRevision: z.number().int().positive().optional(), name: z.string().min(1).max(240), source: z.string().min(1).max(250_000), defaultConfig: z.record(z.string(), z.unknown()).default({}), configSchema: z.record(z.string(), z.unknown()).optional(), dependencies: z.array(z.string()).max(5).optional(), limits: feedAlgorithmLimitsSchema.optional() }).strict()).mutation(async ({ input }) => invoke(async () => service.saveSocialNetworkDraft({ name: input.name, source: input.source, defaultConfig: input.defaultConfig, ...(input.networkId === undefined ? {} : { networkId: input.networkId }), ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }), ...(input.configSchema === undefined ? {} : { configSchema: input.configSchema }), ...(input.dependencies === undefined ? {} : { dependencies: input.dependencies }), ...(input.limits === undefined ? {} : { limits: input.limits }) }))),
    validateSocialNetwork: domainProcedure.input(z.object({ networkId: identifierSchema, source: z.string().optional(), dependencies: z.array(z.string()).max(5).optional(), limits: feedAlgorithmLimitsSchema.optional() }).strict()).mutation(async ({ input }) => invoke(async () => service.validateSocialNetwork({ networkId: input.networkId, ...(input.source === undefined ? {} : { source: input.source }), ...(input.dependencies === undefined ? {} : { dependencies: input.dependencies }), ...(input.limits === undefined ? {} : { limits: input.limits }) }))),
    publishSocialNetwork: domainProcedure.input(z.object({ networkId: identifierSchema, expectedRevision: z.number().int().positive() }).strict()).mutation(async ({ input }) => invoke(async () => service.publishSocialNetwork(input))),
    deleteSocialNetworkDraft: domainProcedure.input(deleteDraftInputSchema.extend({ networkId: identifierSchema }).strict()).mutation(async ({ input }) => invoke(async () => service.deleteSocialNetworkDraft(input))),
    deleteSocialNetworkVersion: domainProcedure.input(deleteVersionInputSchema).mutation(async ({ input }) => invoke(async () => service.deleteSocialNetworkVersion(input))),
    resolveSocialNetwork: domainProcedure.input(z.object({ versionRef: identifierSchema, config: z.record(z.string(), z.unknown()).default({}), seed: z.string(), population: z.array(z.object({ slotId: identifierSchema, cohortKey: identifierSchema, cohortIndex: z.number().int().positive(), actorId: identifierSchema }).strict()).max(100_000) }).strict()).mutation(async ({ input }) => invoke(async () => service.resolveSocialNetwork(input))),
    feedAlgorithms: domainProcedure
      .input(z.object({ includeDeleted: z.boolean().optional() }).strict())
      .query(async ({ input }) => invoke(async () => service.listFeedAlgorithms(input.includeDeleted))),

    feedAlgorithmDraft: domainProcedure
      .input(z.object({ algorithmId: identifierSchema, includeDeleted: z.boolean().optional() }).strict())
      .query(async ({ input }) => invoke(async () => service.getFeedAlgorithmDraft(input.algorithmId, input.includeDeleted))),

    feedAlgorithmVersion: domainProcedure
      .input(z.object({ versionRef: identifierSchema, includeDeleted: z.boolean().optional() }).strict())
      .query(async ({ input }) => invoke(async () => service.getFeedAlgorithmVersion(input.versionRef, input.includeDeleted))),

    saveFeedAlgorithmDraft: domainProcedure
      .input(feedAlgorithmDraftInputSchema)
      .mutation(async ({ input }) => invoke(async () => service.saveFeedAlgorithmDraft({
        name: input.name,
        source: input.source,
        defaultConfig: input.defaultConfig,
        ...(input.algorithmId === undefined ? {} : { algorithmId: input.algorithmId }),
        ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
        ...(input.configSchema === undefined ? {} : { configSchema: input.configSchema }),
        ...(input.dependencies === undefined ? {} : { dependencies: input.dependencies }),
        ...(input.limits === undefined ? {} : { limits: input.limits }),
      }))),

    validateFeedAlgorithm: domainProcedure
      .input(z.object({
        algorithmId: identifierSchema,
        source: z.string().min(1).max(250_000).optional(),
        dependencies: z.array(z.string().min(1).max(100)).max(5).optional(),
        limits: feedAlgorithmLimitsSchema.optional(),
      }).strict())
      .mutation(async ({ input }) => invoke(async () => service.validateFeedAlgorithm({
        algorithmId: input.algorithmId,
        ...(input.source === undefined ? {} : { source: input.source }),
        ...(input.dependencies === undefined ? {} : { dependencies: input.dependencies }),
        ...(input.limits === undefined ? {} : { limits: input.limits }),
      }))),

    publishFeedAlgorithm: domainProcedure
      .input(z.object({ algorithmId: identifierSchema, expectedRevision: z.number().int().positive() }).strict())
      .mutation(async ({ input }) => invoke(async () => service.publishFeedAlgorithm(input))),

    deleteFeedAlgorithmDraft: domainProcedure.input(deleteDraftInputSchema.extend({ algorithmId: identifierSchema }).strict()).mutation(async ({ input }) => invoke(async () => service.deleteFeedAlgorithmDraft(input))),
    deleteFeedAlgorithmVersion: domainProcedure.input(deleteVersionInputSchema).mutation(async ({ input }) => invoke(async () => service.deleteFeedAlgorithmVersion(input))),

    previewFeedAlgorithm: domainProcedure
      .input(z.object({
        versionRef: identifierSchema,
        config: z.record(z.string(), z.unknown()).default({}),
        runId: identifierSchema,
        revisionRef: identifierSchema,
        seed: z.string().min(1).max(240),
      }).strict())
      .output(z.object({ feeds: z.array(feedAlgorithmRankedFeedSchema) }))
      .mutation(async ({ input }) => invoke(async () => service.previewFeedAlgorithm(input))),

    validate: domainProcedure
      .input(socialEnvironmentSectionSchema)
      .mutation(async ({ input }) => invoke(async () => {
        await service.validateSection(toSection(input));
        return { valid: true };
      })),

    initialize: domainProcedure
      .input(z.object({
        runId: identifierSchema,
        section: socialEnvironmentSectionSchema,
        mutation: mutationHeaderSchema,
      }))
      .output(z.object({ checkpoint: checkpointSchema }))
      .mutation(async ({ input }) => invoke(async () => ({
        checkpoint: await service.initialize(input.runId, toSection(input.section), input.mutation),
      }))),

    revisionInitialize: domainProcedure
      .input(z.object({
        runId: identifierSchema,
        section: socialEnvironmentSectionSchema,
        mutation: mutationHeaderSchema,
        simulationSeed: z.number().int().default(0),
      }))
      .output(z.object({ revision: contextRevisionSchema }))
      .mutation(async ({ input }) => invoke(async () => ({
        revision: await service.initializeRevision(input.runId, toSection(input.section), input.mutation, input.simulationSeed),
      }))),

    freezeFullSnapshot: domainProcedure
      .input(z.object({
        runId: identifierSchema,
        roundId: roundIdSchema,
        baseline: revisionInputSchema,
        mutation: mutationHeaderSchema,
      }))
      .output(z.object({ revision: contextRevisionSchema }))
      .mutation(async ({ input }) => invoke(async () => ({
        revision: await service.freezeFullSnapshot({
          runId: input.runId,
          roundId: input.roundId,
          baseline: toRevision(input.baseline),
          mutation: input.mutation,
        }),
      }))),

    mcpBindings: domainProcedure
      .input(z.object({
        runId: identifierSchema,
        roundId: bindingRoundIdSchema,
        revision: revisionInputSchema,
        agents: z.array(socialMcpAgentSchema).min(1),
      }))
      .output(z.object({ bindings: z.array(socialMcpBindingSchema) }))
      .mutation(async ({ input }) => invoke(async () => ({
        bindings: [...await service.provisionMcpBindings({ ...input, revision: toRevision(input.revision) })],
      }))),

    openMcpScope: domainProcedure
      .input(z.object({
        runId: identifierSchema,
        roundId: roundIdSchema,
        agentId: identifierSchema,
        principalId: identifierSchema,
        revision: revisionInputSchema,
        turnId: identifierSchema,
        attemptId: identifierSchema.optional(),
      }))
      .output(z.object({ scope: socialMcpScopeSchema }))
      .mutation(async ({ input }) => invoke(async () => ({
        scope: await service.openMcpScope({
          runId: input.runId,
          roundId: input.roundId,
          agentId: input.agentId,
          principalId: input.principalId,
          revision: toRevision(input.revision),
          turnId: input.turnId,
          ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
        }),
      }))),

    closeMcpScope: domainProcedure
      .input(z.object({ runId: identifierSchema, scopeId: identifierSchema }))
      .output(z.object({ closed: z.literal(true) }))
      .mutation(async ({ input }) => invoke(async () => {
        await service.closeMcpScope(input);
        return { closed: true as const };
      })),

    revokeMcpBindings: domainProcedure
      .input(z.object({ runId: identifierSchema }))
      .output(z.object({ revoked: z.literal(true) }))
      .mutation(async ({ input }) => invoke(async () => {
        await service.revokeMcpBindings(input);
        return { revoked: true as const };
      })),

    /** Context-owned, read-only worker-drain barrier for Experiment. */
    settlementStatus: domainProcedure
      .input(z.object({
        runId: identifierSchema,
        roundId: roundIdSchema,
        finalFailedTurnIds: z.array(identifierSchema).default([]),
      }))
      .output(z.object({
        settled: z.boolean(),
        pendingIntentCount: z.number().int().nonnegative(),
        pendingOutboxCount: z.number().int().nonnegative(),
      }))
      .query(({ input }) => invoke(() => service.settlementStatus(input))),

    sealCandidateRevision: domainProcedure
      .input(z.object({
        runId: identifierSchema,
        roundId: roundIdSchema,
        baseRevision: revisionInputSchema,
        readRevision: revisionInputSchema,
        finalFailedTurnIds: z.array(identifierSchema).default([]),
        mutation: mutationHeaderSchema,
      }))
      .output(z.object({ revision: contextRevisionSchema }))
      .mutation(async ({ input }) => invoke(async () => ({
        revision: await service.sealCandidateRevision({
          ...input,
          baseRevision: toRevision(input.baseRevision),
          readRevision: toRevision(input.readRevision),
          finalFailedTurnIds: input.finalFailedTurnIds,
        }),
      }))),

    commitCandidateRevision: domainProcedure
      .input(z.object({
        runId: identifierSchema,
        roundId: roundIdSchema,
        candidateRevision: revisionInputSchema,
        mutation: mutationHeaderSchema,
      }))
      .output(z.object({ revision: contextRevisionSchema }))
      .mutation(async ({ input }) => invoke(async () => ({
        revision: await service.commitCandidateRevision({ ...input, candidateRevision: toRevision(input.candidateRevision) }),
      }))),

    forkRevision: domainProcedure
      .input(z.object({
        sourceRunId: identifierSchema,
        targetRunId: identifierSchema,
        sourceRevision: revisionInputSchema,
        mutation: mutationHeaderSchema,
        feedAlgorithm: z.object({ versionRef: identifierSchema, config: z.record(z.string(), z.unknown()).default({}) }).strict().optional(),
      }))
      .output(z.object({ revision: contextRevisionSchema }))
      .mutation(async ({ input }) => invoke(async () => {
        const { feedAlgorithm, ...fork } = input;
        return {
          revision: await service.forkRevision({
            ...fork,
            sourceRevision: toRevision(fork.sourceRevision),
            ...(feedAlgorithm === undefined ? {} : { feedAlgorithm }),
          }),
        };
      })),

    observe: domainProcedure
      .input(socialCommandSchema.extend({ baseline: checkpointSchema, actorIds: z.array(identifierSchema) }))
      .output(socialObservationSchema)
      .mutation(async ({ input }) => invoke(async () => {
        requireBaseline(input.runId, input.baseline, input.mutation);
        return toObservationResponse(
          input.runId,
          await service.observe(input.runId, input.roundId, input.actorIds, input.mutation),
          service,
        );
      })),

    // tRPC reserves `apply`; Experiment maps its logical apply port here.
    applyStep: domainProcedure
      .input(socialCommandSchema.extend({ baseline: checkpointSchema, actions: z.array(candidateActionSchema) }))
      .mutation(async ({ input }) => invoke(async () => {
        requireBaseline(input.runId, input.baseline, input.mutation);
        return {
          acceptedPosts: await service.apply(
            input.runId,
            input.roundId,
            socialActionsFromCandidates(input.actions),
            input.mutation,
          ),
        };
      })),

    seal: domainProcedure
      .input(socialCommandSchema.extend({ baseline: checkpointSchema }))
      .output(z.object({ checkpoint: checkpointSchema }))
      .mutation(async ({ input }) => invoke(async () => {
        requireBaseline(input.runId, input.baseline, input.mutation);
        return { checkpoint: await service.seal(input.runId, input.roundId, input.mutation) };
      })),

    publish: domainProcedure
      .input(socialCommandSchema.extend({ checkpoint: checkpointSchema }))
      .output(checkpointSchema)
      .mutation(async ({ input }) => invoke(() => {
        if (input.checkpoint.runId !== input.runId || input.checkpoint.roundId !== input.roundId) {
          throw new OpenLeekDomainError({
            code: "PRECONDITION_FAILED",
            message: "publish checkpoint does not belong to the requested Social round",
            violations: [{ field: "checkpoint", message: "must match runId and roundId" }],
          });
        }
        return service.publish(input.runId, input.roundId, input.checkpoint.ref, input.mutation);
      })),

    fork: domainProcedure
      .input(z.object({
        sourceRunId: identifierSchema,
        targetRunId: identifierSchema,
        source: checkpointSchema,
        mutation: mutationHeaderSchema,
      }))
      .output(z.object({ checkpoint: checkpointSchema }))
      .mutation(async ({ input }) => invoke(async () => ({
        checkpoint: await service.fork(
          input.sourceRunId,
          input.targetRunId,
          input.source.ref,
          input.mutation,
        ),
      }))),

    summary: domainProcedure
      .input(committedRoundQuerySchema)
      .query(({ input }) => invoke(() =>
        service.summary(input.runId, input.roundId, input.committedCheckpointRef),
      )),

    exportFacts: domainProcedure
      .input(committedRoundQuerySchema)
      .query(({ input }) => invoke(() =>
        service.exportFacts(input.runId, input.roundId, input.committedCheckpointRef),
      )),

    committedFacts: domainProcedure
      .input(committedRoundQuerySchema)
      .query(({ input }) => invoke(() =>
        service.exportFacts(input.runId, input.roundId, input.committedCheckpointRef),
      )),

    // Console uses this explicit Context-owned, committed-only query name.
    queryCommittedFacts: domainProcedure
      .input(committedRoundQuerySchema)
      .query(({ input }) => invoke(() =>
        service.exportFacts(input.runId, input.roundId, input.committedCheckpointRef),
      )),

    /** Manifest-facing immutable revision route; legacy checkpoint route stays above. */
    queryCommittedRevisionFacts: domainProcedure
      .input(committedRevisionQuerySchema)
      .output(socialCommittedFactsSchema)
      .query(({ input }) => invoke(async () =>
        socialCommittedFactsSchema.parse(await service.exportCommittedRevisionFacts(input.runId, input.revisionRef)),
      )),

    observer: domainProcedure
      .input(socialObserverQuerySchema)
      .query(({ input }) => invoke(async () => service.observer(input))),
  });
}

export type SocialEnvironmentRouter = ReturnType<typeof createSocialEnvironmentRouter>;

function toSection(input: z.infer<typeof socialEnvironmentSectionSchema>): SocialSection {
  return {
    exposurePolicy: input.exposurePolicy,
    actors: input.actors.map((actor) => ({
      actorId: actor.actorId,
      displayName: actor.displayName,
      maximumActionsPerRound: actor.maximumActionsPerRound,
    })),
    relationships: input.relationships.map((relationship) => ({
      actorId: relationship.followerId,
      targetActorId: relationship.followeeId,
    })),
    feedSize: input.feedSize,
    ...(input.ranking === undefined ? {} : { ranking: input.ranking }),
    ...(input.feedAlgorithm === undefined ? {} : { feedAlgorithm: input.feedAlgorithm }),
    audienceReception: input.audienceReception,
  };
}

function toRevision(input: z.infer<typeof revisionInputSchema>): SocialContextRevision {
  return {
    ref: input.ref,
    context: input.context,
    runId: input.runId,
    roundId: input.roundId,
    digest: input.digest,
    ...(input.parentRevisionRef === undefined ? {} : { parentRevisionRef: input.parentRevisionRef }),
    ...(input.sourceManifestRef === undefined ? {} : { sourceManifestRef: input.sourceManifestRef }),
  };
}

function socialActionsFromCandidates(
  candidates: readonly z.infer<typeof candidateActionSchema>[],
): SocialAction[] {
  return candidates.flatMap((candidate) => {
    const action = toSocialAction(candidate);
    return action === null ? [] : [action];
  });
}

function toSocialAction(input: z.infer<typeof candidateActionSchema>): SocialAction | null {
  switch (input.kind) {
    case "social.post":
      return {
        kind: "post",
        actionId: input.actionId,
        actorId: input.actorId,
        postId: input.postId,
        headline: input.headline,
        content: input.body,
      };
    case "social.engage":
      return {
        kind: "engagement",
        actionId: input.actionId,
        actorId: input.actorId,
        targetPostId: input.postId,
        engagementKind: input.engagement,
        ...(input.replyBody === undefined ? {} : { replyBody: input.replyBody }),
      };
    case "social.follow":
      return {
        kind: "relationship",
        actionId: input.actionId,
        actorId: input.followerId,
        targetActorId: input.followeeId,
        relationshipKind: "follow",
      };
    case "social.unfollow":
      return {
        kind: "relationship",
        actionId: input.actionId,
        actorId: input.followerId,
        targetActorId: input.followeeId,
        relationshipKind: "unfollow",
      };
    default:
      return null;
  }
}

function requireBaseline(
  runId: string,
  baseline: z.infer<typeof checkpointSchema>,
  mutation: z.infer<typeof mutationHeaderSchema>,
): void {
  if (baseline.runId !== runId || baseline.ref !== mutation.expectedCheckpointRef) {
    throw new OpenLeekDomainError({
      code: "PRECONDITION_FAILED",
      message: "baseline must be this run's expected committed checkpoint",
      violations: [{ field: "baseline", message: "does not match mutation.expectedCheckpointRef" }],
    });
  }
}

function toObservationResponse(
  runId: string,
  observations: readonly SocialObservation[],
  service: SocialEnvironmentRouterPort,
): Promise<z.infer<typeof socialObservationSchema>> {
  return Promise.all(observations.map(async (observation) => {
      return {
        agentId: observation.actorId,
        followerCount: await service.committedFollowerCount(runId, observation.actorId),
        feed: observation.visiblePosts.map((post) => ({
          postId: post.postId,
          actorId: post.authorId,
          headline: post.headline || post.content.slice(0, 500),
          body: post.content,
        })),
      };
    })).then((agents) => ({ agents }));
}

async function invoke<T>(operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SocialDomainError) {
      throw new OpenLeekDomainError({
        code: error.code,
        message: error.message,
        violations: Object.entries(error.fieldViolations).map(([field, message]) => ({ field, message })),
      });
    }
    throw error;
  }
}
