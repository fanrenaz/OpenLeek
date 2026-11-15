import type {
  Actor,
  Engagement,
  Exposure,
  Relationship,
  RelationshipChange,
  SocialCheckpoint,
  SocialPost,
} from "../domain/models";
import type {
  SocialMcpRunState,
  SocialRoundWorkspace,
  SocialFeedAlgorithmHistoryCapability,
  StoredSocialRevision,
  FeedAlgorithmRegistry,
  SocialNetworkRegistry,
} from "./revision-model";

export interface IdempotencyRecord {
  payloadDigest: string;
  result: unknown;
}

/** JSON-shaped state persisted atomically by Social's Postgres owner. */
export interface SocialRunState {
  runId: string;
  /** Experiment root seed, persisted so frozen snapshots can be replayed. */
  simulationSeed?: number;
  exposurePolicy?: "recommendation_only" | "public_browse";
  actors: Record<string, Actor>;
  feedSize: number;
  ranking: {
    recencyWeight: number;
    engagementWeight: number;
  };
  feedAlgorithm?: {
    versionRef: string;
    config: Record<string, unknown>;
  };
  audienceReception: {
    engagementProbability: number;
    repostProbability: number;
  };
  publishedPosts: Record<string, SocialPost>;
  pendingPosts: Record<string, SocialPost[]>;
  publishedEngagements: Record<string, Engagement>;
  pendingEngagements: Record<string, Engagement[]>;
  initialRelationships: Record<string, Relationship>;
  relationships: Record<string, Relationship>;
  publishedRelationshipChanges: Record<string, RelationshipChange>;
  pendingRelationshipChanges: Record<string, RelationshipChange[]>;
  exposures: Record<string, Exposure>;
  /** actionId -> roundId; preserves action-level de-duplication across restart/fork. */
  processedActionIds: Record<string, number>;
  sealed: Record<string, SocialCheckpoint>;
  publishedRound: number;
  /** Git-like immutable Context objects, required in Social owner state v2. */
  revisions: Record<string, StoredSocialRevision>;
  revisionHeadRef: string;
  roundWorkspaces: Record<string, SocialRoundWorkspace>;
  mcp?: SocialMcpRunState;
}

export interface SocialState {
  version: 2;
  runs: Record<string, SocialRunState>;
  idempotency: Record<string, IdempotencyRecord>;
  /** Social-owned library, deliberately independent of Experiment runs. */
  algorithmRegistry: FeedAlgorithmRegistry;
  networkRegistry: SocialNetworkRegistry;
  /** Short-lived, runner-only capabilities. They are never Agent credentials. */
  feedAlgorithmHistoryCapabilities: Record<string, SocialFeedAlgorithmHistoryCapability>;
}

export interface SocialStateStore {
  load(): Promise<SocialState | null>;
  loadRevision(revisionRef: string): Promise<StoredSocialRevision | undefined>;
  save(state: SocialState): Promise<void>;
}

export function emptySocialState(): SocialState {
  return {
    version: 2,
    runs: {},
    idempotency: {},
    algorithmRegistry: { drafts: {}, versions: {}, tombstones: [] },
    networkRegistry: { drafts: {}, versions: {}, tombstones: [] },
    feedAlgorithmHistoryCapabilities: {},
  };
}
