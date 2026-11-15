import { type FinancialMcpPermissions } from "@openleek/contracts/agent";
import type { MarketAction, MarketMakerOrderIntent, MarketMakerTiming } from "../domain/models";
import type { MaterialMarketState } from "./persistence";

/**
 * A full, immutable Financial Context value.  This is the only source used by
 * MCP Resources for a pinned round: account, order and market projections are
 * deliberately derived from this one payload rather than from live tables.
 */
export interface FinancialRevisionSnapshot extends MaterialMarketState {}

/** Structural match for the shared ContextRevision contract. */
export interface FinancialContextRevision {
  ref: string;
  context: "financial_market";
  runId: string;
  roundId: number;
  digest: string;
  parentRevisionRef?: string;
  sourceManifestRef?: string;
}

export interface StoredFinancialRevision extends FinancialContextRevision {
  kind: "initial" | "read_snapshot" | "candidate" | "committed";
  snapshot: FinancialRevisionSnapshot;
  createdAt: string;
}

export type FinancialIntentStatus = "pending" | "applied" | "rejected" | "discarded";
export type FinancialOutboxStatus = "pending" | "published" | "applied";

/** A durable Financial command. Redis transports this owner record only. */
export interface FinancialIntentRecord {
  commandId: string;
  action: MarketAction;
  roundId: number;
  accountId: string;
  agentId: string;
  turnId: string;
  attemptId?: string;
  actionId: string;
  status: FinancialIntentStatus;
  streamId?: string;
  rejectionReason?: string;
  /** Optional agent-supplied audit note; it never affects matching. */
  rationale?: string;
  createdAt: string;
}

/** Persisted with the intent so a database/Redis dual-write cannot lose it. */
export interface FinancialOutboxRecord {
  commandId: string;
  streamKey: string;
  payload: { runId: string; roundId: number; commandId: string };
  status: FinancialOutboxStatus;
  publishedStreamId?: string;
  createdAt: string;
}

/**
 * The Context-local equivalent of Git's worktree/index.  It is mutable and
 * private; only a StoredFinancialRevision becomes externally readable.
 */
export interface FinancialRoundWorkspace {
  roundId: number;
  baseRevisionRef: string;
  readRevisionRef: string;
  intents: Record<string, FinancialIntentRecord>;
  outbox: Record<string, FinancialOutboxRecord>;
  lastAppliedStreamId?: string;
  provisionalSnapshot?: FinancialRevisionSnapshot;
  candidateRevisionRef?: string;
  /** Successful results are durable: rebuilds and retries never rerun code. */
  marketMakerExecutions?: Record<string, FinancialMarketMakerExecution>;
  closed: boolean;
}

export interface FinancialMarketMakerExecution {
  executionId: string;
  timing: MarketMakerTiming;
  trigger?: "opening" | "settlement" | "after_trade";
  roundId: number;
  versionRef: string;
  accountId: string;
  config: Record<string, unknown>;
  seed: string;
  committedHeadRevisionRef: string;
  orders: MarketMakerOrderIntent[];
  createdAt: string;
}

/** Opaque runner capability for the dedicated non-MCP committed-history reader. */
export interface FinancialMarketMakerHistoryCapability {
  capability: string;
  runId: string;
  makerAccountId: string;
  committedHeadRevisionRef: string;
  executionId: string;
  expiresAt: string;
}

/** Read-only owner report for Experiment's terminal Context settlement barrier. */
export interface FinancialRoundSettlement {
  settled: boolean;
  pendingIntentCount: number;
  pendingOutboxCount: number;
}

/**
 * Context-owned authorization binding.  Experiment issues the bearer JWS; the
 * Context stores only which principal may act for which Financial account.
 */
export interface FinancialMcpPrincipalRegistration {
  agentId: string;
  principalId: string;
  accountId?: string;
  /** Frozen allow-list selected by the Agent's published MCP Policy. */
  permissions?: FinancialMcpPermissions;
  /** Load-time marker for registrations persisted before MCP Policies existed. */
  legacyFullAccess?: true;
}

export interface FinancialMcpScope {
  scopeId: string;
  runId: string;
  roundId: number;
  agentId: string;
  principalId: string;
  accountId?: string;
  readRevisionRef: string;
  turnId: string;
  attemptId?: string;
  expiresAt: string;
}

export interface FinancialMcpRunState {
  principals: FinancialMcpPrincipalRegistration[];
  activeScopes: FinancialMcpScope[];
  /** Revoking a run invalidates every JWS and scope for that Financial run. */
  accessRevokedAt?: string;
}

export interface FinancialMcpBinding {
  /** Endpoint descriptor; Experiment supplies the signed bearer credential. */
  context: "financial";
  agentId: string;
  endpoint: string;
}

export interface FinancialMcpAgent {
  agentId: string;
  principalId: string;
  accountId?: string;
  permissions: FinancialMcpPermissions;
}

export interface FinancialMcpResource {
  uri: string;
  name: string;
  mimeType: "application/json";
  description: string;
}
