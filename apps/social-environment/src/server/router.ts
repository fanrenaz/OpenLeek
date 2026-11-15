import { contextAssetCommandSchema, contextAssetReadSchema, contextPluginDescriptorSchema } from "@openleek/contracts/context";
import { domainProcedure, t } from "@openleek/trpc";
import { socialEnvironmentService } from "./runtime";
import { socialUiModuleSha256 } from "./ui-module";
import {
  createSocialEnvironmentRouter,
  type SocialEnvironmentRouterPort,
} from "../interfaces/router";

/**
 * The static HTTP router delegates to a lazily initialized Node runtime. This
 * keeps database/Neo4j clients out of module import and browser bundles.
 */
const runtimePort: SocialEnvironmentRouterPort = {
  async listSocialNetworks(includeDeleted) { return (await socialEnvironmentService()).listSocialNetworks(includeDeleted); },
  async getSocialNetworkDraft(networkId, includeDeleted) { return (await socialEnvironmentService()).getSocialNetworkDraft(networkId, includeDeleted); },
  async getSocialNetworkVersion(versionRef, includeDeleted) { return (await socialEnvironmentService()).getSocialNetworkVersion(versionRef, includeDeleted); },
  async saveSocialNetworkDraft(input) { return (await socialEnvironmentService()).saveSocialNetworkDraft(input); },
  async validateSocialNetwork(input) { return (await socialEnvironmentService()).validateSocialNetwork(input); },
  async publishSocialNetwork(input) { return (await socialEnvironmentService()).publishSocialNetwork(input); },
  async deleteSocialNetworkDraft(input) { return (await socialEnvironmentService()).deleteSocialNetworkDraft(input); },
  async deleteSocialNetworkVersion(input) { return (await socialEnvironmentService()).deleteSocialNetworkVersion(input); },
  async resolveSocialNetwork(input) { return (await socialEnvironmentService()).resolveSocialNetwork(input); },
  async listFeedAlgorithms(includeDeleted) { return (await socialEnvironmentService()).listFeedAlgorithms(includeDeleted); },
  async getFeedAlgorithmDraft(algorithmId, includeDeleted) { return (await socialEnvironmentService()).getFeedAlgorithmDraft(algorithmId, includeDeleted); },
  async getFeedAlgorithmVersion(versionRef, includeDeleted) { return (await socialEnvironmentService()).getFeedAlgorithmVersion(versionRef, includeDeleted); },
  async saveFeedAlgorithmDraft(input) { return (await socialEnvironmentService()).saveFeedAlgorithmDraft(input); },
  async validateFeedAlgorithm(input) { return (await socialEnvironmentService()).validateFeedAlgorithm(input); },
  async publishFeedAlgorithm(input) { return (await socialEnvironmentService()).publishFeedAlgorithm(input); },
  async deleteFeedAlgorithmDraft(input) { return (await socialEnvironmentService()).deleteFeedAlgorithmDraft(input); },
  async deleteFeedAlgorithmVersion(input) { return (await socialEnvironmentService()).deleteFeedAlgorithmVersion(input); },
  async previewFeedAlgorithm(input) { return (await socialEnvironmentService()).previewFeedAlgorithm(input); },
  async validateSection(section) { await (await socialEnvironmentService()).validateSection(section); },
  async initialize(runId, section, mutation) {
    return (await socialEnvironmentService()).initialize(runId, section, mutation);
  },
  async observe(runId, roundId, actorIds, mutation) {
    return (await socialEnvironmentService()).observe(runId, roundId, actorIds, mutation);
  },
  async apply(runId, roundId, actions, mutation) {
    return (await socialEnvironmentService()).apply(runId, roundId, actions, mutation);
  },
  async seal(runId, roundId, mutation) {
    return (await socialEnvironmentService()).seal(runId, roundId, mutation);
  },
  async publish(runId, roundId, checkpointRef, mutation) {
    return (await socialEnvironmentService()).publish(runId, roundId, checkpointRef, mutation);
  },
  async fork(sourceRunId, targetRunId, sourceCheckpointRef, mutation) {
    return (await socialEnvironmentService()).fork(sourceRunId, targetRunId, sourceCheckpointRef, mutation);
  },
  async summary(runId, roundId, checkpointRef) {
    return (await socialEnvironmentService()).summary(runId, roundId, checkpointRef);
  },
  async exportFacts(runId, roundId, checkpointRef) {
    return (await socialEnvironmentService()).exportFacts(runId, roundId, checkpointRef);
  },
  async exportCommittedRevisionFacts(runId, revisionRef) {
    return (await socialEnvironmentService()).exportCommittedRevisionFacts(runId, revisionRef);
  },
  async observer(input) {
    return (await socialEnvironmentService()).observer(input);
  },
  async committedFollowerCount(runId, actorId) {
    return (await socialEnvironmentService()).committedFollowerCount(runId, actorId);
  },
  async initializeRevision(runId, section, mutation, simulationSeed) {
    return (await socialEnvironmentService()).initializeRevision(runId, section, mutation, simulationSeed);
  },
  async freezeFullSnapshot(input) {
    return (await socialEnvironmentService()).freezeFullSnapshot(input);
  },
  async provisionMcpBindings(input) {
    return (await socialEnvironmentService()).provisionMcpBindings(input);
  },
  async openMcpScope(input) {
    return (await socialEnvironmentService()).openMcpScope(input);
  },
  async closeMcpScope(input) {
    return (await socialEnvironmentService()).closeMcpScope(input);
  },
  async revokeMcpBindings(input) {
    return (await socialEnvironmentService()).revokeMcpBindings(input);
  },
  async settlementStatus(input) {
    return (await socialEnvironmentService()).settlementStatus(input);
  },
  async sealCandidateRevision(input) {
    return (await socialEnvironmentService()).sealCandidateRevision(input);
  },
  async commitCandidateRevision(input) {
    return (await socialEnvironmentService()).commitCandidateRevision(input);
  },
  async forkRevision(input) {
    return (await socialEnvironmentService()).forkRevision(input);
  },
};

export function createSocialEnvironmentServiceRouter(service: SocialEnvironmentRouterPort) {
  return t.router({
    contextPlugin: t.router({
      descriptor: domainProcedure.input(contextPluginDescriptorSchema.pick({}).strict()).query(() => ({
        schemaVersion: "3" as const,
        runtimeProtocol: "openleek-context-runtime/v2" as const,
        infrastructure: { postgres: true, redis: true },
        agentAccess: "read-write" as const,
        contextId: "social",
        revision: "social-context:v3",
        observerViews: [
          { id: "timeline", label: { default: "Timeline", translations: { en: "Timeline", zh: "时间线" } }, inputSchema: { type: "object" } },
          { id: "profile", label: { default: "Profile", translations: { en: "Profile", zh: "资料" } }, inputSchema: { type: "object" } },
          { id: "relationships", label: { default: "Relationships", translations: { en: "Relationships", zh: "关系" } }, inputSchema: { type: "object" } },
        ],
        uiModule: { apiVersion: "openleek-context-ui/v1", path: "/api/context/v2/ui", sha256: socialUiModuleSha256, elements: { configuration: "openleek-social-configuration", assets: "openleek-social-assets", observer: "openleek-social-observer", facts: "openleek-social-facts" } },
        label: { default: "Social Context", translations: { zh: "社交环境", en: "Social Context" } },
        description: { default: "Social identities, relationships and information exchange.", translations: { zh: "管理社交身份、关系与信息传播。", en: "Social identities, relationships and information exchange." } },
        agentEnvironment: {
          accountPolicySchema: { type: "object", properties: { provision: { type: "boolean", default: true }, maximumActionsPerRound: { type: "integer", minimum: 0, maximum: 1000, default: 5 } }, required: ["provision", "maximumActionsPerRound"] },
          accountPolicyUiSchema: {},
          capabilities: [
            ["social.get_feed", "tool", "Get feed", "读取信息流"],
            ["social.get_post", "tool", "Get post", "读取帖子"],
            ["social.list_posts", "tool", "List posts", "列出帖子"],
            ["social.search_posts", "tool", "Search posts", "搜索帖子"],
            ["social.get_profile", "tool", "Get profile", "读取社交资料"],
            ["social.list_relationships", "tool", "List relationships", "列出社交关系"],
            ["social.list_engagements", "tool", "List engagements", "列出互动"],
            ["social.get_notifications", "tool", "Get notifications", "读取最新互动通知"],
            ["social.create_post", "tool", "Create post", "发布内容"],
            ["social.like_post", "tool", "Like post", "点赞帖子"],
            ["social.repost_post", "tool", "Repost", "转发帖子"],
            ["social.reply_to_post", "tool", "Reply", "回复帖子"],
            ["social.follow", "tool", "Follow", "关注"],
            ["social.unfollow", "tool", "Unfollow", "取消关注"],
            ["social.engage", "tool", "Engage", "互动"],
            ["social.feed", "resource", "Feed", "信息流"],
            ["social.profile", "resource", "Profile", "社交资料"],
            ["social.posts", "resource", "Posts", "内容"],
          ].map(([id, kind, en, zh]) => ({ id, kind, label: { default: en, translations: { en, zh } } })),
        },
        worldEnvironment: {
          collections: [
            { id: "social-networks", label: { default: "Social Networks", translations: { zh: "社交网络", en: "Social Networks" } }, description: { default: "Relationship generators.", translations: { zh: "生成世界中的社交关系。", en: "Relationship generators." } }, definitionSchema: { type: "object" }, uiSchema: { renderer: "social-network" }, actions: ["list", "draft", "save", "validate", "publish", "delete"] },
            { id: "feed-algorithms", label: { default: "Feed Algorithms", translations: { zh: "信息流算法", en: "Feed Algorithms" } }, description: { default: "Ranking algorithms for social feeds.", translations: { zh: "定义社交信息流排序机制。", en: "Ranking algorithms for social feeds." } }, definitionSchema: { type: "object" }, uiSchema: { renderer: "feed-algorithm" }, actions: ["list", "draft", "save", "validate", "publish", "preview", "delete"] },
          ],
        },
        experimentConfigurationSchema: { type: "object", required: ["exposurePolicy"], properties: { exposurePolicy: { type: "string", enum: ["recommendation_only", "public_browse"] }, ranking: { type: "object" }, feedAlgorithm: { type: "object" }, feedSize: { type: "integer", minimum: 1, maximum: 1000 }, audienceReception: { type: "object" }, socialNetwork: { type: "object" } } },
        experimentConfigurationUiSchema: {},
      })),
      assetRead: domainProcedure.input(contextAssetReadSchema.omit({ contextId: true })).query(async ({ input }): Promise<unknown> => {
        if (input.collectionId === "social-networks") {
          if (input.operation === "list") return await service.listSocialNetworks(input.includeDeleted);
          if (input.operation === "draft" && input.id) return await service.getSocialNetworkDraft(input.id, input.includeDeleted);
          if (input.operation === "version" && input.id) return await service.getSocialNetworkVersion(input.id, input.includeDeleted);
        }
        if (input.collectionId === "feed-algorithms") {
          if (input.operation === "list") return await service.listFeedAlgorithms(input.includeDeleted);
          if (input.operation === "draft" && input.id) return await service.getFeedAlgorithmDraft(input.id, input.includeDeleted);
          if (input.operation === "version" && input.id) return await service.getFeedAlgorithmVersion(input.id, input.includeDeleted);
        }
        throw new Error(`Unsupported Social asset read ${input.collectionId}/${input.operation}`);
      }),
      assetCommand: domainProcedure.input(contextAssetCommandSchema.omit({ contextId: true })).mutation(async ({ input }): Promise<unknown> => {
        const payload = input.input as never;
        if (input.collectionId === "social-networks") {
          if (input.operation === "save") return await service.saveSocialNetworkDraft(payload);
          if (input.operation === "validate") return await service.validateSocialNetwork(payload);
          if (input.operation === "publish") return await service.publishSocialNetwork(payload);
          if (input.operation === "delete") {
            const deletion = input.input as { target: "draft" | "version"; networkId?: string; versionRef?: string; expectedRevision?: number; idempotencyKey: string };
            return deletion.target === "draft"
              ? service.deleteSocialNetworkDraft({ networkId: deletion.networkId!, expectedRevision: deletion.expectedRevision!, idempotencyKey: deletion.idempotencyKey })
              : service.deleteSocialNetworkVersion({ versionRef: deletion.versionRef!, idempotencyKey: deletion.idempotencyKey });
          }
        }
        if (input.collectionId === "feed-algorithms") {
          if (input.operation === "save") return await service.saveFeedAlgorithmDraft(payload);
          if (input.operation === "validate") return await service.validateFeedAlgorithm(payload);
          if (input.operation === "publish") return await service.publishFeedAlgorithm(payload);
          if (input.operation === "preview") return await service.previewFeedAlgorithm(payload);
          if (input.operation === "delete") {
            const deletion = input.input as { target: "draft" | "version"; algorithmId?: string; versionRef?: string; expectedRevision?: number; idempotencyKey: string };
            return deletion.target === "draft"
              ? service.deleteFeedAlgorithmDraft({ algorithmId: deletion.algorithmId!, expectedRevision: deletion.expectedRevision!, idempotencyKey: deletion.idempotencyKey })
              : service.deleteFeedAlgorithmVersion({ versionRef: deletion.versionRef!, idempotencyKey: deletion.idempotencyKey });
          }
        }
        throw new Error(`Unsupported Social asset command ${input.collectionId}/${input.operation}`);
      }),
    }),
    socialEnvironment: createSocialEnvironmentRouter(service),
  });
}

export const socialEnvironmentRouter = createSocialEnvironmentServiceRouter(runtimePort);

export type SocialEnvironmentServiceRouter = typeof socialEnvironmentRouter;
