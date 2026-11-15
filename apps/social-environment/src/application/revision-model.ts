import { type SocialMcpPermissions } from "@openleek/contracts/agent";
import type { AssetTombstone } from "@openleek/contracts/assets";
import type {
  Actor,
  Engagement,
  Exposure,
  FeedAlgorithmDraft,
  FeedAlgorithmVersion,
  SocialNetworkDraft,
  SocialNetworkVersion,
  Relationship,
  SocialAction,
  SocialPost,
} from "../domain/models";

/**
 * An immutable, complete Social Context value.  This is deliberately not a
 * view-model: Resources, workers, and a future fork all read the same
 * canonical payload.
 */
export interface SocialRevisionSnapshot {
  exposurePolicy: "recommendation_only" | "public_browse";
  actors: Record<string, Actor>;
  feedSize: number;
  ranking: { recencyWeight: number; engagementWeight: number };
  /** Source-free, immutable algorithm choice used to make this revision. */
  feedAlgorithm?: { versionRef: string; config: Record<string, unknown> };
  audienceReception: { engagementProbability: number; repostProbability: number };
  posts: Record<string, SocialPost>;
  engagements: Record<string, Engagement>;
  initialRelationships: Record<string, Relationship>;
  relationships: Record<string, Relationship>;
  exposures: Record<string, Exposure>;
  processedActionIds: Record<string, number>;
}

export interface FeedAlgorithmRegistry {
  drafts: Record<string, FeedAlgorithmDraft>;
  versions: Record<string, FeedAlgorithmVersion>;
  tombstones?: AssetTombstone[];
}

export interface SocialNetworkRegistry { drafts: Record<string, SocialNetworkDraft>; versions: Record<string, SocialNetworkVersion>; tombstones?: AssetTombstone[]; }

/**
 * Opaque capability for one FeedAlgorithm execution. It is deliberately
 * unrelated to an Agent MCP scope and is discarded as soon as execution ends.
 */
export interface SocialFeedAlgorithmHistoryCapability {
  capability: string;
  runId: string;
  committedHeadRevisionRef: string;
  executionId: string;
  expiresAt: string;
}

/** Structural match for the shared ContextRevision contract. */
export interface SocialContextRevision {
  ref: string;
  context: "social_environment";
  runId: string;
  roundId: number;
  digest: string;
  parentRevisionRef?: string;
  sourceManifestRef?: string;
}

export interface StoredSocialRevision extends SocialContextRevision {
  kind: "initial" | "read_snapshot" | "candidate" | "committed";
  snapshot: SocialRevisionSnapshot;
  createdAt: string;
}

export type SocialIntentStatus = "pending" | "applied" | "rejected" | "discarded";
export type SocialOutboxStatus = "pending" | "published" | "applied";

/** A durable Context-owned command.  Redis only transports this record. */
export interface SocialIntentRecord {
  commandId: string;
  action: SocialAction;
  roundId: number;
  actorId: string;
  turnId: string;
  attemptId?: string;
  actionId: string;
  status: SocialIntentStatus;
  streamId?: string;
  rejectionReason?: string;
  createdAt: string;
}

/** Kept in the same owner transaction as its intent to avoid DB/Redis loss. */
export interface SocialOutboxRecord {
  commandId: string;
  streamKey: string;
  payload: { runId: string; roundId: number; commandId: string };
  status: SocialOutboxStatus;
  publishedStreamId?: string;
  createdAt: string;
}

export interface SocialRoundWorkspace {
  roundId: number;
  baseRevisionRef: string;
  readRevisionRef: string;
  intents: Record<string, SocialIntentRecord>;
  outbox: Record<string, SocialOutboxRecord>;
  lastAppliedStreamId?: string;
  provisionalSnapshot?: SocialRevisionSnapshot;
  candidateRevisionRef?: string;
  closed: boolean;
}

/**
 * Read-only owner report used by Experiment's commit barrier. It exposes no
 * intent payloads, principals, or Redis identifiers—only pending work.
 */
export interface SocialRoundSettlement {
  settled: boolean;
  pendingIntentCount: number;
  pendingOutboxCount: number;
}

/** Locally registered principal; credential signing remains Experiment-owned. */
export interface SocialMcpPrincipal {
  principalId: string;
  agentId: string;
  actorId: string;
  /** Required for every new registration. */
  permissions?: SocialMcpPermissions;
  /** Load-time marker for registrations persisted before MCP Policies existed. */
  legacyFullAccess?: true;
}

export interface SocialMcpScope {
  scopeId: string;
  runId: string;
  roundId: number;
  principalId: string;
  agentId: string;
  actorId: string;
  readRevisionRef: string;
  turnId: string;
  attemptId?: string;
  expiresAt: string;
}

export interface SocialMcpRunState {
  principals: SocialMcpPrincipal[];
  activeScopes: SocialMcpScope[];
  /** Permanent for this run: already-issued Experiment credentials stop working. */
  accessRevokedAt?: string;
}

export interface SocialMcpBinding {
  /** Agent Execution's MCP config name; not the ContextRevision name. */
  context: "social";
  agentId: string;
  endpoint: string;
}

export interface SocialMcpAgent {
  agentId: string;
  principalId: string;
  actorId: string;
  permissions: SocialMcpPermissions;
}

/** Verified JWS claims passed by the HTTP transport to the application layer. */
export interface SocialMcpCredentialPrincipal {
  principalId: string;
  runId: string;
  agentId: string;
}

export interface SocialMcpResource {
  uri: string;
  name: string;
  mimeType: "application/json";
  description: string;
}
