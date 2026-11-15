/**
 * Social Environment's owned facts.  IDs are strings because all externally
 * supplied IDs are opaque and are only interpreted by this bounded context.
 */

export type EngagementKind = "like" | "repost" | "reply";
export type RelationshipActionKind = "follow" | "unfollow";
export type SocialPostType = "original" | "repost" | "reply";

export interface SocialNetworkLimits { maxRuntimeMs: number; maxMemoryMb: number; }
export interface SocialNetworkDraft { networkId: string; name: string; source: string; defaultConfig: Record<string, unknown>; configSchema: Record<string, unknown>; dependencies: string[]; limits: SocialNetworkLimits; revision: number; updatedAt: string; }
export interface SocialNetworkVersion extends Omit<SocialNetworkDraft, "revision" | "updatedAt"> { versionRef: string; artifactDigest: string; publishedAt: string; draftRevision: number; }

export interface Actor {
  actorId: string;
  displayName: string;
  maximumActionsPerRound: number;
}

export interface RelationshipSeed {
  actorId: string;
  targetActorId: string;
}

export interface SocialSection {
  /** Resource-discovery policy; all views still read one full revision. */
  exposurePolicy?: "recommendation_only" | "public_browse";
  actors: readonly Actor[];
  relationships?: readonly RelationshipSeed[];
  feedSize: number;
  ranking?: {
    recencyWeight: number;
    engagementWeight: number;
  };
  /** A published, immutable version in the Social-owned algorithm registry. */
  feedAlgorithm?: {
    versionRef: string;
    config: Record<string, unknown>;
  };
  audienceReception?: {
    engagementProbability: number;
    repostProbability: number;
  };
}

export interface FeedAlgorithmLimits {
  maxRuntimeMs: number;
  maxMemoryMb: number;
}

/** Mutable source record. It is never embedded in an Experiment specification. */
export interface FeedAlgorithmDraft {
  algorithmId: string;
  name: string;
  source: string;
  defaultConfig: Record<string, unknown>;
  configSchema: Record<string, unknown>;
  dependencies: string[];
  limits: FeedAlgorithmLimits;
  revision: number;
  updatedAt: string;
}

/** Immutable content-addressed source artifact eligible for a run or fork. */
export interface FeedAlgorithmVersion extends Omit<FeedAlgorithmDraft, "revision" | "updatedAt"> {
  versionRef: string;
  artifactDigest: string;
  publishedAt: string;
  draftRevision: number;
}

export interface SocialPost {
  postId: string;
  authorId: string;
  content: string;
  headline: string;
  roundId: number;
  postType?: SocialPostType;
  parentPostId?: string;
}

export interface Exposure {
  exposureId: string;
  actorId: string;
  postId: string;
  roundId: number;
  rank: number;
}

export interface Engagement {
  engagementId: string;
  actorId: string;
  targetPostId: string;
  kind: EngagementKind;
  replyBody?: string;
  derivedPostId?: string;
  roundId: number;
}

export interface RelationshipChange {
  actionId: string;
  actorId: string;
  targetActorId: string;
  kind: RelationshipActionKind;
  roundId: number;
}

export interface Relationship {
  actorId: string;
  targetActorId: string;
}

export interface AudienceReception {
  postId: string;
  exposureCount: number;
  likeCount: number;
  repostCount: number;
  replyCount: number;
}

export interface SocialSummary {
  roundId: number;
  postCount: number;
  exposureCount: number;
  engagementCount: number;
  audienceReception: readonly AudienceReception[];
}

export interface SocialObservation {
  actorId: string;
  roundId: number;
  exposures: readonly Exposure[];
  visiblePosts: readonly SocialPost[];
}

export interface SocialCheckpoint {
  ref: string;
  runId: string;
  roundId: number;
  digest: string;
}

export interface Mutation {
  transitionId: string;
  stepId: string;
  payloadDigest: string;
  expectedCheckpointRef: string;
}

export interface PostAction {
  kind: "post";
  actionId: string;
  actorId: string;
  postId: string;
  content: string;
  headline?: string;
}

export interface EngagementAction {
  kind: "engagement";
  actionId: string;
  actorId: string;
  targetPostId: string;
  engagementKind: EngagementKind;
  replyBody?: string;
  derivedPostId?: string;
  derivedHeadline?: string;
  derivedContent?: string;
}

export interface RelationshipAction {
  kind: "relationship";
  actionId: string;
  actorId: string;
  targetActorId: string;
  relationshipKind: RelationshipActionKind;
}

export type SocialAction = PostAction | EngagementAction | RelationshipAction;

export interface ExportedSocialFacts {
  posts: readonly SocialPost[];
  exposures: readonly Exposure[];
  engagements: readonly Engagement[];
  relationships: readonly Relationship[];
  summary: SocialSummary;
}

export interface CommittedSocialGraph {
  runId: string;
  actors: readonly Actor[];
  posts: readonly SocialPost[];
  engagements: readonly Engagement[];
  exposures: readonly Exposure[];
  relationships: readonly Relationship[];
}
