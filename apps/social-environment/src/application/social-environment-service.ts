import { randomUUID } from "node:crypto";
import { socialMcpPermissionsSchema, type SocialMcpPermissions } from "@openleek/contracts/agent";
import type { AssetDeletionResult, AssetDeleteTarget, AssetTombstone } from "@openleek/contracts/assets";
import { sha256 } from "./canonical";
import { SocialDomainError, invalidArgument } from "./errors";
import {
  UnavailableFeedAlgorithmExecutor,
  type FeedAlgorithmExecutor,
} from "./feed-algorithm-executor";
import type { SocialProjection } from "./projection";
import { HttpSocialNetworkExecutor, type SocialNetworkParticipant } from "./http-social-network-executor";
import type {
  SocialContextRevision,
  SocialIntentRecord,
  SocialMcpAgent,
  SocialMcpBinding,
  SocialMcpCredentialPrincipal,
  SocialMcpScope,
  SocialOutboxRecord,
  SocialRevisionSnapshot,
  SocialRoundSettlement,
  SocialRoundWorkspace,
  StoredSocialRevision,
} from "./revision-model";
import {
  emptySocialState,
  type IdempotencyRecord,
  type SocialRunState,
  type SocialState,
  type SocialStateStore,
} from "./state-store";
import type {
  Actor,
  AudienceReception,
  CommittedSocialGraph,
  Engagement,
  ExportedSocialFacts,
  Exposure,
  Mutation,
  Relationship,
  RelationshipAction,
  RelationshipChange,
  SocialAction,
  SocialCheckpoint,
  SocialObservation,
  SocialPost,
  SocialSection,
  SocialSummary,
  FeedAlgorithmDraft,
  FeedAlgorithmLimits,
  FeedAlgorithmVersion,
  SocialNetworkDraft,
  SocialNetworkLimits,
  SocialNetworkVersion,
} from "../domain/models";
import { querySocialObserver, type SocialObserverQuery } from "./observer-query";

const SOCIAL_CHECKPOINT_PREFIX = "checkpoint:social_environment";

export interface SocialEnvironmentServiceOptions {
  stateStore: SocialStateStore;
  projection?: SocialProjection;
  /** Context-owned, host-reachable endpoint advertised to Agent Execution. */
  mcpEndpoint?: string;
  /** Separate, credentialless Python execution boundary for published code. */
  feedAlgorithmExecutor?: FeedAlgorithmExecutor;
  /** Runner-only endpoint for the bounded committed Social-history reader. */
  feedAlgorithmHistoryEndpoint?: string;
  socialNetworkExecutor?: HttpSocialNetworkExecutor;
}

const DEFAULT_FEED_ALGORITHM_LIMITS: FeedAlgorithmLimits = { maxRuntimeMs: 60_000, maxMemoryMb: 1_024 };

/**
 * Transactional Social Context application service.
 *
 * The state store is the only source of truth.  Projection writes happen only
 * after an already durable publish and can always be recreated at startup.
 */
export class SocialEnvironmentService {
  /**
   * The MCP route and the in-process Redis consumer mutate one owner
   * snapshot. Serialize their read-modify-persist transactions so a pending
   * outbox write cannot be overwritten by a simultaneous worker update.
   */
  private mutationTail: Promise<void> = Promise.resolve();

  private constructor(
    private state: SocialState,
    private readonly stateStore: SocialStateStore,
    private readonly projection?: SocialProjection,
    private readonly mcpEndpoint = "http://127.0.0.1:3106/internal/mcp",
    private readonly feedAlgorithmExecutor: FeedAlgorithmExecutor = new UnavailableFeedAlgorithmExecutor(),
    private readonly feedAlgorithmHistoryEndpoint = "http://social-environment:3000/internal/feed-algorithm/history",
    private readonly socialNetworkExecutor = new HttpSocialNetworkExecutor("http://algorithm-runner:8080"),
  ) {}

  static async create(options: SocialEnvironmentServiceOptions): Promise<SocialEnvironmentService> {
    const state = (await options.stateStore.load()) ?? emptySocialState();
    state.networkRegistry ??= { drafts: {}, versions: {} };
    state.networkRegistry.tombstones ??= [];
    state.algorithmRegistry.tombstones ??= [];
    const migratedLegacyMcpPrincipals = migrateLegacyMcpPrincipals(state);
    validateState(state);
    if (migratedLegacyMcpPrincipals) await options.stateStore.save(state);
    const service = new SocialEnvironmentService(
      state,
      options.stateStore,
      options.projection,
      options.mcpEndpoint,
      options.feedAlgorithmExecutor,
      options.feedAlgorithmHistoryEndpoint,
      options.socialNetworkExecutor,
    );
    await service.rebuildProjection();
    return service;
  }

  listSocialNetworks(includeDeleted = false): { drafts: SocialNetworkDraft[]; versions: SocialNetworkVersion[]; tombstones?: AssetTombstone[] } {
    const tombstones = this.state.networkRegistry.tombstones ?? [];
    return {
      drafts: Object.values(this.state.networkRegistry.drafts).filter((item) => includeDeleted || !isDeleted(tombstones, "draft", item.networkId)).sort((a, b) => a.name.localeCompare(b.name)).map(clone),
      versions: Object.values(this.state.networkRegistry.versions).filter((item) => includeDeleted || !isDeleted(tombstones, "version", item.versionRef)).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).map(clone),
      ...(includeDeleted ? { tombstones: clone(tombstones) } : {}),
    };
  }
  getSocialNetworkDraft(networkId: string, includeDeleted = false): SocialNetworkDraft { const value = this.state.networkRegistry.drafts[networkId]; if (!value || (!includeDeleted && isDeleted(this.state.networkRegistry.tombstones ?? [], "draft", networkId))) throw new SocialDomainError("NOT_FOUND", "Social Network draft does not exist"); return clone(value); }
  getSocialNetworkVersion(versionRef: string, includeDeleted = false): SocialNetworkVersion { const value = this.state.networkRegistry.versions[versionRef]; if (!value || (!includeDeleted && isDeleted(this.state.networkRegistry.tombstones ?? [], "version", versionRef))) throw new SocialDomainError("NOT_FOUND", "Social Network version does not exist"); return clone(value); }
  async saveSocialNetworkDraft(input: { networkId?: string; expectedRevision?: number; name: string; source: string; defaultConfig: Record<string, unknown>; configSchema?: Record<string, unknown>; dependencies?: string[]; limits?: SocialNetworkLimits }): Promise<SocialNetworkDraft> { requireText(input.name, "name"); requireText(input.source, "source"); const limits = normalizeFeedAlgorithmLimits(input.limits); const dependencies = normalizeDependencies(input.dependencies); return this.serialized(async () => { const networkId = input.networkId ?? `social-network:${randomUUID()}`; if (isDeleted(this.state.networkRegistry.tombstones ?? [], "draft", networkId)) throw new SocialDomainError("PRECONDITION_FAILED", "deleted Social Network draft IDs cannot be reused"); const existing = this.state.networkRegistry.drafts[networkId]; if (existing && existing.revision !== input.expectedRevision) throw new SocialDomainError("PRECONDITION_FAILED", "Social Network draft has changed; reload before saving"); if (!existing && input.expectedRevision !== undefined) throw new SocialDomainError("NOT_FOUND", "Social Network draft does not exist"); const draft: SocialNetworkDraft = { networkId, name: input.name.trim(), source: input.source, defaultConfig: clone(input.defaultConfig), configSchema: clone(input.configSchema ?? existing?.configSchema ?? {}), dependencies, limits, revision: (existing?.revision ?? 0) + 1, updatedAt: new Date().toISOString() }; this.state.networkRegistry.drafts[networkId] = draft; await this.stateStore.save(this.state); return clone(draft); }); }
  async validateSocialNetwork(input: { networkId: string; source?: string; dependencies?: string[]; limits?: SocialNetworkLimits }) { const draft = this.getSocialNetworkDraft(input.networkId); return this.socialNetworkExecutor.validate({ source: input.source ?? draft.source, dependencies: normalizeDependencies(input.dependencies ?? draft.dependencies), limits: normalizeFeedAlgorithmLimits(input.limits ?? draft.limits) }); }
  async publishSocialNetwork(input: { networkId: string; expectedRevision: number }): Promise<SocialNetworkVersion> { const draft = this.getSocialNetworkDraft(input.networkId); if (draft.revision !== input.expectedRevision) throw new SocialDomainError("PRECONDITION_FAILED", "Social Network draft has changed; reload before publishing"); const validation = await this.socialNetworkExecutor.validate({ source: draft.source, dependencies: draft.dependencies, limits: draft.limits }); if (!validation.valid) throw invalidArgument(`Social Network validation failed: ${validation.errors.join("; ") || "unknown error"}`, "source"); const configSchema = validation.configSchema ?? draft.configSchema; const defaultConfig = validation.defaultConfig ?? draft.defaultConfig; const artifactDigest = sha256({ source: draft.source, configSchema, defaultConfig, dependencies: draft.dependencies, limits: draft.limits }); const existing = Object.values(this.state.networkRegistry.versions).find((item) => item.artifactDigest === artifactDigest); if (existing) { if (isDeleted(this.state.networkRegistry.tombstones ?? [], "version", existing.versionRef)) throw new SocialDomainError("PRECONDITION_FAILED", "identical content belongs to a deleted Social Network version"); return clone(existing); } const version: SocialNetworkVersion = { networkId: draft.networkId, name: draft.name, source: draft.source, configSchema: clone(configSchema), defaultConfig: clone(defaultConfig), dependencies: [...draft.dependencies], limits: clone(draft.limits), versionRef: `social-network:${draft.networkId}:${artifactDigest.slice(0, 16)}`, artifactDigest, publishedAt: new Date().toISOString(), draftRevision: draft.revision }; return this.serialized(async () => { this.state.networkRegistry.versions[version.versionRef] = version; await this.stateStore.save(this.state); return clone(version); }); }
  deleteSocialNetworkDraft(input: { networkId: string; expectedRevision: number; idempotencyKey: string }) { return this.deleteAsset("social-network", "draft", input.networkId, input.idempotencyKey, input.expectedRevision, this.state.networkRegistry, this.state.networkRegistry.drafts[input.networkId]); }
  deleteSocialNetworkVersion(input: { versionRef: string; idempotencyKey: string }) { return this.deleteAsset("social-network", "version", input.versionRef, input.idempotencyKey, undefined, this.state.networkRegistry, this.state.networkRegistry.versions[input.versionRef]); }
  async resolveSocialNetwork(input: { versionRef: string; config: Record<string, unknown>; seed: string; population: readonly SocialNetworkParticipant[] }) { const version = this.getSocialNetworkVersion(input.versionRef); const result = await this.socialNetworkExecutor.execute({ source: version.source, dependencies: version.dependencies, limits: version.limits, config: input.config, seed: input.seed, population: input.population }); const slots = new Set(input.population.map((item) => item.slotId)); const keys = new Set<string>(); for (const relation of result.relationships) { if (!slots.has(relation.followerSlotId) || !slots.has(relation.followeeSlotId)) throw invalidArgument("Social Network refers to an unknown Social participant", "relationships"); if (relation.followerSlotId === relation.followeeSlotId) throw invalidArgument("Social Network cannot contain self-follow relationships", "relationships"); const key = `${relation.followerSlotId}\u0000${relation.followeeSlotId}`; if (keys.has(key)) throw invalidArgument("Social Network cannot contain duplicate relationships", "relationships"); keys.add(key); } return result; }

  async validateSection(section: SocialSection): Promise<void> {
    if (section.exposurePolicy !== undefined && section.exposurePolicy !== "recommendation_only" && section.exposurePolicy !== "public_browse") {
      throw invalidArgument("exposurePolicy must be recommendation_only or public_browse", "exposurePolicy");
    }
    if (!Number.isInteger(section.feedSize) || section.feedSize < 1) {
      throw invalidArgument("feedSize must be a positive integer", "feedSize");
    }
    const actorIds = new Set<string>();
    for (const actor of section.actors) {
      requireText(actor.actorId, "actors.actorId");
      requireText(actor.displayName, "actors.displayName");
      if (actorIds.has(actor.actorId)) {
        throw invalidArgument("Social actor IDs must be unique", "actors");
      }
      actorIds.add(actor.actorId);
      if (
        !Number.isInteger(actor.maximumActionsPerRound) || actor.maximumActionsPerRound < 0
      ) {
        throw invalidArgument(
          "actor maximumActionsPerRound must be a non-negative integer",
          "actors.maximumActionsPerRound",
        );
      }
    }
    for (const relationship of section.relationships ?? []) {
      if (!actorIds.has(relationship.actorId) || !actorIds.has(relationship.targetActorId)) {
        throw invalidArgument("relationship seed refers to an unknown actor", "relationships");
      }
      if (relationship.actorId === relationship.targetActorId) {
        throw invalidArgument("an actor cannot follow itself", "relationships");
      }
    }
    const ranking = section.ranking ?? { recencyWeight: 1, engagementWeight: 1 };
    if (
      !Number.isFinite(ranking.recencyWeight) ||
      ranking.recencyWeight < 0 ||
      !Number.isFinite(ranking.engagementWeight) ||
      ranking.engagementWeight < 0
    ) {
      throw invalidArgument("ranking weights must be finite and non-negative", "ranking");
    }
    if (section.feedAlgorithm !== undefined) {
      requireText(section.feedAlgorithm.versionRef, "feedAlgorithm.versionRef");
      if (!isPlainRecord(section.feedAlgorithm.config)) {
        throw invalidArgument("feedAlgorithm.config must be an object", "feedAlgorithm.config");
      }
      const version = requirePublishedFeedAlgorithm(this.state, section.feedAlgorithm.versionRef);
      if (isDeleted(ensureAlgorithmRegistry(this.state).tombstones ?? [], "version", version.versionRef)) {
        throw invalidArgument(`feed algorithm version '${version.versionRef}' has been deleted`, "feedAlgorithm.versionRef");
      }
      validateFeedAlgorithmConfig(version.configSchema, section.feedAlgorithm.config);
    }
    const audienceReception = section.audienceReception ?? {
      engagementProbability: 0.1,
      repostProbability: 0.02,
    };
    if (
      !Number.isFinite(audienceReception.engagementProbability) ||
      audienceReception.engagementProbability < 0 ||
      audienceReception.engagementProbability > 1 ||
      !Number.isFinite(audienceReception.repostProbability) ||
      audienceReception.repostProbability < 0 ||
      audienceReception.repostProbability > 1
    ) {
      throw invalidArgument("audience reception probabilities must be between zero and one", "audienceReception");
    }
  }

  /** Browser-safe library index; source is returned only for an explicitly selected draft/version. */
  listFeedAlgorithms(includeDeleted = false): { drafts: FeedAlgorithmDraft[]; versions: FeedAlgorithmVersion[]; tombstones?: AssetTombstone[] } {
    const registry = ensureAlgorithmRegistry(this.state);
    const tombstones = registry.tombstones ?? [];
    return {
      drafts: Object.values(registry.drafts).filter((item) => includeDeleted || !isDeleted(tombstones, "draft", item.algorithmId)).sort((left, right) => left.name.localeCompare(right.name)).map(clone),
      versions: Object.values(registry.versions).filter((item) => includeDeleted || !isDeleted(tombstones, "version", item.versionRef)).sort((left, right) => right.publishedAt.localeCompare(left.publishedAt)).map(clone),
      ...(includeDeleted ? { tombstones: clone(tombstones) } : {}),
    };
  }

  getFeedAlgorithmDraft(algorithmId: string, includeDeleted = false): FeedAlgorithmDraft {
    if (!includeDeleted && isDeleted(ensureAlgorithmRegistry(this.state).tombstones ?? [], "draft", algorithmId)) throw new SocialDomainError("NOT_FOUND", "feed algorithm draft does not exist");
    return clone(requireDraft(this.state, algorithmId));
  }

  getFeedAlgorithmVersion(versionRef: string, includeDeleted = false): FeedAlgorithmVersion {
    if (!includeDeleted && isDeleted(ensureAlgorithmRegistry(this.state).tombstones ?? [], "version", versionRef)) throw new SocialDomainError("NOT_FOUND", "feed algorithm version does not exist");
    return clone(requirePublishedFeedAlgorithm(this.state, versionRef));
  }

  async saveFeedAlgorithmDraft(input: {
    algorithmId?: string;
    expectedRevision?: number;
    name: string;
    source: string;
    defaultConfig: Record<string, unknown>;
    configSchema?: Record<string, unknown>;
    dependencies?: string[];
    limits?: FeedAlgorithmLimits;
  }): Promise<FeedAlgorithmDraft> {
    requireText(input.name, "name");
    requireText(input.source, "source");
    if (!isPlainRecord(input.defaultConfig)) throw invalidArgument("defaultConfig must be an object", "defaultConfig");
    if (input.configSchema !== undefined && !isPlainRecord(input.configSchema)) throw invalidArgument("configSchema must be an object", "configSchema");
    const limits = normalizeFeedAlgorithmLimits(input.limits);
    const dependencies = normalizeDependencies(input.dependencies);
    return this.serialized(async () => {
      const registry = ensureAlgorithmRegistry(this.state);
      const algorithmId = input.algorithmId ?? `feed-algorithm:${randomUUID()}`;
      if (isDeleted(registry.tombstones ?? [], "draft", algorithmId)) throw new SocialDomainError("PRECONDITION_FAILED", "deleted feed algorithm draft IDs cannot be reused");
      const existing = registry.drafts[algorithmId];
      if (existing !== undefined && input.expectedRevision !== existing.revision) {
        throw new SocialDomainError("PRECONDITION_FAILED", "feed algorithm draft has changed; reload before saving");
      }
      if (existing === undefined && input.expectedRevision !== undefined) {
        throw new SocialDomainError("NOT_FOUND", "feed algorithm draft does not exist");
      }
      const draft: FeedAlgorithmDraft = {
        algorithmId,
        name: input.name.trim(),
        source: input.source,
        defaultConfig: clone(input.defaultConfig),
        configSchema: clone(input.configSchema ?? existing?.configSchema ?? {}),
        dependencies,
        limits,
        revision: (existing?.revision ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      };
      registry.drafts[algorithmId] = draft;
      await this.stateStore.save(this.state);
      return clone(draft);
    });
  }

  async validateFeedAlgorithm(input: { algorithmId: string; source?: string; dependencies?: string[]; limits?: FeedAlgorithmLimits }) {
    const draft = requireDraft(this.state, input.algorithmId);
    return this.feedAlgorithmExecutor.validate({
      source: input.source ?? draft.source,
      dependencies: normalizeDependencies(input.dependencies ?? draft.dependencies),
      limits: normalizeFeedAlgorithmLimits(input.limits ?? draft.limits),
    });
  }

  async publishFeedAlgorithm(input: { algorithmId: string; expectedRevision: number }): Promise<FeedAlgorithmVersion> {
    const draft = requireDraft(this.state, input.algorithmId);
    if (draft.revision !== input.expectedRevision) throw new SocialDomainError("PRECONDITION_FAILED", "feed algorithm draft has changed; reload before publishing");
    const validation = await this.feedAlgorithmExecutor.validate({ source: draft.source, dependencies: draft.dependencies, limits: draft.limits });
    if (!validation.valid) {
      throw invalidArgument(`feed algorithm validation failed: ${validation.errors.join("; ") || "unknown error"}`, "source");
    }
    const versionDigest = sha256({
      source: draft.source,
      configSchema: validation.configSchema ?? draft.configSchema,
      defaultConfig: validation.defaultConfig ?? draft.defaultConfig,
      dependencies: draft.dependencies,
      limits: draft.limits,
    });
    return this.serialized(async () => {
      const registry = ensureAlgorithmRegistry(this.state);
      const existing = Object.values(registry.versions).find((version) => version.artifactDigest === versionDigest);
      if (existing) {
        if (isDeleted(registry.tombstones ?? [], "version", existing.versionRef)) throw new SocialDomainError("PRECONDITION_FAILED", "identical content belongs to a deleted feed algorithm version");
        return clone(existing);
      }
      const versionRef = `feed-algorithm:${draft.algorithmId}:${versionDigest.slice(0, 16)}`;
      const version: FeedAlgorithmVersion = {
        algorithmId: draft.algorithmId,
        name: draft.name,
        source: draft.source,
        defaultConfig: clone(validation.defaultConfig ?? draft.defaultConfig),
        configSchema: clone(validation.configSchema ?? draft.configSchema),
        dependencies: [...draft.dependencies],
        limits: clone(draft.limits),
        versionRef,
        artifactDigest: versionDigest,
        publishedAt: new Date().toISOString(),
        draftRevision: draft.revision,
      };
      registry.versions[versionRef] = version;
      await this.stateStore.save(this.state);
      return clone(version);
    });
  }

  deleteFeedAlgorithmDraft(input: { algorithmId: string; expectedRevision: number; idempotencyKey: string }) { const registry = ensureAlgorithmRegistry(this.state); return this.deleteAsset("feed-algorithm", "draft", input.algorithmId, input.idempotencyKey, input.expectedRevision, registry, registry.drafts[input.algorithmId]); }
  deleteFeedAlgorithmVersion(input: { versionRef: string; idempotencyKey: string }) { const registry = ensureAlgorithmRegistry(this.state); return this.deleteAsset("feed-algorithm", "version", input.versionRef, input.idempotencyKey, undefined, registry, registry.versions[input.versionRef]); }

  /** Read-only preview against a committed Social revision. */
  async previewFeedAlgorithm(input: { versionRef: string; config: Record<string, unknown>; runId: string; revisionRef: string; seed: string }) {
    return this.serialized(async () => {
      const run = this.requireRun(input.runId);
      const revision = requireRevision(run, input.revisionRef);
      if (!isCommittedRevision(this.state, run, revision.ref)) {
        throw new SocialDomainError("PRECONDITION_FAILED", "feed algorithm preview requires a committed Social revision");
      }
      const version = requirePublishedFeedAlgorithm(this.state, input.versionRef);
      validateFeedAlgorithmConfig(version.configSchema, input.config);
      return this.executeFeedAlgorithm({
        version,
        config: input.config,
        seed: input.seed,
        roundId: revision.roundId,
        runId: input.runId,
        committedHeadRevisionRef: revision.ref,
        feedSize: revision.snapshot.feedSize,
        actorIds: activeActorIds(revision.snapshot),
      });
    });
  }

  async initialize(runId: string, section: SocialSection, mutation: Mutation, simulationSeed = 0): Promise<SocialCheckpoint> {
    requireText(runId, "runId");
    await this.validateSection(section);
    validateMutation(mutation, true);
    return this.execute(mutation, async () => {
      const existing = this.state.runs[runId];
      if (existing !== undefined) return checkpointFor(existing, 0);

      const relationships: Record<string, Relationship> = {};
      for (const relationship of section.relationships ?? []) {
        relationships[relationshipKey(relationship.actorId, relationship.targetActorId)] = {
          actorId: relationship.actorId,
          targetActorId: relationship.targetActorId,
        };
      }
      const run: SocialRunState = {
        runId,
        simulationSeed,
        ...(section.exposurePolicy === undefined ? {} : { exposurePolicy: section.exposurePolicy }),
        actors: Object.fromEntries(section.actors.map((actor) => [actor.actorId, clone(actor)])),
        feedSize: section.feedSize,
        ranking: clone(section.ranking ?? { recencyWeight: 1, engagementWeight: 1 }),
        ...(section.feedAlgorithm === undefined ? {} : { feedAlgorithm: clone(section.feedAlgorithm) }),
        audienceReception: clone(section.audienceReception ?? {
          engagementProbability: 0.1,
          repostProbability: 0.02,
        }),
        publishedPosts: {},
        pendingPosts: {},
        publishedEngagements: {},
        pendingEngagements: {},
        initialRelationships: clone(relationships),
        relationships,
        publishedRelationshipChanges: {},
        pendingRelationshipChanges: {},
        exposures: {},
        processedActionIds: {},
        sealed: {},
        publishedRound: 0,
        revisions: {},
        revisionHeadRef: "",
        roundWorkspaces: {},
      };
      const checkpoint = checkpointFor(run, 0);
      run.sealed["0"] = checkpoint;
      initializeRevisionState(run);
      this.state.runs[runId] = run;
      return checkpoint;
    });
  }

  /**
   * Observe is a command: idempotently persisting ranking/exposure together
   * is what makes a later audience-reception result reproducible.
   */
  async observe(
    runId: string,
    roundId: number,
    actorIds: readonly string[],
    mutation: Mutation,
  ): Promise<readonly SocialObservation[]> {
    const run = this.requireRun(runId);
    validateMutation(mutation);
    return this.execute(mutation, async () => {
      this.requireExpectedCheckpoint(run, mutation);
      this.requireActiveRound(run, roundId);
      const candidates = rankedPosts(run);
      const observations: SocialObservation[] = [];
      const requestedActors = new Set<string>();
      for (const actorId of actorIds) {
        if (requestedActors.has(actorId)) {
          throw invalidArgument("actorIds must be unique", "actorIds");
        }
        requestedActors.add(actorId);
        const actor = run.actors[actorId];
        if (actor === undefined) {
          throw new SocialDomainError("NOT_FOUND", `unknown social actor: ${actorId}`);
        }
        const exposures: Exposure[] = [];
        for (const [index, candidate] of candidates.entries()) {
          const { post } = candidate;
          const rank = index + 1;
          const key = exposureKey(roundId, actorId, post.postId);
          const existing = run.exposures[key];
          const exposure = existing ?? {
            exposureId: `exposure:${runId}:${roundId}:${actorId}:${post.postId}`,
            actorId,
            postId: post.postId,
            roundId,
            rank,
          };
          run.exposures[key] = exposure;
          exposures.push(exposure);
        }
        observations.push({ actorId, roundId, exposures, visiblePosts: candidates.map((candidate) => candidate.post) });
      }
      return observations;
    });
  }

  async apply(
    runId: string,
    roundId: number,
    actions: readonly SocialAction[],
    mutation: Mutation,
  ): Promise<readonly SocialPost[]> {
    const run = this.requireRun(runId);
    validateMutation(mutation);
    return this.execute(mutation, async () => {
      this.requireExpectedCheckpoint(run, mutation);
      this.requireActiveRound(run, roundId);
      this.validateActionCounts(run, actions);

      const actionIds = new Set<string>();
      const posts: SocialPost[] = [];
      const engagements: Engagement[] = [];
      const relationshipChanges: RelationshipChange[] = [];
      for (const action of actions) {
        requireText(action.actionId, "actions.actionId");
        if (actionIds.has(action.actionId) || this.hasActionId(run, action.actionId)) {
          throw invalidArgument("social action IDs must be unique", "actions.actionId");
        }
        actionIds.add(action.actionId);
        const actor = run.actors[action.actorId];
        if (actor === undefined) {
          throw new SocialDomainError("NOT_FOUND", `unknown social actor: ${action.actorId}`);
        }
        if (action.kind === "post") {
          requireText(action.content, "actions.content");
          requireText(action.postId, "actions.postId");
          if (this.postExists(run, action.postId, posts)) {
            throw new SocialDomainError("PRECONDITION_FAILED", "social post IDs must be unique");
          }
          posts.push({
            postId: action.postId,
            authorId: action.actorId,
            content: action.content,
            headline: action.headline?.trim() ?? "",
            roundId,
          });
          continue;
        }
        if (action.kind === "engagement") {
          if (!this.postExists(run, action.targetPostId, posts)) {
            throw new SocialDomainError(
              "PRECONDITION_FAILED",
              "engagement target post is not visible to this Social Context",
            );
          }
          if (action.engagementKind === "reply") {
            requireText(action.replyBody ?? "", "actions.replyBody");
          }
          if (
            (action.engagementKind === "like" || action.engagementKind === "repost")
            && engagementExists(run, action, engagements)
          ) {
            continue;
          }
          if (action.derivedPostId !== undefined) {
            if (action.engagementKind === "like") {
              throw invalidArgument("a like cannot create a Social post", "actions.derivedPostId");
            }
            requireText(action.derivedPostId, "actions.derivedPostId");
            if (this.postExists(run, action.derivedPostId, posts)) {
              throw new SocialDomainError("PRECONDITION_FAILED", "social post IDs must be unique");
            }
            posts.push({
              postId: action.derivedPostId,
              authorId: action.actorId,
              content: action.derivedContent ?? action.replyBody ?? "",
              headline: action.derivedHeadline?.trim() ?? "",
              roundId,
              postType: action.engagementKind === "repost" ? "repost" : "reply",
              parentPostId: action.targetPostId,
            });
          }
          engagements.push({
            engagementId: `engagement:${runId}:${action.actionId}`,
            actorId: action.actorId,
            targetPostId: action.targetPostId,
            kind: action.engagementKind,
            ...(action.replyBody === undefined ? {} : { replyBody: action.replyBody }),
            ...(action.derivedPostId === undefined ? {} : { derivedPostId: action.derivedPostId }),
            roundId,
          });
          continue;
        }
        this.validateRelationshipAction(run, action);
        relationshipChanges.push({
          actionId: action.actionId,
          actorId: action.actorId,
          targetActorId: action.targetActorId,
          kind: action.relationshipKind,
          roundId,
        });
      }

      appendRoundValues(run.pendingPosts, roundId, posts);
      appendRoundValues(run.pendingEngagements, roundId, engagements);
      appendRoundValues(run.pendingRelationshipChanges, roundId, relationshipChanges);
      for (const actionId of actionIds) run.processedActionIds[actionId] = roundId;
      return posts;
    });
  }

  async seal(runId: string, roundId: number, mutation: Mutation): Promise<SocialCheckpoint> {
    const run = this.requireRun(runId);
    validateMutation(mutation);
    return this.execute(mutation, async () => {
      this.requireExpectedCheckpoint(run, mutation);
      this.requireActiveRound(run, roundId);
      const existing = run.sealed[String(roundId)];
      if (existing !== undefined) return existing;
      const checkpoint = checkpointFor(run, roundId);
      run.sealed[String(roundId)] = checkpoint;
      return checkpoint;
    });
  }

  async publish(
    runId: string,
    roundId: number,
    sealedCheckpointRef: string,
    mutation: Mutation,
  ): Promise<SocialCheckpoint> {
    const run = this.requireRun(runId);
    validateMutation(mutation);
    const checkpoint = await this.execute(mutation, async () => {
      this.requireExpectedCheckpoint(run, mutation);
      const sealed = run.sealed[String(roundId)];
      if (sealed === undefined || sealed.ref !== sealedCheckpointRef) {
        throw new SocialDomainError(
          "PRECONDITION_FAILED",
          "only this round's sealed Social checkpoint may be published",
        );
      }
      if (roundId !== run.publishedRound + 1) {
        throw new SocialDomainError("PRECONDITION_FAILED", "Social rounds must publish sequentially");
      }
      for (const post of run.pendingPosts[String(roundId)] ?? []) run.publishedPosts[post.postId] = post;
      for (const engagement of run.pendingEngagements[String(roundId)] ?? []) {
        run.publishedEngagements[engagement.engagementId] = engagement;
      }
      for (const change of run.pendingRelationshipChanges[String(roundId)] ?? []) {
        const key = relationshipKey(change.actorId, change.targetActorId);
        if (change.kind === "follow") {
          run.relationships[key] = { actorId: change.actorId, targetActorId: change.targetActorId };
        } else {
          delete run.relationships[key];
        }
        run.publishedRelationshipChanges[change.actionId] = change;
      }
      run.publishedRound = roundId;
      commitLegacyRevision(run, roundId);
      return sealed;
    });
    // A retry of an already-durable publish also retries a failed projection.
    await this.syncProjection(this.requireRun(runId));
    return checkpoint;
  }

  async fork(
    sourceRunId: string,
    targetRunId: string,
    sourceCheckpointRef: string,
    mutation: Mutation,
  ): Promise<SocialCheckpoint> {
    const source = this.requireRun(sourceRunId);
    validateMutation(mutation);
    const checkpoint = await this.execute(mutation, async () => {
      this.requireExpectedCheckpoint(source, mutation);
      const sourceCheckpoint = Object.values(source.sealed).find((item) => item.ref === sourceCheckpointRef);
      if (sourceCheckpoint === undefined || sourceCheckpoint.roundId > source.publishedRound) {
        throw new SocialDomainError(
          "PRECONDITION_FAILED",
          "fork source must be a published Social checkpoint",
        );
      }
      const existing = this.state.runs[targetRunId];
      if (existing !== undefined) {
        const existingCheckpoint = existing.sealed[String(sourceCheckpoint.roundId)];
        if (existingCheckpoint === undefined) {
          throw new SocialDomainError("PRECONDITION_FAILED", "fork target already has incompatible state");
        }
        return existingCheckpoint;
      }
      const run = forkRun(source, targetRunId, sourceCheckpoint.roundId);
      const sourceRevision = currentRevisionFor(source);
      const snapshot = snapshotForRun(run);
      const revision = makeRevision({
        runId: targetRunId,
        roundId: sourceCheckpoint.roundId,
        kind: "committed",
        parentRevisionRef: sourceRevision.ref,
        snapshot,
      });
      run.revisions[revision.ref] = revision;
      run.revisionHeadRef = revision.ref;
      this.state.runs[targetRunId] = run;
      return run.sealed[String(sourceCheckpoint.roundId)]!;
    });
    await this.syncProjection(this.requireRun(targetRunId));
    return checkpoint;
  }

  summary(runId: string, roundId: number, committedCheckpointRef: string): SocialSummary {
    return this.exportFacts(runId, roundId, committedCheckpointRef).summary;
  }

  exportFacts(runId: string, roundId: number, committedCheckpointRef: string): ExportedSocialFacts {
    const run = this.requireRun(runId);
    this.requireCommittedCheckpoint(run, roundId, committedCheckpointRef);
    const posts = Object.values(run.publishedPosts)
      .filter((post) => post.roundId <= roundId)
      .sort(comparePosts);
    const exposures = Object.values(run.exposures)
      .filter((exposure) => exposure.roundId <= roundId)
      .sort((left, right) => left.exposureId.localeCompare(right.exposureId));
    const engagements = Object.values(run.publishedEngagements)
      .filter((engagement) => engagement.roundId <= roundId)
      .sort((left, right) => left.engagementId.localeCompare(right.engagementId));
    const relationships = Object.values(run.relationships).sort(compareRelationships);
    return clone({
      posts,
      exposures,
      engagements,
      relationships,
      summary: {
        roundId,
        postCount: posts.length,
        exposureCount: exposures.length,
        engagementCount: engagements.length,
        audienceReception: audienceReception(posts, exposures, engagements),
      },
    });
  }

  /**
   * Console receives immutable ContextRevision refs from Experiment manifests,
   * not this Context's retired checkpoint names. Only revisions reachable from
   * the committed Context HEAD are readable, so a private candidate/read
   * snapshot can never be projected as a committed fact set.
   */
  async exportCommittedRevisionFacts(runId: string, revisionRef: string): Promise<ExportedSocialFacts> {
    requireCommittedRevisionRef(this.requireRun(runId), revisionRef);
    const revision = await this.loadRevision(revisionRef);
    return factsFromRevision(revision);
  }

  /** Public observer projection. Exposure and personalized account state never cross this boundary. */
  async publicObserverSnapshot(runId: string, revisionRef: string): Promise<{
    revision: SocialContextRevision;
    actors: Actor[];
    posts: SocialPost[];
    engagements: Engagement[];
    relationships: Relationship[];
    delta: {
      previousRevisionRef?: string;
      newPostIds: string[];
      changedPostIds: string[];
      addedRelationships: Relationship[];
      removedRelationships: Relationship[];
    };
  }> {
    const run = this.requireRun(runId);
    requireCommittedRevisionRef(run, revisionRef);
    const revision = await this.loadRevision(revisionRef);
    const snapshot = revision.snapshot;
    const parent = revision.parentRevisionRef === undefined ? undefined : await this.loadRevision(revision.parentRevisionRef);
    const parentSnapshot = parent?.snapshot;
    const posts = Object.values(snapshot.posts)
      .sort((left, right) => right.roundId - left.roundId || left.postId.localeCompare(right.postId));
    const engagements = Object.values(snapshot.engagements)
      .sort((left, right) => right.roundId - left.roundId || left.engagementId.localeCompare(right.engagementId));
    const relationships = Object.values(snapshot.relationships).sort(compareRelationships);
    const previousPostIds = new Set(Object.keys(parentSnapshot?.posts ?? {}));
    const previousEngagementIds = new Set(Object.keys(parentSnapshot?.engagements ?? {}));
    const changedPostIds = new Set(
      engagements
        .filter((engagement) => !previousEngagementIds.has(engagement.engagementId))
        .map((engagement) => engagement.targetPostId),
    );
    const relationshipKeySet = (values: Record<string, Relationship>) => new Set(Object.keys(values));
    const currentRelationshipKeys = relationshipKeySet(snapshot.relationships);
    const previousRelationshipKeys = relationshipKeySet(parentSnapshot?.relationships ?? {});
    return clone({
      revision: publicRevision(revision),
      actors: Object.values(snapshot.actors).sort((left, right) => left.actorId.localeCompare(right.actorId)),
      posts,
      engagements,
      relationships,
      delta: {
        ...(parent === undefined ? {} : { previousRevisionRef: parent.ref }),
        newPostIds: posts.filter((post) => !previousPostIds.has(post.postId)).map((post) => post.postId),
        changedPostIds: [...changedPostIds].sort(),
        addedRelationships: relationships.filter((relationship) =>
          !previousRelationshipKeys.has(relationshipKey(relationship.actorId, relationship.targetActorId))),
        removedRelationships: Object.values(parentSnapshot?.relationships ?? {})
          .filter((relationship) =>
            !currentRelationshipKeys.has(relationshipKey(relationship.actorId, relationship.targetActorId)))
          .sort(compareRelationships),
      },
    });
  }

  observer(input: SocialObserverQuery): Promise<unknown> {
    return querySocialObserver(this, input);
  }

  async loadRevision(revisionRef: string): Promise<StoredSocialRevision> {
    const inMemory = findRevisionByRef(this.state, revisionRef);
    if (inMemory?.snapshot !== undefined) return clone(inMemory);
    const revision = await this.stateStore.loadRevision(revisionRef);
    if (revision === undefined) throw new SocialDomainError("NOT_FOUND", `unknown Social revision: ${revisionRef}`);
    return clone(revision);
  }

  sealedCheckpoint(runId: string, roundId: number): SocialCheckpoint {
    const checkpoint = this.requireRun(runId).sealed[String(roundId)];
    if (checkpoint === undefined) {
      throw new SocialDomainError("NOT_FOUND", `Social round ${roundId} has not been sealed`);
    }
    return clone(checkpoint);
  }

  /** Counts only the currently committed relationship graph. */
  committedFollowerCount(runId: string, actorId: string): number {
    const run = this.requireRun(runId);
    if (run.actors[actorId] === undefined) {
      throw new SocialDomainError("NOT_FOUND", `unknown social actor: ${actorId}`);
    }
    return Object.values(run.relationships).filter((item) => item.targetActorId === actorId).length;
  }

  /**
   * New revision API.  Legacy callers can keep using initialize/checkpoints
   * until Experiment switches to ContextRevision.
   */
  async initializeRevision(
    runId: string,
    section: SocialSection,
    mutation: Mutation,
    simulationSeed = 0,
  ): Promise<SocialContextRevision> {
    await this.initialize(runId, section, mutation, simulationSeed);
    return this.currentRevision(runId);
  }

  currentRevision(runId: string): SocialContextRevision {
    return publicRevision(currentRevisionFor(this.requireRun(runId)));
  }

  /**
   * Pins exactly one full Social snapshot for a round.  Every agent receives
   * a projection of this revision, never an agent-specific copy of state.
   */
  async freezeFullSnapshot(input: {
    runId: string;
    roundId: number;
    baseline: SocialContextRevision;
    mutation: Mutation;
  }): Promise<SocialContextRevision> {
    validateMutation(input.mutation);
    const run = this.requireRun(input.runId);
    return this.execute(input.mutation, async () => {
      const base = currentRevisionFor(run);
      if (input.baseline.context !== "social_environment" || input.baseline.runId !== input.runId || input.baseline.ref !== base.ref) {
        throw new SocialDomainError("PRECONDITION_FAILED", "baseline is not this run's Social revision HEAD");
      }
      if (!Number.isInteger(input.roundId) || input.roundId !== base.roundId + 1) {
        throw new SocialDomainError("PRECONDITION_FAILED", "Social read snapshots must advance exactly one round from HEAD");
      }
      const existing = run.roundWorkspaces[String(input.roundId)];
      if (existing !== undefined) {
        if (existing.baseRevisionRef !== base.ref) {
          throw new SocialDomainError("PRECONDITION_FAILED", "round workspace belongs to a different Social revision");
        }
        return publicRevision(requireRevision(run, existing.readRevisionRef));
      }
      ensureRevisionState(run);
      const snapshot = await this.snapshotWithRoundExposures(input.runId, input.roundId, base);
      const read = makeRevision({
        runId: input.runId,
        roundId: input.roundId,
        kind: "read_snapshot",
        parentRevisionRef: base.ref,
        snapshot,
      });
      run.revisions[read.ref] = read;
      run.roundWorkspaces[String(input.roundId)] = {
        roundId: input.roundId,
        baseRevisionRef: base.ref,
        readRevisionRef: read.ref,
        intents: {},
        outbox: {},
        closed: false,
      };
      return publicRevision(read);
    });
  }

  /**
   * Register Experiment-issued principals against Social actors.  Social never
   * creates, stores, or returns bearer credentials; the endpoint descriptor is
   * deliberately safe to place in an Agent workspace.
   */
  async provisionMcpBindings(input: {
    runId: string;
    roundId: number;
    revision: SocialContextRevision;
    agents: readonly SocialMcpAgent[];
  }): Promise<readonly SocialMcpBinding[]> {
    const run = this.requireRun(input.runId);
    if (!this.mcpEndpoint.trim()) throw new SocialDomainError("INTERNAL", "Social MCP endpoint is not configured");
    const workspace = run.roundWorkspaces[String(input.roundId)];
    if (workspace === undefined) {
      const baseline = currentRevisionFor(run);
      if (input.revision.ref !== baseline.ref || input.revision.roundId !== input.roundId) {
        throw new SocialDomainError("PRECONDITION_FAILED", "baseline Social MCP bindings must use this run's committed revision");
      }
    } else {
      if (workspace.readRevisionRef !== input.revision.ref) {
        throw new SocialDomainError("PRECONDITION_FAILED", "Social MCP bindings must use this round's frozen revision");
      }
    }
    const unique = new Set<string>();
    const principals = new Set<string>();
    for (const agent of input.agents) {
      requireText(agent.agentId, "agents.agentId");
      requireText(agent.principalId, "agents.principalId");
      requireText(agent.actorId, "agents.actorId");
      normalizeSocialMcpPermissions(agent.permissions);
      if (unique.has(agent.agentId)) throw invalidArgument("agent IDs must be unique", "agents.agentId");
      if (principals.has(agent.principalId)) throw invalidArgument("principal IDs must be unique", "agents.principalId");
      unique.add(agent.agentId);
      principals.add(agent.principalId);
      if (run.actors[agent.actorId] === undefined) {
        throw new SocialDomainError("NOT_FOUND", `unknown Social actor: ${agent.actorId}`);
      }
    }
    return this.durable(async () => {
      ensureRevisionState(run);
      if (run.mcp?.accessRevokedAt !== undefined) {
        throw new SocialDomainError("PRECONDITION_FAILED", "Social MCP access has been revoked for this run");
      }
      const principals = [...(run.mcp?.principals ?? [])];
      for (const agent of input.agents) {
        requireText(agent.principalId, "agents.principalId");
        const existing = principals.find((item) => item.principalId === agent.principalId);
        if (existing !== undefined) {
          if (existing.agentId !== agent.agentId || existing.actorId !== agent.actorId) {
            throw new SocialDomainError("PRECONDITION_FAILED", "Social MCP principal is already bound to another agent or actor");
          }
          if (existing.legacyFullAccess === true || !samePermissions(existing.permissions, agent.permissions)) {
            throw new SocialDomainError("PRECONDITION_FAILED", "Social MCP principal permissions cannot be changed after registration");
          }
          continue;
        }
        if (principals.some((item) => item.agentId === agent.agentId)) {
          throw new SocialDomainError("PRECONDITION_FAILED", "Social MCP agent already has a different principal");
        }
        principals.push({
          principalId: agent.principalId,
          agentId: agent.agentId,
          actorId: agent.actorId,
          permissions: normalizeSocialMcpPermissions(agent.permissions),
        });
      }
      run.mcp = { principals, activeScopes: run.mcp?.activeScopes ?? [] };
      return input.agents.map((agent) => ({ context: "social" as const, agentId: agent.agentId, endpoint: this.mcpEndpoint }));
    });
  }

  async openMcpScope(input: {
    runId: string;
    roundId: number;
    agentId: string;
    principalId: string;
    revision: SocialContextRevision;
    turnId: string;
    attemptId?: string;
    ttlMs?: number;
  }): Promise<SocialMcpScope> {
    return this.durable(async () => {
      const run = this.requireRun(input.runId);
      if (run.mcp?.accessRevokedAt !== undefined) throw new SocialDomainError("PRECONDITION_FAILED", "Social MCP access has been revoked for this run");
      const principal = run.mcp?.principals.find((item) => item.principalId === input.principalId);
      if (principal === undefined || principal.agentId !== input.agentId) {
        throw new SocialDomainError("PRECONDITION_FAILED", "Social MCP principal is not registered for this agent");
      }
      const workspace = requireWorkspace(run, input.roundId);
      if (input.revision.ref !== workspace.readRevisionRef || input.revision.runId !== input.runId) {
        throw new SocialDomainError("PRECONDITION_FAILED", "MCP scope must use this round's frozen Social revision");
      }
      const previous = run.mcp?.activeScopes.find((scope) =>
        scope.principalId === principal.principalId
        && scope.roundId === input.roundId
        && scope.turnId === input.turnId
        && scope.attemptId === input.attemptId
        && Date.parse(scope.expiresAt) > Date.now(),
      );
      if (previous !== undefined) return clone(previous);
      const scope: SocialMcpScope = {
        scopeId: `mcp:social:${randomUUID()}`,
        runId: input.runId,
        roundId: input.roundId,
        principalId: principal.principalId,
        agentId: principal.agentId,
        actorId: principal.actorId,
        readRevisionRef: workspace.readRevisionRef,
        turnId: input.turnId,
        ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
        expiresAt: new Date(Date.now() + (input.ttlMs ?? 15 * 60_000)).toISOString(),
      };
      run.mcp = {
        principals: run.mcp!.principals,
        activeScopes: [
          ...run.mcp!.activeScopes.filter((candidate) => candidate.principalId !== principal.principalId),
          scope,
        ],
      };
      return clone(scope);
    });
  }

  async closeMcpScope(input: { runId: string; scopeId: string }): Promise<void> {
    await this.durable(async () => {
      const run = this.requireRun(input.runId);
      if (run.mcp === undefined) return;
      run.mcp = { ...run.mcp, activeScopes: run.mcp.activeScopes.filter((scope) => scope.scopeId !== input.scopeId) };
    });
  }

  mcpScope(principal: SocialMcpCredentialPrincipal): SocialMcpScope {
    return this.mcpAccess(principal).scope;
  }

  mcpAccess(principal: SocialMcpCredentialPrincipal): { scope: SocialMcpScope; permissions: SocialMcpPermissions } {
    const run = this.requireRun(principal.runId);
    const mcp = run.mcp;
    if (mcp?.accessRevokedAt !== undefined) throw new SocialDomainError("PRECONDITION_FAILED", "Social MCP access has been revoked for this run");
    const registration = mcp?.principals.find((item) => item.principalId === principal.principalId);
    if (registration === undefined || registration.agentId !== principal.agentId) {
      throw new SocialDomainError("PRECONDITION_FAILED", "Social MCP principal is not registered for this run");
    }
    const scope = mcp?.activeScopes.find((item) => item.principalId === principal.principalId && item.agentId === principal.agentId);
    if (scope === undefined) throw new SocialDomainError("PRECONDITION_FAILED", "Social MCP principal scope is not active");
    if (Date.parse(scope.expiresAt) <= Date.now()) {
      throw new SocialDomainError("PRECONDITION_FAILED", "Social MCP principal scope has expired");
    }
    return {
      scope: clone(scope),
      permissions: registration.legacyFullAccess === true
        ? fullSocialMcpPermissions()
        : normalizeSocialMcpPermissions(registration.permissions),
    };
  }

  /** Run-level revocation invalidates every registered principal and scope. */
  async revokeMcpBindings(input: { runId: string }): Promise<void> {
    const run = this.requireRun(input.runId);
    await this.durable(async () => {
      if (run.mcp === undefined || run.mcp.accessRevokedAt !== undefined) return;
      run.mcp = { principals: run.mcp.principals, activeScopes: [], accessRevokedAt: new Date().toISOString() };
    });
  }

  revisionSnapshot(runId: string, revisionRef: string): SocialRevisionSnapshot {
    const revision = requireRevision(this.requireRun(runId), revisionRef);
    return clone(revision.snapshot);
  }

  /**
   * Dedicated runner-only history surface. This capability is neither an MCP
   * bearer nor an Agent scope: it names one already-committed Social lineage
   * and is deleted immediately after the corresponding algorithm finishes.
   */
  async readFeedAlgorithmHistory(input: {
    capability: string;
    operation: "all" | "round";
    cursor?: string;
    roundId?: number;
  }): Promise<unknown> {
    requireText(input.capability, "capability");
    const capability = this.state.feedAlgorithmHistoryCapabilities[input.capability];
    if (capability === undefined || capability.expiresAt <= new Date().toISOString()) {
      throw new SocialDomainError("PRECONDITION_FAILED", "feed algorithm history capability is inactive or expired");
    }
    const run = this.state.runs[capability.runId];
    const head = await this.loadRevision(capability.committedHeadRevisionRef);
    if (run === undefined || head === undefined || head.runId !== capability.runId || !isCommittedRevision(this.state, run, head.ref)) {
      throw new SocialDomainError("PRECONDITION_FAILED", "feed algorithm history capability does not name a committed Social revision");
    }
    const records = await committedSocialHistoryRecords(this, capability.runId, head.ref);
    if (input.operation === "round") {
      if (!Number.isSafeInteger(input.roundId) || input.roundId! < 0) {
        throw invalidArgument("roundId must be a non-negative safe integer", "roundId");
      }
      const record = [...records].reverse().find((item) => item.roundId === input.roundId);
      if (record === undefined) throw new SocialDomainError("NOT_FOUND", `no committed Social history for round ${input.roundId}`);
      return clone(record);
    }
    const offset = parseFeedAlgorithmHistoryCursor(input.cursor);
    const pageSize = 100;
    const page = records.slice(offset, offset + pageSize);
    return {
      records: clone(page),
      ...(offset + page.length < records.length ? { nextCursor: String(offset + page.length) } : {}),
    };
  }

  async enqueueIntent(input: {
    scope: SocialMcpScope;
    commandId: string;
    action: SocialAction;
  }): Promise<{ accepted: boolean; duplicate: boolean; commandId: string; status: SocialIntentRecord["status"] }> {
    return this.durable(async () => {
      const run = this.requireRun(input.scope.runId);
      const active = run.mcp?.activeScopes.find((scope) => scope.scopeId === input.scope.scopeId);
      if (run.mcp?.accessRevokedAt !== undefined || active === undefined || active.principalId !== input.scope.principalId) {
        throw new SocialDomainError("PRECONDITION_FAILED", "Social MCP scope is not active");
      }
      const workspace = requireWorkspace(run, active.roundId);
      if (workspace.closed) throw new SocialDomainError("PRECONDITION_FAILED", "Social round is closed for writes");
      if (input.action.actorId !== active.actorId) {
        throw new SocialDomainError("PRECONDITION_FAILED", "Social action actor does not match MCP principal");
      }
      const existing = Object.values(workspace.intents).find((intent) => intent.actionId === input.action.actionId);
      if (existing !== undefined) {
        if (sha256(existing.action) !== sha256(input.action)) {
          throw invalidArgument("Social actionId must be unique in a round worktree", "actionId");
        }
        return { accepted: false, duplicate: true, commandId: existing.commandId, status: existing.status };
      }
      validateQueuedActionShape(run, input.action);
      const used = Object.values(workspace.intents).filter((intent) => intent.actorId === active.actorId).length;
      const limit = run.actors[active.actorId]?.maximumActionsPerRound;
      if (limit !== undefined && used >= limit) {
        throw new SocialDomainError(
          "PRECONDITION_FAILED",
          `actor ${active.actorId} exceeds maximum actions per round`,
        );
      }
      const intent: SocialIntentRecord = {
        commandId: input.commandId,
        action: clone(input.action),
        roundId: active.roundId,
        actorId: active.actorId,
        turnId: active.turnId,
        ...(active.attemptId === undefined ? {} : { attemptId: active.attemptId }),
        actionId: input.action.actionId,
        status: "pending",
        createdAt: new Date().toISOString(),
      };
      // Intent and outbox are committed together. Redis publication happens
      // asynchronously in the dedicated Context worker.
      const outbox: SocialOutboxRecord = {
        commandId: input.commandId,
        streamKey: `social:${input.scope.runId}:${active.roundId}`,
        payload: { runId: input.scope.runId, roundId: active.roundId, commandId: input.commandId },
        status: "pending",
        createdAt: intent.createdAt,
      };
      workspace.intents[input.commandId] = intent;
      workspace.outbox[input.commandId] = outbox;
      return { accepted: true, duplicate: false, commandId: input.commandId, status: "pending" };
    }, true);
  }

  mcpCommandStatus(input: { scope: SocialMcpScope; commandId: string }): {
    commandId: string;
    status: SocialIntentRecord["status"];
    rejectionReason?: string;
    createdAt: string;
  } {
    requireText(input.commandId, "commandId");
    const run = this.requireRun(input.scope.runId);
    const intent = Object.values(run.roundWorkspaces)
      .map((workspace) => workspace.intents[input.commandId])
      .find((candidate): candidate is SocialIntentRecord => candidate !== undefined);
    if (intent === undefined || intent.actorId !== input.scope.actorId) {
      throw new SocialDomainError("NOT_FOUND", `unknown Social command: ${input.commandId}`);
    }
    return {
      commandId: intent.commandId,
      status: intent.status,
      ...(intent.rejectionReason === undefined ? {} : { rejectionReason: intent.rejectionReason }),
      createdAt: intent.createdAt,
    };
  }

  pendingOutbox(runId: string, roundId: number): readonly SocialOutboxRecord[] {
    const workspace = requireWorkspace(this.requireRun(runId), roundId);
    return Object.values(workspace.outbox)
      .filter((item) => item.status === "pending")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.commandId.localeCompare(right.commandId))
      .map(clone);
  }

  /**
   * Read-only barrier probe. Failed provider turns are ignored because a
   * candidate seal deterministically discards them. All remaining Context
   * work must be consumed by Social's worker before a revision can seal.
   */
  async settlementStatus(input: { runId: string; roundId: number; finalFailedTurnIds: readonly string[] }): Promise<SocialRoundSettlement> {
    await this.refreshFromStore();
    const workspace = requireWorkspace(this.requireRun(input.runId), input.roundId);
    const excluded = new Set(input.finalFailedTurnIds);
    const pendingIntents = Object.values(workspace.intents)
      .filter((intent) => intent.status === "pending" && !excluded.has(intent.turnId));
    const pendingOutboxCount = Object.values(workspace.outbox)
      .filter((outbox) => {
        const intent = workspace.intents[outbox.commandId];
        return intent !== undefined
          && intent.status === "pending"
          && !excluded.has(intent.turnId)
          && outbox.status !== "applied";
      }).length;
    return {
      settled: pendingIntents.length === 0 && pendingOutboxCount === 0,
      pendingIntentCount: pendingIntents.length,
      pendingOutboxCount,
    };
  }

  /** Discovery view for this Context's single logical Redis consumer. */
  listWorkerStreams(): Array<{ runId: string; roundId: number; streamKey: string }> {
    const streams: Array<{ runId: string; roundId: number; streamKey: string }> = [];
    for (const [runId, run] of Object.entries(this.state.runs)) {
      for (const workspace of Object.values(run.roundWorkspaces)) {
        if (workspace.closed) continue;
        const streamKey = Object.values(workspace.outbox)[0]?.streamKey;
        if (streamKey !== undefined) streams.push({ runId, roundId: workspace.roundId, streamKey });
      }
    }
    return streams.sort((left, right) => left.streamKey.localeCompare(right.streamKey));
  }

  async markOutboxPublished(input: { runId: string; roundId: number; commandId: string; streamId: string }): Promise<void> {
    await this.durable(async () => {
      const run = this.requireRun(input.runId);
      const outbox = requireWorkspace(run, input.roundId).outbox[input.commandId];
      if (outbox === undefined) throw new SocialDomainError("NOT_FOUND", `unknown Social outbox command: ${input.commandId}`);
      if (outbox.status === "published" || outbox.status === "applied") {
        if (outbox.publishedStreamId !== input.streamId) {
          throw new SocialDomainError("IDEMPOTENCY_CONFLICT", "outbox command was published with a different stream ID");
        }
        return;
      }
      outbox.status = "published";
      outbox.publishedStreamId = input.streamId;
    }, true);
  }

  /** Called by the partition-leased Context worker after Redis delivery. */
  async applyQueuedIntent(input: {
    runId: string;
    roundId: number;
    commandId: string;
    streamId: string;
  }): Promise<SocialIntentRecord> {
    return this.durable(async () => {
      const run = this.requireRun(input.runId);
      const workspace = requireWorkspace(run, input.roundId);
      if (workspace.closed) throw new SocialDomainError("PRECONDITION_FAILED", "Social round is already closed");
      const intent = workspace.intents[input.commandId];
      if (intent === undefined) throw new SocialDomainError("NOT_FOUND", `unknown Social intent: ${input.commandId}`);
      if (intent.status === "applied" || intent.status === "rejected" || intent.status === "discarded") {
        // XADD may have succeeded immediately before a process crash, before
        // its owner outbox could persist the assigned ID. A replay can then
        // create another Stream entry for the same durable command. Command
        // identity, rather than the transport ID, is the idempotency key; the
        // later delivery is acknowledged without changing the applied order.
        return clone(intent);
      }
      if (workspace.lastAppliedStreamId !== undefined && compareStreamIds(input.streamId, workspace.lastAppliedStreamId) <= 0) {
        throw new SocialDomainError("PRECONDITION_FAILED", "Social worker must apply Redis Stream messages in ascending order");
      }
      intent.streamId = input.streamId;
      workspace.lastAppliedStreamId = input.streamId;
      try {
        intent.status = "applied";
        workspace.provisionalSnapshot = materializeWorkspace(run, workspace);
      } catch (error) {
        intent.status = "rejected";
        intent.rejectionReason = error instanceof Error ? error.message : String(error);
        workspace.provisionalSnapshot = materializeWorkspace(run, workspace);
      }
      const outbox = workspace.outbox[input.commandId];
      if (outbox !== undefined) {
        outbox.status = "applied";
        outbox.publishedStreamId = input.streamId;
      }
      return clone(intent);
    }, true);
  }

  /** Excludes final-failed Agent turns and deterministically rebuilds worktree state. */
  async discardTurns(input: { runId: string; roundId: number; turnIds: readonly string[] }): Promise<void> {
    await this.durable(async () => {
      const run = this.requireRun(input.runId);
      const workspace = requireWorkspace(run, input.roundId);
      const excluded = new Set(input.turnIds);
      for (const intent of Object.values(workspace.intents)) {
        if (excluded.has(intent.turnId) && intent.status !== "discarded") intent.status = "discarded";
      }
      workspace.provisionalSnapshot = materializeWorkspace(run, workspace);
    }, true);
  }

  async sealCandidateRevision(input: {
    runId: string;
    roundId: number;
    baseRevision: SocialContextRevision;
    readRevision: SocialContextRevision;
    finalFailedTurnIds: readonly string[];
    mutation: Mutation;
  }): Promise<SocialContextRevision> {
    validateMutation(input.mutation);
    await this.refreshFromStore();
    const run = this.requireRun(input.runId);
    return this.execute(input.mutation, async () => {
      const workspace = requireWorkspace(run, input.roundId);
      if (workspace.baseRevisionRef !== input.baseRevision.ref || workspace.readRevisionRef !== input.readRevision.ref) {
        throw new SocialDomainError("PRECONDITION_FAILED", "candidate revision must seal this round's pinned read set");
      }
      const failedTurns = new Set(input.finalFailedTurnIds);
      for (const intent of Object.values(workspace.intents)) {
        if (failedTurns.has(intent.turnId)) intent.status = "discarded";
      }
      if (failedTurns.size > 0) workspace.provisionalSnapshot = materializeWorkspace(run, workspace);
      const pending = Object.values(workspace.intents).find((intent) => intent.status === "pending");
      if (pending !== undefined) throw new SocialDomainError("PRECONDITION_FAILED", "all Social intents must be consumed before sealing");
      if (workspace.candidateRevisionRef !== undefined) return publicRevision(requireRevision(run, workspace.candidateRevisionRef));
      workspace.closed = true;
      const snapshot = workspace.provisionalSnapshot ?? clone(requireRevision(run, workspace.readRevisionRef).snapshot);
      const candidate = makeRevision({
        runId: input.runId,
        roundId: input.roundId,
        kind: "candidate",
        parentRevisionRef: workspace.baseRevisionRef,
        snapshot,
      });
      run.revisions[candidate.ref] = candidate;
      workspace.candidateRevisionRef = candidate.ref;
      delete workspace.provisionalSnapshot;
      return publicRevision(candidate);
    });
  }

  /** Moves the local Context HEAD only after Experiment has committed its manifest. */
  async commitCandidateRevision(input: {
    runId: string;
    roundId: number;
    candidateRevision: SocialContextRevision;
    mutation: Mutation;
  }): Promise<SocialContextRevision> {
    validateMutation(input.mutation);
    const run = this.requireRun(input.runId);
    const revision = await this.execute(input.mutation, async () => {
      const workspace = requireWorkspace(run, input.roundId);
      if (workspace.candidateRevisionRef !== input.candidateRevision.ref) {
        throw new SocialDomainError("PRECONDITION_FAILED", "only this round's candidate revision may become Social HEAD");
      }
      const candidate = requireRevision(run, input.candidateRevision.ref);
      if (candidate.kind !== "candidate") throw new SocialDomainError("PRECONDITION_FAILED", "Social revision is not a candidate");
      run.revisionHeadRef = candidate.ref;
      materializeCommittedSnapshot(run, candidate.snapshot, input.roundId);
      // The candidate object is immutable.  Global commit moves this Context
      // ref to HEAD; it never rewrites a candidate into another object.
      return publicRevision(candidate);
    });
    await this.syncProjection(run);
    return revision;
  }

  async forkRevision(input: {
    sourceRunId: string;
    targetRunId: string;
    sourceRevision: SocialContextRevision;
    mutation: Mutation;
    feedAlgorithm?: { versionRef: string; config: Record<string, unknown> };
  }): Promise<SocialContextRevision> {
    const source = this.requireRun(input.sourceRunId);
    validateMutation(input.mutation);
    return this.execute(input.mutation, async () => {
      const sourceRevisionHeader = requireCommittedRevision(source, input.sourceRevision.ref);
      if (input.mutation.expectedCheckpointRef !== sourceRevisionHeader.ref) {
        throw new SocialDomainError("PRECONDITION_FAILED", "fork mutation must bind the requested Social revision");
      }
      const sourceRevision = await this.loadRevision(sourceRevisionHeader.ref);
      const existing = this.state.runs[input.targetRunId];
      if (existing !== undefined) return this.currentRevision(input.targetRunId);
      if (input.feedAlgorithm !== undefined) {
        const version = requirePublishedFeedAlgorithm(this.state, input.feedAlgorithm.versionRef);
        validateFeedAlgorithmConfig(version.configSchema, input.feedAlgorithm.config);
      }
      const forkSource = input.feedAlgorithm === undefined
        ? sourceRevision
        : { ...sourceRevision, snapshot: { ...clone(sourceRevision.snapshot), feedAlgorithm: clone(input.feedAlgorithm) } };
      const run = runFromRevision(input.targetRunId, forkSource, source.simulationSeed ?? 0);
      this.state.runs[input.targetRunId] = run;
      return this.currentRevision(input.targetRunId);
    });
  }

  private async snapshotWithRoundExposures(runId: string, roundId: number, sourceRevision: StoredSocialRevision): Promise<SocialRevisionSnapshot> {
    const source = sourceRevision.snapshot;
    if (source.feedAlgorithm === undefined) return snapshotWithBuiltinRoundExposures(runId, roundId, source);
    const version = requirePublishedFeedAlgorithm(this.state, source.feedAlgorithm.versionRef);
    const seed = sha256({ simulationSeed: this.requireRun(runId).simulationSeed ?? 0, roundId, versionRef: version.versionRef, artifactDigest: version.artifactDigest });
    const result = await this.executeFeedAlgorithm({
      version,
      config: source.feedAlgorithm.config,
      seed,
      roundId,
      runId,
      committedHeadRevisionRef: sourceRevision.ref,
      feedSize: source.feedSize,
      actorIds: activeActorIds(source),
    });
    const snapshot = clone(source);
    const expectedActiveActorIds = activeActorIds(snapshot);
    if (result.feeds.length !== expectedActiveActorIds.length) {
      throw new SocialDomainError("INTERNAL", "feed algorithm did not return exactly one ranked feed for every active actor");
    }
    const expectedActorIds = new Set(expectedActiveActorIds);
    const receivedActorIds = new Set<string>();
    for (const feed of result.feeds) {
      if (!expectedActorIds.has(feed.actorId) || receivedActorIds.has(feed.actorId)) {
        throw new SocialDomainError("INTERNAL", `feed algorithm returned an unknown or duplicate actor feed: ${feed.actorId}`);
      }
      receivedActorIds.add(feed.actorId);
      if (feed.postIds.length > snapshot.feedSize) {
        throw new SocialDomainError("INTERNAL", "feed algorithm returned more post IDs than feedSize");
      }
      const uniquePostIds = new Set(feed.postIds);
      if (uniquePostIds.size !== feed.postIds.length) {
        throw new SocialDomainError("INTERNAL", `feed algorithm returned duplicate post IDs for actor: ${feed.actorId}`);
      }
      for (const [index, postId] of feed.postIds.entries()) {
        if (!snapshot.posts[postId]) throw new SocialDomainError("INTERNAL", `feed algorithm returned an unknown post: ${postId}`);
        const key = exposureKey(roundId, feed.actorId, postId);
        snapshot.exposures[key] = {
          exposureId: `exposure:${runId}:${roundId}:${feed.actorId}:${postId}`,
          actorId: feed.actorId,
          postId,
          roundId,
          rank: index + 1,
        };
      }
    }
    return snapshot;
  }

  private async executeFeedAlgorithm(input: {
    version: FeedAlgorithmVersion;
    config: Record<string, unknown>;
    seed: string;
    roundId: number;
    runId: string;
    committedHeadRevisionRef: string;
    feedSize: number;
    actorIds: string[];
  }) {
    if (!isPlainRecord(input.config)) throw invalidArgument("feed algorithm config must be an object", "feedAlgorithm.config");
    validateFeedAlgorithmConfig(input.version.configSchema, input.config);
    const capability = `feed-algorithm-history:${randomUUID()}`;
    const executionId = `feed-algorithm-execution:${sha256({
      runId: input.runId,
      roundId: input.roundId,
      versionRef: input.version.versionRef,
      committedHeadRevisionRef: input.committedHeadRevisionRef,
      seed: input.seed,
    })}`;
    this.state.feedAlgorithmHistoryCapabilities[capability] = {
      capability,
      runId: input.runId,
      committedHeadRevisionRef: input.committedHeadRevisionRef,
      executionId,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    };
    try {
      return await this.feedAlgorithmExecutor.execute({
        source: input.version.source,
        config: clone(input.config),
        seed: input.seed,
        roundId: input.roundId,
        feedSize: input.feedSize,
        actorIds: [...input.actorIds],
        socialHistory: { endpoint: this.feedAlgorithmHistoryEndpoint, capability },
        limits: input.version.limits,
        dependencies: input.version.dependencies,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown runner failure";
      throw new SocialDomainError("INTERNAL", `feed algorithm execution failed: ${message.slice(0, 1_000)}`);
    } finally {
      // Persist only the normalized feed result. A runner credential must not
      // survive either a successful execution or a failed one.
      delete this.state.feedAlgorithmHistoryCapabilities[capability];
    }
  }

  private async execute<T>(mutation: Mutation, operation: () => Promise<T>): Promise<T> {
    return this.serialized(async () => {
      const key = idempotencyKey(mutation);
      const existing = this.state.idempotency[key];
      if (existing !== undefined) {
        if (existing.payloadDigest !== mutation.payloadDigest) {
          throw new SocialDomainError(
            "IDEMPOTENCY_CONFLICT",
            "the same transitionId and stepId were used with a different payloadDigest",
          );
        }
        return clone(existing.result) as T;
      }
      try {
        const result = await operation();
        const record: IdempotencyRecord = { payloadDigest: mutation.payloadDigest, result: clone(result) };
        this.state.idempotency[key] = record;
        await this.stateStore.save(this.state);
        return clone(result);
      } catch (error) {
        await this.restoreDurableState();
        throw error;
      }
    });
  }

  /** A Context-owned transaction without an Experiment mutation header. */
  /** Refreshes the worker/API cache from owner state without exposing it. */
  async refreshFromStore(): Promise<void> {
    await this.serialized(() => this.restoreDurableState());
  }

  private async durable<T>(operation: () => Promise<T> | T, refresh = false): Promise<T> {
    return this.serialized(async () => {
      try {
        if (refresh) await this.restoreDurableState();
        const result = await operation();
        await this.stateStore.save(this.state);
        return clone(result);
      } catch (error) {
        await this.restoreDurableState();
        throw error;
      }
    });
  }

  private async restoreDurableState(): Promise<void> {
    const restored = (await this.stateStore.load()) ?? emptySocialState();
    restored.networkRegistry ??= { drafts: {}, versions: {} };
    restored.networkRegistry.tombstones ??= [];
    restored.algorithmRegistry.tombstones ??= [];
    validateState(restored);
    this.state = restored;
  }

  private async deleteAsset(
    assetKind: string,
    target: AssetDeleteTarget,
    assetId: string,
    idempotencyKey: string,
    expectedRevision: number | undefined,
    registry: { tombstones?: AssetTombstone[] },
    record: unknown,
  ): Promise<AssetDeletionResult> {
    return this.serialized(async () => {
      const existing = (registry.tombstones ?? []).find((item) => item.target === target && item.assetId === assetId);
      if (existing) return { status: "already-deleted", replayed: existing.idempotencyKey === idempotencyKey, tombstone: clone(existing) };
      if (!record) throw new SocialDomainError("NOT_FOUND", `${assetKind} ${target} does not exist`);
      if (target === "draft" && (record as { revision?: unknown }).revision !== expectedRevision) {
        throw new SocialDomainError("PRECONDITION_FAILED", `${assetKind} draft has changed; reload before deleting`);
      }
      const tombstone: AssetTombstone = {
        assetKind,
        assetId,
        target,
        deletedAt: new Date().toISOString(),
        idempotencyKey,
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      };
      (registry.tombstones ??= []).push(tombstone);
      await this.stateStore.save(this.state);
      return { status: "deleted", replayed: false, tombstone: clone(tombstone) };
    });
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private requireRun(runId: string): SocialRunState {
    const run = this.state.runs[runId];
    if (run === undefined) {
      throw new SocialDomainError("NOT_FOUND", `unknown Social Environment run: ${runId}`);
    }
    return run;
  }

  private requireExpectedCheckpoint(run: SocialRunState, mutation: Mutation): void {
    const committed = run.sealed[String(run.publishedRound)];
    if (committed === undefined || mutation.expectedCheckpointRef !== committed.ref) {
      throw new SocialDomainError(
        "PRECONDITION_FAILED",
        "expectedCheckpointRef is not this run's committed checkpoint",
      );
    }
  }

  private requireActiveRound(run: SocialRunState, roundId: number): void {
    if (!Number.isInteger(roundId) || roundId !== run.publishedRound + 1) {
      throw new SocialDomainError(
        "PRECONDITION_FAILED",
        "Social commands may only affect the next unpublished round",
      );
    }
    if (run.sealed[String(roundId)] !== undefined) {
      throw new SocialDomainError("PRECONDITION_FAILED", "a sealed Social round cannot be changed");
    }
  }

  private requireCommittedCheckpoint(
    run: SocialRunState,
    roundId: number,
    committedCheckpointRef: string,
  ): void {
    const checkpoint = run.sealed[String(roundId)];
    if (checkpoint === undefined || checkpoint.ref !== committedCheckpointRef) {
      throw new SocialDomainError(
        "PRECONDITION_FAILED",
        "Social export requires its committed checkpoint",
      );
    }
    if (roundId > run.publishedRound) {
      throw new SocialDomainError(
        "PRECONDITION_FAILED",
        "pending or sealed Social facts are not queryable",
      );
    }
  }

  private validateActionCounts(run: SocialRunState, actions: readonly SocialAction[]): void {
    const counts = new Map<string, number>();
    for (const action of actions) {
      const next = (counts.get(action.actorId) ?? 0) + 1;
      counts.set(action.actorId, next);
      const limit = run.actors[action.actorId]?.maximumActionsPerRound;
      if (limit !== undefined && next > limit) {
        throw new SocialDomainError(
          "PRECONDITION_FAILED",
          `actor ${action.actorId} exceeds maximum actions per round`,
        );
      }
    }
  }

  private validateRelationshipAction(run: SocialRunState, action: RelationshipAction): void {
    if (run.actors[action.targetActorId] === undefined) {
      throw new SocialDomainError("NOT_FOUND", `unknown relationship target: ${action.targetActorId}`);
    }
    if (action.targetActorId === action.actorId) {
      throw invalidArgument("an actor cannot change a relationship with itself", "actions.targetActorId");
    }
  }

  private hasActionId(run: SocialRunState, actionId: string): boolean {
    return run.processedActionIds[actionId] !== undefined;
  }

  private postExists(run: SocialRunState, postId: string, currentPosts: readonly SocialPost[]): boolean {
    return (
      run.publishedPosts[postId] !== undefined ||
      currentPosts.some((post) => post.postId === postId) ||
      Object.values(run.pendingPosts).flat().some((post) => post.postId === postId)
    );
  }

  private async rebuildProjection(): Promise<void> {
    if (this.projection === undefined) return;
    for (const run of Object.values(this.state.runs)) await this.syncProjection(run);
  }

  private async syncProjection(run: SocialRunState): Promise<void> {
    if (this.projection === undefined) return;
    const committedRound = run.publishedRound;
    const graph: CommittedSocialGraph = {
      runId: run.runId,
      actors: Object.values(run.actors).sort((left, right) => left.actorId.localeCompare(right.actorId)),
      posts: Object.values(run.publishedPosts).filter((post) => post.roundId <= committedRound).sort(comparePosts),
      engagements: Object.values(run.publishedEngagements)
        .filter((engagement) => engagement.roundId <= committedRound)
        .sort((left, right) => left.engagementId.localeCompare(right.engagementId)),
      exposures: Object.values(run.exposures)
        .filter((exposure) => exposure.roundId <= committedRound)
        .sort((left, right) => left.exposureId.localeCompare(right.exposureId)),
      relationships: Object.values(run.relationships).sort(compareRelationships),
    };
    await this.projection.replaceCommitted(clone(graph));
  }
}

function validateMutation(mutation: Mutation, initialization = false): void {
  requireText(mutation.transitionId, "mutation.transitionId");
  requireText(mutation.stepId, "mutation.stepId");
  requireText(mutation.payloadDigest, "mutation.payloadDigest");
  if (!initialization) requireText(mutation.expectedCheckpointRef, "mutation.expectedCheckpointRef");
  if (initialization && mutation.expectedCheckpointRef !== "") {
    throw invalidArgument("initialization expectedCheckpointRef must be empty", "mutation.expectedCheckpointRef");
  }
}

function requireText(value: string, field: string): void {
  if (value.trim().length === 0) throw invalidArgument(`${field} must not be empty`, field);
}

function appendRoundValues<T>(target: Record<string, T[]>, roundId: number, values: readonly T[]): void {
  if (values.length === 0) return;
  const key = String(roundId);
  target[key] = [...(target[key] ?? []), ...values];
}

function checkpointFor(run: SocialRunState, roundId: number): SocialCheckpoint {
  const digest = sha256({
    runId: run.runId,
    roundId,
    posts: (run.pendingPosts[String(roundId)] ?? []).map((post) => post.postId),
    engagements: (run.pendingEngagements[String(roundId)] ?? []).map((item) => item.engagementId),
    relationshipChanges: (run.pendingRelationshipChanges[String(roundId)] ?? []).map((item) => item.actionId),
    exposures: Object.values(run.exposures)
      .filter((item) => item.roundId <= roundId)
      .map((item) => item.exposureId)
      .sort(),
  });
  return {
    ref: `${SOCIAL_CHECKPOINT_PREFIX}:${run.runId}:round:${roundId}`,
    runId: run.runId,
    roundId,
    digest,
  };
}

function rankedPosts(run: SocialRunState): Array<{ post: SocialPost; priority: number }> {
  const engagementCount = new Map<string, number>();
  for (const engagement of Object.values(run.publishedEngagements)) {
    engagementCount.set(engagement.targetPostId, (engagementCount.get(engagement.targetPostId) ?? 0) + 1);
  }
  return Object.values(run.publishedPosts)
    .map((post) => ({
      post,
      priority:
        post.roundId * run.ranking.recencyWeight +
        (engagementCount.get(post.postId) ?? 0) * run.ranking.engagementWeight,
    }))
    .sort(
      (left, right) =>
        right.priority - left.priority ||
        right.post.roundId - left.post.roundId ||
        left.post.postId.localeCompare(right.post.postId),
    )
    .slice(0, run.feedSize);
}

function comparePosts(left: SocialPost, right: SocialPost): number {
  return left.roundId - right.roundId || left.postId.localeCompare(right.postId);
}

function compareRelationships(left: Relationship, right: Relationship): number {
  return left.actorId.localeCompare(right.actorId) || left.targetActorId.localeCompare(right.targetActorId);
}

function engagementExists(
  run: SocialRunState,
  action: Extract<SocialAction, { kind: "engagement" }>,
  current: readonly Engagement[],
): boolean {
  return [...Object.values(run.publishedEngagements), ...Object.values(run.pendingEngagements).flat(), ...current]
    .some((engagement) =>
      engagement.actorId === action.actorId
      && engagement.targetPostId === action.targetPostId
      && engagement.kind === action.engagementKind);
}

function audienceReception(
  posts: readonly SocialPost[],
  exposures: readonly Exposure[],
  engagements: readonly Engagement[],
): AudienceReception[] {
  const reception = new Map<string, AudienceReception>();
  for (const post of posts) {
    reception.set(post.postId, {
      postId: post.postId,
      exposureCount: 0,
      likeCount: 0,
      repostCount: 0,
      replyCount: 0,
    });
  }
  for (const exposure of exposures) {
    const item = reception.get(exposure.postId);
    if (item !== undefined) item.exposureCount += 1;
  }
  for (const engagement of engagements) {
    const item = reception.get(engagement.targetPostId);
    if (item === undefined) continue;
    if (engagement.kind === "like") item.likeCount += 1;
    if (engagement.kind === "repost") item.repostCount += 1;
    if (engagement.kind === "reply") item.replyCount += 1;
  }
  return [...reception.values()].sort((left, right) => left.postId.localeCompare(right.postId));
}

function forkRun(source: SocialRunState, targetRunId: string, roundId: number): SocialRunState {
  const publishedRelationshipChanges = Object.fromEntries(
    Object.entries(source.publishedRelationshipChanges).filter(([, item]) => item.roundId <= roundId),
  );
  const relationships: Record<string, Relationship> = clone(source.initialRelationships);
  for (const change of Object.values(publishedRelationshipChanges).sort(
    (left, right) => left.roundId - right.roundId || left.actionId.localeCompare(right.actionId),
  )) {
    const key = relationshipKey(change.actorId, change.targetActorId);
    if (change.kind === "follow") {
      relationships[key] = { actorId: change.actorId, targetActorId: change.targetActorId };
    } else {
      delete relationships[key];
    }
  }
  const run: SocialRunState = {
    runId: targetRunId,
    ...(source.exposurePolicy === undefined ? {} : { exposurePolicy: source.exposurePolicy }),
    actors: clone(source.actors),
    feedSize: source.feedSize,
    ranking: clone(source.ranking),
    audienceReception: clone(source.audienceReception),
    publishedPosts: Object.fromEntries(
      Object.entries(source.publishedPosts).filter(([, post]) => post.roundId <= roundId),
    ),
    pendingPosts: {},
    publishedEngagements: Object.fromEntries(
      Object.entries(source.publishedEngagements).filter(([, item]) => item.roundId <= roundId),
    ),
    pendingEngagements: {},
    initialRelationships: clone(source.initialRelationships),
    relationships,
    publishedRelationshipChanges,
    pendingRelationshipChanges: {},
    exposures: Object.fromEntries(
      Object.entries(source.exposures).filter(([, item]) => item.roundId <= roundId),
    ),
    processedActionIds: Object.fromEntries(
      Object.entries(source.processedActionIds).filter(([, actionRound]) => actionRound <= roundId),
    ),
    sealed: {},
    publishedRound: roundId,
    revisions: {},
    revisionHeadRef: "",
    roundWorkspaces: {},
  };
  run.sealed[String(roundId)] = checkpointFor(run, roundId);
  return run;
}

function relationshipKey(actorId: string, targetActorId: string): string {
  return JSON.stringify([actorId, targetActorId]);
}

function exposureKey(roundId: number, actorId: string, postId: string): string {
  return JSON.stringify([roundId, actorId, postId]);
}

function idempotencyKey(mutation: Mutation): string {
  // This is persisted as a JSON object key in Postgres. JSONB rejects NUL
  // escape sequences, so encode the tuple rather than using a NUL delimiter.
  return JSON.stringify([mutation.transitionId, mutation.stepId]);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function ensureRevisionState(run: SocialRunState): void {
  if (run.revisionHeadRef && run.revisions[run.revisionHeadRef] !== undefined) return;
  throw new SocialDomainError("INTERNAL", `Social revision state is invalid for run ${run.runId}`);
}

/** Called only while constructing a new run; persisted v1 rows never enter it. */
function initializeRevisionState(run: SocialRunState): void {
  if (run.revisionHeadRef || Object.keys(run.revisions).length > 0) {
    throw new SocialDomainError("INTERNAL", `Social revision state already exists for run ${run.runId}`);
  }
  const snapshot = snapshotForRun(run);
  const revision = makeRevision({
    runId: run.runId,
    roundId: run.publishedRound,
    kind: run.publishedRound === 0 ? "initial" : "committed",
    snapshot,
  });
  run.revisions[revision.ref] = revision;
  run.revisionHeadRef = revision.ref;
}

function currentRevisionFor(run: SocialRunState): StoredSocialRevision {
  ensureRevisionState(run);
  return requireRevision(run, run.revisionHeadRef);
}

function requireRevision(run: SocialRunState, revisionRef: string): StoredSocialRevision {
  ensureRevisionState(run);
  const revision = run.revisions[revisionRef];
  if (revision === undefined) throw new SocialDomainError("NOT_FOUND", `unknown Social revision: ${revisionRef}`);
  return revision;
}

function requireCommittedRevision(run: SocialRunState, revisionRef: string): StoredSocialRevision {
  requireCommittedRevisionRef(run, revisionRef);
  return requireRevision(run, revisionRef);
}

function requireCommittedRevisionRef(run: SocialRunState, revisionRef: string): void {
  let cursor = currentRevisionFor(run);
  const visited = new Set<string>();
  while (!visited.has(cursor.ref)) {
    visited.add(cursor.ref);
    if (cursor.ref === revisionRef) return;
    if (cursor.parentRevisionRef === undefined) break;
    const parent = run.revisions[cursor.parentRevisionRef];
    if (parent === undefined) break;
    cursor = parent;
  }
  throw new SocialDomainError("PRECONDITION_FAILED", "Social export requires a committed Context revision");
}

function factsFromRevision(revision: StoredSocialRevision): ExportedSocialFacts {
  const snapshot = revision.snapshot;
  const posts = Object.values(snapshot.posts).sort(comparePosts);
  const exposures = Object.values(snapshot.exposures).sort((left, right) => left.exposureId.localeCompare(right.exposureId));
  const engagements = Object.values(snapshot.engagements).sort((left, right) => left.engagementId.localeCompare(right.engagementId));
  const relationships = Object.values(snapshot.relationships).sort(compareRelationships);
  return clone({
    posts,
    exposures,
    engagements,
    relationships,
    summary: {
      roundId: revision.roundId,
      postCount: posts.length,
      exposureCount: exposures.length,
      engagementCount: engagements.length,
      audienceReception: audienceReception(posts, exposures, engagements),
    },
  });
}

function publicRevision(revision: StoredSocialRevision): SocialContextRevision {
  const { snapshot: _snapshot, kind: _kind, createdAt: _createdAt, ...publicValue } = revision;
  return clone(publicValue);
}

function makeRevision(input: {
  runId: string;
  roundId: number;
  kind: StoredSocialRevision["kind"];
  snapshot: SocialRevisionSnapshot;
  parentRevisionRef?: string;
  sourceManifestRef?: string;
}): StoredSocialRevision {
  const snapshot = clone(input.snapshot);
  const digest = sha256({
    context: "social_environment",
    runId: input.runId,
    roundId: input.roundId,
    kind: input.kind,
    parentRevisionRef: input.parentRevisionRef,
    snapshot,
  });
  return {
    ref: `revision:social_environment:${input.runId}:${input.kind}:${input.roundId}:${digest.slice(0, 16)}`,
    context: "social_environment",
    runId: input.runId,
    roundId: input.roundId,
    digest,
    ...(input.parentRevisionRef === undefined ? {} : { parentRevisionRef: input.parentRevisionRef }),
    ...(input.sourceManifestRef === undefined ? {} : { sourceManifestRef: input.sourceManifestRef }),
    kind: input.kind,
    snapshot,
    createdAt: new Date().toISOString(),
  };
}

function snapshotForRun(run: SocialRunState): SocialRevisionSnapshot {
  const publishedRound = run.publishedRound;
  return {
    exposurePolicy: run.exposurePolicy ?? "recommendation_only",
    actors: clone(run.actors),
    feedSize: run.feedSize,
    ranking: clone(run.ranking),
    ...(run.feedAlgorithm === undefined ? {} : { feedAlgorithm: clone(run.feedAlgorithm) }),
    audienceReception: clone(run.audienceReception),
    posts: Object.fromEntries(Object.entries(run.publishedPosts).filter(([, post]) => post.roundId <= publishedRound)),
    engagements: Object.fromEntries(
      Object.entries(run.publishedEngagements).filter(([, engagement]) => engagement.roundId <= publishedRound),
    ),
    initialRelationships: clone(run.initialRelationships),
    relationships: clone(run.relationships),
    exposures: Object.fromEntries(Object.entries(run.exposures).filter(([, exposure]) => exposure.roundId <= publishedRound)),
    processedActionIds: Object.fromEntries(
      Object.entries(run.processedActionIds).filter(([, actionRound]) => actionRound <= publishedRound),
    ),
  };
}

function snapshotWithBuiltinRoundExposures(
  runId: string,
  roundId: number,
  source: SocialRevisionSnapshot,
): SocialRevisionSnapshot {
  const snapshot = clone(source);
  const candidates = rankedSnapshotPosts(snapshot);
  for (const actor of Object.values(snapshot.actors)) {
    for (const [index, candidate] of candidates.entries()) {
      const key = exposureKey(roundId, actor.actorId, candidate.post.postId);
      snapshot.exposures[key] = {
        exposureId: `exposure:${runId}:${roundId}:${actor.actorId}:${candidate.post.postId}`,
        actorId: actor.actorId,
        postId: candidate.post.postId,
        roundId,
        rank: index + 1,
      };
    }
  }
  return snapshot;
}

function rankedSnapshotPosts(snapshot: SocialRevisionSnapshot): Array<{ post: SocialPost; priority: number }> {
  const engagementCount = new Map<string, number>();
  for (const engagement of Object.values(snapshot.engagements)) {
    engagementCount.set(engagement.targetPostId, (engagementCount.get(engagement.targetPostId) ?? 0) + 1);
  }
  return Object.values(snapshot.posts)
    .map((post) => ({
      post,
      priority:
        post.roundId * snapshot.ranking.recencyWeight +
        (engagementCount.get(post.postId) ?? 0) * snapshot.ranking.engagementWeight,
    }))
    .sort((left, right) =>
      right.priority - left.priority ||
      right.post.roundId - left.post.roundId ||
      left.post.postId.localeCompare(right.post.postId),
    )
    .slice(0, snapshot.feedSize);
}

function requireWorkspace(run: SocialRunState, roundId: number): SocialRoundWorkspace {
  ensureRevisionState(run);
  const workspace = run.roundWorkspaces[String(roundId)];
  if (workspace === undefined) {
    throw new SocialDomainError("PRECONDITION_FAILED", `Social round ${roundId} has no frozen read revision`);
  }
  return workspace;
}

function materializeWorkspace(run: SocialRunState, workspace: SocialRoundWorkspace): SocialRevisionSnapshot {
  const base = clone(requireRevision(run, workspace.readRevisionRef).snapshot);
  const intents = orderedWorkspaceIntents(workspace).filter((intent) => intent.status === "applied");
  for (const intent of intents) applyActionToSnapshot(base, workspace.roundId, intent.action);
  return base;
}

function orderedWorkspaceIntents(workspace: SocialRoundWorkspace): SocialIntentRecord[] {
  return Object.values(workspace.intents).sort((left, right) => {
    const leftStream = left.streamId ?? workspace.outbox[left.commandId]?.publishedStreamId;
    const rightStream = right.streamId ?? workspace.outbox[right.commandId]?.publishedStreamId;
    if (leftStream !== undefined && rightStream !== undefined) {
      return compareStreamIds(leftStream, rightStream) || left.commandId.localeCompare(right.commandId);
    }
    if (leftStream !== undefined) return -1;
    if (rightStream !== undefined) return 1;
    return left.createdAt.localeCompare(right.createdAt) || left.commandId.localeCompare(right.commandId);
  });
}

function validateQueuedActionShape(run: SocialRunState, action: SocialAction): void {
  requireText(action.actionId, "action.actionId");
  const actor = run.actors[action.actorId];
  if (actor === undefined) throw new SocialDomainError("NOT_FOUND", `unknown social actor: ${action.actorId}`);
  if (action.kind === "post") {
    requireText(action.postId, "action.postId");
    requireText(action.content, "action.content");
  }
  if (action.kind === "engagement") {
    requireText(action.targetPostId, "action.targetPostId");
    if (action.engagementKind === "reply") requireText(action.replyBody ?? "", "action.replyBody");
    if (action.derivedPostId !== undefined) {
      if (action.engagementKind === "like") {
        throw invalidArgument("a like cannot create a Social post", "action.derivedPostId");
      }
      requireText(action.derivedPostId, "action.derivedPostId");
    }
  }
  if (action.kind === "relationship") {
    if (run.actors[action.targetActorId] === undefined) {
      throw new SocialDomainError("NOT_FOUND", `unknown relationship target: ${action.targetActorId}`);
    }
    if (action.actorId === action.targetActorId) {
      throw invalidArgument("an actor cannot change a relationship with itself", "action.targetActorId");
    }
  }
}

function applyActionToSnapshot(snapshot: SocialRevisionSnapshot, roundId: number, action: SocialAction): void {
  const actor = snapshot.actors[action.actorId];
  if (actor === undefined) throw new SocialDomainError("NOT_FOUND", `unknown social actor: ${action.actorId}`);
  if (snapshot.processedActionIds[action.actionId] !== undefined) {
    throw new SocialDomainError("PRECONDITION_FAILED", `duplicate Social action ID: ${action.actionId}`);
  }
  if (action.kind === "post") {
    if (snapshot.posts[action.postId] !== undefined) {
      throw new SocialDomainError("PRECONDITION_FAILED", "social post IDs must be unique");
    }
    snapshot.posts[action.postId] = {
      postId: action.postId,
      authorId: action.actorId,
      content: action.content,
      headline: action.headline?.trim() ?? "",
      roundId,
    };
  } else if (action.kind === "engagement") {
    if (snapshot.posts[action.targetPostId] === undefined) {
      throw new SocialDomainError("PRECONDITION_FAILED", "engagement target is not present in the pinned Social revision");
    }
    const duplicate = (action.engagementKind === "like" || action.engagementKind === "repost")
      && Object.values(snapshot.engagements).some((engagement) =>
        engagement.actorId === action.actorId
        && engagement.targetPostId === action.targetPostId
        && engagement.kind === action.engagementKind);
    if (duplicate) {
      snapshot.processedActionIds[action.actionId] = roundId;
      return;
    }
    if (action.derivedPostId !== undefined) {
      if (snapshot.posts[action.derivedPostId] !== undefined) {
        throw new SocialDomainError("PRECONDITION_FAILED", "social post IDs must be unique");
      }
      snapshot.posts[action.derivedPostId] = {
        postId: action.derivedPostId,
        authorId: action.actorId,
        content: action.derivedContent ?? action.replyBody ?? "",
        headline: action.derivedHeadline?.trim() ?? "",
        roundId,
        postType: action.engagementKind === "repost" ? "repost" : "reply",
        parentPostId: action.targetPostId,
      };
    }
    snapshot.engagements[`engagement:${action.actionId}`] = {
      engagementId: `engagement:${action.actionId}`,
      actorId: action.actorId,
      targetPostId: action.targetPostId,
      kind: action.engagementKind,
      ...(action.replyBody === undefined ? {} : { replyBody: action.replyBody }),
      ...(action.derivedPostId === undefined ? {} : { derivedPostId: action.derivedPostId }),
      roundId,
    };
  } else {
    if (snapshot.actors[action.targetActorId] === undefined) {
      throw new SocialDomainError("NOT_FOUND", `unknown relationship target: ${action.targetActorId}`);
    }
    const key = relationshipKey(action.actorId, action.targetActorId);
    if (action.relationshipKind === "follow") {
      snapshot.relationships[key] = { actorId: action.actorId, targetActorId: action.targetActorId };
    } else {
      delete snapshot.relationships[key];
    }
  }
  snapshot.processedActionIds[action.actionId] = roundId;
}

function materializeCommittedSnapshot(run: SocialRunState, snapshot: SocialRevisionSnapshot, roundId: number): void {
  run.exposurePolicy = snapshot.exposurePolicy;
  run.actors = clone(snapshot.actors);
  run.feedSize = snapshot.feedSize;
  run.ranking = clone(snapshot.ranking);
  if (snapshot.feedAlgorithm === undefined) delete run.feedAlgorithm;
  else run.feedAlgorithm = clone(snapshot.feedAlgorithm);
  run.audienceReception = clone(snapshot.audienceReception);
  run.publishedPosts = clone(snapshot.posts);
  run.pendingPosts = {};
  run.publishedEngagements = clone(snapshot.engagements);
  run.pendingEngagements = {};
  run.initialRelationships = clone(snapshot.initialRelationships);
  run.relationships = clone(snapshot.relationships);
  run.pendingRelationshipChanges = {};
  run.exposures = clone(snapshot.exposures);
  run.processedActionIds = clone(snapshot.processedActionIds);
  run.publishedRound = roundId;
  run.sealed[String(roundId)] = checkpointFor(run, roundId);
}

function commitLegacyRevision(run: SocialRunState, roundId: number): void {
  const parent = currentRevisionFor(run);
  const revision = makeRevision({
    runId: run.runId,
    roundId,
    kind: "committed",
    parentRevisionRef: parent.ref,
    snapshot: snapshotForRun(run),
  });
  run.revisions[revision.ref] = revision;
  run.revisionHeadRef = revision.ref;
}

function runFromRevision(targetRunId: string, source: StoredSocialRevision, simulationSeed = 0): SocialRunState {
  const snapshot = clone(source.snapshot);
  const run: SocialRunState = {
    runId: targetRunId,
    simulationSeed,
    exposurePolicy: snapshot.exposurePolicy,
    actors: snapshot.actors,
    feedSize: snapshot.feedSize,
    ranking: snapshot.ranking,
    ...(snapshot.feedAlgorithm === undefined ? {} : { feedAlgorithm: clone(snapshot.feedAlgorithm) }),
    audienceReception: snapshot.audienceReception,
    publishedPosts: snapshot.posts,
    pendingPosts: {},
    publishedEngagements: snapshot.engagements,
    pendingEngagements: {},
    initialRelationships: snapshot.initialRelationships,
    relationships: snapshot.relationships,
    publishedRelationshipChanges: {},
    pendingRelationshipChanges: {},
    exposures: snapshot.exposures,
    processedActionIds: snapshot.processedActionIds,
    sealed: {},
    publishedRound: source.roundId,
    revisions: {},
    revisionHeadRef: "",
    roundWorkspaces: {},
  };
  run.sealed[String(source.roundId)] = checkpointFor(run, source.roundId);
  const forkRevision = makeRevision({
    runId: targetRunId,
    roundId: source.roundId,
    kind: "committed",
    parentRevisionRef: source.ref,
    snapshot,
  });
  run.revisions[forkRevision.ref] = forkRevision;
  run.revisionHeadRef = forkRevision.ref;
  return run;
}

function activeActorIds(snapshot: SocialRevisionSnapshot): string[] {
  return Object.values(snapshot.actors)
    .map((actor) => actor.actorId)
    .sort();
}

function findRevisionByRef(state: SocialState, revisionRef: string): StoredSocialRevision | undefined {
  for (const run of Object.values(state.runs)) {
    const revision = run.revisions[revisionRef];
    if (revision !== undefined) return revision;
  }
  return undefined;
}

/** A committed lineage may cross the source-run boundary of a fork. */
function committedRevisionLineage(state: SocialState, headRevisionRef: string): StoredSocialRevision[] {
  const lineage: StoredSocialRevision[] = [];
  const seen = new Set<string>();
  let cursor = findRevisionByRef(state, headRevisionRef);
  while (cursor !== undefined && !seen.has(cursor.ref)) {
    seen.add(cursor.ref);
    lineage.push(cursor);
    cursor = cursor.parentRevisionRef === undefined ? undefined : findRevisionByRef(state, cursor.parentRevisionRef);
  }
  return lineage;
}

function isCommittedRevision(state: SocialState, run: SocialRunState, revisionRef: string): boolean {
  return committedRevisionLineage(state, run.revisionHeadRef).some((revision) => revision.ref === revisionRef);
}

async function committedSocialHistoryRecords(
  service: SocialEnvironmentService,
  runId: string,
  headRevisionRef: string,
): Promise<Array<{ roundId: number; snapshot: SocialRevisionSnapshot }>> {
  const head = await service.loadRevision(headRevisionRef);
  if (head === undefined || head.runId !== runId) {
    throw new SocialDomainError("PRECONDITION_FAILED", "Social history head does not belong to this run");
  }
  // Forks preserve the source revision as parent at the same round. The
  // child revision therefore wins for that round while earlier history stays
  // available in ascending committed-lineage order.
  const byRound = new Map<number, { roundId: number; snapshot: SocialRevisionSnapshot }>();
  const lineage: StoredSocialRevision[] = [];
  const seen = new Set<string>();
  let cursor: StoredSocialRevision | undefined = head;
  while (cursor !== undefined && !seen.has(cursor.ref)) {
    seen.add(cursor.ref);
    lineage.push(cursor);
    cursor = cursor.parentRevisionRef === undefined ? undefined : await service.loadRevision(cursor.parentRevisionRef);
  }
  for (const revision of lineage.reverse()) {
    byRound.set(revision.roundId, { roundId: revision.roundId, snapshot: clone(revision.snapshot) });
  }
  return [...byRound.values()].sort((left, right) => left.roundId - right.roundId);
}

function parseFeedAlgorithmHistoryCursor(value: string | undefined): number {
  if (value === undefined) return 0;
  if (!/^\d+$/.test(value)) throw invalidArgument("feed algorithm history cursor is invalid", "cursor");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw invalidArgument("feed algorithm history cursor is invalid", "cursor");
  }
  return parsed;
}

function compareStreamIds(left: string, right: string): number {
  const parse = (value: string): [bigint, bigint] | undefined => {
    const match = /^(\d+)-(\d+)$/.exec(value);
    return match === null ? undefined : [BigInt(match[1]!), BigInt(match[2]!)];
  };
  const a = parse(left);
  const b = parse(right);
  if (a !== undefined && b !== undefined) return a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1;
  return left.localeCompare(right);
}

function validateState(state: SocialState): void {
  if (
    state.version !== 2 ||
    typeof state.runs !== "object" ||
    state.runs === null ||
    typeof state.idempotency !== "object" ||
    state.idempotency === null ||
    typeof state.algorithmRegistry !== "object" ||
    state.algorithmRegistry === null || typeof state.networkRegistry !== "object" || state.networkRegistry === null ||
    typeof state.feedAlgorithmHistoryCapabilities !== "object" ||
    state.feedAlgorithmHistoryCapabilities === null
  ) {
    throw new SocialDomainError("INTERNAL", "Social Environment state snapshot is invalid");
  }
  for (const [runId, run] of Object.entries(state.runs)) {
    if (
      run === null ||
      typeof run.revisions !== "object" ||
      run.revisions === null ||
      typeof run.roundWorkspaces !== "object" ||
      run.roundWorkspaces === null ||
      typeof run.revisionHeadRef !== "string" ||
      !run.revisions[run.revisionHeadRef] ||
      (run.mcp !== undefined && (!Array.isArray(run.mcp.principals) || !Array.isArray(run.mcp.activeScopes)))
    ) {
      throw new SocialDomainError("INTERNAL", `Social Environment state snapshot is invalid for run ${runId}`);
    }
    for (const principal of run.mcp?.principals ?? []) {
      if (
        typeof principal !== "object" ||
        principal === null ||
        typeof principal.principalId !== "string" ||
        typeof principal.agentId !== "string" ||
        typeof principal.actorId !== "string" ||
        (principal.legacyFullAccess === true) === (principal.permissions !== undefined)
      ) {
        throw new SocialDomainError("INTERNAL", `Social Environment MCP principal snapshot is invalid for run ${runId}`);
      }
      if (principal.permissions !== undefined) {
        const parsed = socialMcpPermissionsSchema.safeParse(principal.permissions);
        if (!parsed.success) {
          throw new SocialDomainError("INTERNAL", `Social Environment MCP permissions snapshot is invalid for run ${runId}`);
        }
      }
    }
  }
}

function isDeleted(tombstones: readonly AssetTombstone[], target: AssetDeleteTarget, assetId: string) {
  return tombstones.some((item) => item.target === target && item.assetId === assetId);
}

function migrateLegacyMcpPrincipals(state: SocialState): boolean {
  let migrated = false;
  for (const run of Object.values(state.runs)) {
    if (!Array.isArray(run.mcp?.principals)) continue;
    for (const principal of run.mcp.principals) {
      if (typeof principal !== "object" || principal === null) continue;
      if (principal.permissions === undefined && principal.legacyFullAccess !== true) {
        principal.legacyFullAccess = true;
        migrated = true;
      }
    }
  }
  return migrated;
}

function normalizeSocialMcpPermissions(permissions: SocialMcpPermissions | undefined): SocialMcpPermissions {
  const parsed = socialMcpPermissionsSchema.safeParse(permissions);
  if (!parsed.success) {
    throw invalidArgument("Social MCP permissions are invalid", "agents.permissions");
  }
  return {
    tools: [...new Set(parsed.data.tools)].sort(),
    resources: [...new Set(parsed.data.resources)].sort(),
  };
}

function samePermissions(left: SocialMcpPermissions | undefined, right: SocialMcpPermissions): boolean {
  if (left === undefined) return false;
  return JSON.stringify(normalizeSocialMcpPermissions(left)) === JSON.stringify(normalizeSocialMcpPermissions(right));
}

function fullSocialMcpPermissions(): SocialMcpPermissions {
  return {
    tools: [
      "social.create_post",
      "social.engage",
      "social.follow",
      "social.get_feed",
      "social.get_post",
      "social.get_profile",
      "social.get_notifications",
      "social.like_post",
      "social.list_engagements",
      "social.list_posts",
      "social.list_relationships",
      "social.reply_to_post",
      "social.repost_post",
      "social.search_posts",
      "social.unfollow",
    ],
    resources: ["social.feed", "social.posts", "social.profile"],
  };
}

function ensureAlgorithmRegistry(state: SocialState) {
  return state.algorithmRegistry;
}

function requireDraft(state: SocialState, algorithmId: string): FeedAlgorithmDraft {
  const draft = ensureAlgorithmRegistry(state).drafts[algorithmId];
  if (!draft) throw new SocialDomainError("NOT_FOUND", `feed algorithm draft not found: ${algorithmId}`);
  return draft;
}

function requirePublishedFeedAlgorithm(state: SocialState, versionRef: string): FeedAlgorithmVersion {
  const version = ensureAlgorithmRegistry(state).versions[versionRef];
  if (!version) throw new SocialDomainError("NOT_FOUND", `published feed algorithm not found: ${versionRef}`);
  return version;
}

function normalizeFeedAlgorithmLimits(limits: FeedAlgorithmLimits | undefined): FeedAlgorithmLimits {
  const value = limits ?? DEFAULT_FEED_ALGORITHM_LIMITS;
  if (!Number.isInteger(value.maxRuntimeMs) || value.maxRuntimeMs < 1 || value.maxRuntimeMs > 60_000) {
    throw invalidArgument("maxRuntimeMs must be an integer between 1 and 60000", "limits.maxRuntimeMs");
  }
  if (!Number.isInteger(value.maxMemoryMb) || value.maxMemoryMb < 64 || value.maxMemoryMb > 1_024) {
    throw invalidArgument("maxMemoryMb must be an integer between 64 and 1024", "limits.maxMemoryMb");
  }
  return { maxRuntimeMs: value.maxRuntimeMs, maxMemoryMb: value.maxMemoryMb };
}

function normalizeDependencies(dependencies: readonly string[] | undefined): string[] {
  const supported = new Set(["numpy", "networkx", "scipy", "pandas", "scikit-learn"]);
  const normalized = [...new Set((dependencies ?? []).map((dependency) => dependency.trim()).filter(Boolean))].sort();
  for (const dependency of normalized) {
    if (!supported.has(dependency)) throw invalidArgument(`unsupported feed algorithm dependency: ${dependency}`, "dependencies");
  }
  return normalized;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Small deterministic JSON-Schema subset for run/fork config admission. */
function validateFeedAlgorithmConfig(schema: Record<string, unknown>, config: Record<string, unknown>): void {
  if (Object.keys(schema).length === 0) return;
  if (schema.type !== undefined && schema.type !== "object") {
    throw invalidArgument("CONFIG_SCHEMA top level must describe an object", "feedAlgorithm.config");
  }
  const properties = isPlainRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((value): value is string => typeof value === "string") : [];
  for (const key of required) {
    if (config[key] === undefined) throw invalidArgument(`feed algorithm config requires ${key}`, `feedAlgorithm.config.${key}`);
  }
  for (const [key, value] of Object.entries(config)) {
    const property = properties[key];
    if (property === undefined) continue;
    validateFeedAlgorithmConfigValue(value, property, `feedAlgorithm.config.${key}`);
  }
}

function validateFeedAlgorithmConfigValue(value: unknown, schema: unknown, field: string): void {
  if (!isPlainRecord(schema)) return;
  const expected = schema.type;
  const valid = expected === undefined ||
    (expected === "string" && typeof value === "string") ||
    (expected === "number" && typeof value === "number" && Number.isFinite(value)) ||
    (expected === "integer" && typeof value === "number" && Number.isInteger(value)) ||
    (expected === "boolean" && typeof value === "boolean") ||
    (expected === "array" && Array.isArray(value)) ||
    (expected === "object" && isPlainRecord(value));
  if (!valid) throw invalidArgument(`feed algorithm config value does not match ${String(expected)}`, field);
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => canonicalConfigEquals(candidate, value))) {
    throw invalidArgument("feed algorithm config value is not an allowed enum member", field);
  }
}

function canonicalConfigEquals(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
