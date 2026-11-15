import { type AgentBlueprintDefinition, type McpPolicyDefinition, type FrozenSkillBinding } from "@openleek/contracts/agent";
import type { AssetDeleteTarget, AssetTombstone } from "@openleek/contracts/assets";
import { type Checkpoint, type DynamicContextRevision, type ContextRuntimeOperation, type ContextRuntimeResult, type ContextPluginDescriptor } from "@openleek/contracts/context";
import { type PluginManifest, type PluginSpecification, type RoundAttemptStatus, type RoundProgress, type RunStatus } from "@openleek/contracts/experiment";
import { type FrozenTurnPrompt, type TurnPromptVariableDefinition } from "@openleek/contracts/turn-prompt";
import { type PopulationEntry } from "@openleek/contracts/world";

/**
 * Every Context side effect is guarded by one of these durable boundaries.
 * The ledger belongs to a round attempt so a provider retry never inherits a
 * partially-applied world change, while a commit retry does.
 */
export type LedgerStep = string;
export type FaultBoundaryMoment = "before" | "after";

export interface Ledger {
  attemptId: string;
  completed: ReadonlySet<LedgerStep>;
}

export interface RunRecord {
  status: RunStatus;
  specification: PluginSpecification;
  specificationDigest: string;
  lineageParentManifestRef?: string | undefined;
  /** Immutable v5 Population/Network expansion used for IDs and MCP binding. */
  resolvedWorld?: ResolvedWorldRecord | undefined;
  /** Experiment-owned immutable input projection consumed by Agent Execution. */
  turnPrompt: FrozenTurnPrompt;
}

export interface ResolvedWorldRecord {
  population: readonly ResolvedProfileMember[];
  digest: string;
}
export interface ResolvedProfileMember {
  slotId: string; cohortKey: string; cohortIndex: number; agentId: string; displayName: string;
  agentBlueprintVersionRef: string; agentsMdVersionRef: string;
  skills: readonly FrozenSkillBinding[];
  mcpPolicyVersionRef: string; mcpPolicyArtifactDigest: string; mcpPolicy: McpPolicyDefinition;
  contexts: Readonly<Record<string, { enabled: boolean; accountPolicy: Readonly<Record<string, unknown>> }>>;
}

export type WorldGeneratorKind = "population" | "network";
export interface WorldGeneratorLimits { maxRuntimeMs: number; maxMemoryMb: number; }
export interface WorldGeneratorDraft {
  generatorId: string;
  kind: WorldGeneratorKind;
  name: string;
  source: string;
  defaultConfig: Record<string, unknown>;
  configSchema: Record<string, unknown>;
  dependencies: string[];
  limits: WorldGeneratorLimits;
  revision: number;
  updatedAt: string;
}
export interface WorldGeneratorVersion extends Omit<WorldGeneratorDraft, "revision" | "updatedAt"> {
  versionRef: string;
  artifactDigest: string;
  publishedAt: string;
  draftRevision: number;
}
export interface PopulationDraft { populationId: string; name: string; entries: PopulationEntry[]; revision: number; updatedAt: string; }
export interface PopulationVersion extends Omit<PopulationDraft, "revision" | "updatedAt"> { versionRef: string; artifactDigest: string; publishedAt: string; draftRevision: number; }
export interface AgentBlueprintDraft extends AgentBlueprintDefinition { blueprintId: string; name: string; revision: number; updatedAt: string; }
export interface AgentBlueprintVersion extends Omit<AgentBlueprintDraft, "revision" | "updatedAt"> { versionRef: string; artifactDigest: string; publishedAt: string; draftRevision: number; }
export interface TurnPromptDraft { promptId: string; name: string; source: string; variables: readonly TurnPromptVariableDefinition[]; revision: number; updatedAt: string; }
export interface TurnPromptVersion extends Omit<TurnPromptDraft, "revision" | "updatedAt"> { versionRef: string; artifactDigest: string; publishedAt: string; draftRevision: number; }

/** Experiment-owned registration for an Agent identity scoped to one run. */
export interface RunAgentRegistration {
  principalId: string;
  runId: string;
  agentId: string;
  credentialVersion: number;
  status: "active" | "revoked";
  registeredAt: string;
  revokedAt?: string | undefined;
}

/** A Context endpoint that has locally bound a run Agent principal. */
export interface ContextMcpEndpoint {
  context: string;
  agentId: string;
  endpoint: string;
}

/** A Context-owned, read-only report for the current round worktree. */
export interface ContextSettlementStatus {
  settled: boolean;
  pendingIntentCount: number;
  pendingOutboxCount: number;
}

/**
 * An Experiment-signed connection written into an Agent workspace. The raw
 * credential is transient: it is never stored in this repository or returned
 * from an audit API.
 */
export interface ContextMcpConnection {
  context: ContextMcpEndpoint["context"];
  agentId: string;
  principalId: string;
  endpoint: string;
  credential: string;
}

export interface ContextGatewayPort {
  issue(input: { runId: string; agentId: string; contextId: string; installationRef?: string; endpoint: string; upstreamCredential: string; tools: readonly string[]; resources: readonly string[] }): Promise<{ endpoint: string; bearerToken: string }>;
  revokeRun(runId: string): Promise<void>;
}

export interface PluginContextPort {
  catalog(): Promise<readonly ContextPluginDescriptor[]>;
  execute(installationRef: string, input: ContextRuntimeOperation): Promise<ContextRuntimeResult>;
}

/** Immutable, complete input to every Agent job in a round. */
export interface RoundSnapshot {
  snapshotId: string;
  runId: string;
  roundId: number;
  baseline: PluginManifest;
  contextReadRevisions: Readonly<Record<string, DynamicContextRevision>>;
  declaredAgentIds: readonly string[];
  maxConcurrentAgents: number;
  /** Frozen independently of mutable Console defaults. Missing only on legacy snapshots. */
  toolCallBudget?: PluginSpecification["agentExecution"]["toolCallBudget"];
  automaticRetryMaxAttempts: number;
  automaticRetryBackoffMs: number;
  /** System value used when Agent Execution renders the frozen Turn Prompt. */
  utcDate: string;
  digest: string;
  createdAt: string;
}

export interface RoundAttempt {
  attemptId: string;
  runId: string;
  roundId: number;
  snapshotId: string;
  attempt: number;
  state: RoundAttemptStatus;
  /** A commit ledger means manual retry resumes this same attempt. */
  commitStarted: boolean;
  recentError?: JobFailure | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface JobFailure {
  category: string;
  message: string;
  occurredAt: string;
}

export interface AgentJob {
  jobId: string;
  attemptId: string;
  /** Stable over provider retries of the same frozen round. */
  turnId: string;
  agentId: string;
  declarationIndex: number;
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  /** Number of model calls made for this job, not number of queue deliveries. */
  attempts: number;
  availableAt: string;
  leaseToken?: string | undefined;
  leaseExpiresAt?: string | undefined;
  result?: readonly unknown[] | undefined;
  resultDigest?: string | undefined;
  failure?: JobFailure | undefined;
  updatedAt: string;
}

export interface StoredReceipt<T> {
  requestDigest: string;
  result: T;
}

export interface ClaimedJob {
  job: AgentJob;
  attempt: RoundAttempt;
  snapshot: RoundSnapshot;
}

export interface CommitWork {
  attempt: RoundAttempt;
  snapshot: RoundSnapshot;
  jobs: readonly AgentJob[];
  commitLeaseToken?: string;
}

/**
 * Durable, Experiment-owned cleanup work for a terminal Agent Execution run.
 * A cleanup failure is operational retry state; it never changes the run's
 * terminal lifecycle or its committed audit history.
 */
export interface RunRelease {
  runId: string;
  state: "queued" | "running" | "released";
  attempts: number;
  availableAt: string;
  leaseToken?: string | undefined;
  leaseExpiresAt?: string | undefined;
  recentError?: JobFailure | undefined;
  releasedAt?: string | undefined;
}

/**
 * Experiment owns scheduling state only. Context facts never enter this
 * database; Context revision refs are the immutable inter-context request.
 */
export interface ExperimentRepository {
  findRun(runId: string): Promise<RunRecord | undefined>;
  /** Creates the run and every run-local Agent principal atomically. */
  createRun(run: RunRecord, registrations: readonly RunAgentRegistration[]): Promise<void>;
  saveRun(run: RunRecord): Promise<void>;
  listRuns(input: { cursor?: string | undefined; limit: number; lifecycle?: RunStatus["lifecycle"] | undefined }): Promise<{ items: RunRecord[]; nextCursor: string | undefined }>;

  /** Serializes run creation/freeze using a process lock or pg advisory lock. */
  withRunLock<T>(runId: string, operation: () => Promise<T>): Promise<T>;
  findActiveAttempt(runId: string): Promise<RoundAttempt | undefined>;
  /** Returns a run whose automatic policy has no active round to execute. */
  findRunReadyForAutomaticAdvance(): Promise<RunRecord | undefined>;
  saveSnapshotAndAttempt(snapshot: RoundSnapshot, attempt: RoundAttempt, jobs: readonly AgentJob[]): Promise<void>;
  findSnapshot(snapshotId: string): Promise<RoundSnapshot | undefined>;
  findAttempt(attemptId: string): Promise<RoundAttempt | undefined>;
  listAttemptJobs(attemptId: string): Promise<readonly AgentJob[]>;
  getRoundProgress(runId: string): Promise<RoundProgress | undefined>;
  createRetryAttempt(previous: RoundAttempt, retry: RoundAttempt, jobs: readonly AgentJob[]): Promise<void>;
  markAttemptQueued(attemptId: string): Promise<RoundAttempt>;
  cancelActiveAttempt(runId: string): Promise<void>;

  claimNextJob(input: { workerId: string; leaseMs: number; now: Date }): Promise<ClaimedJob | undefined>;
  heartbeatJob(input: { jobId: string; leaseToken: string; leaseMs: number; now: Date }): Promise<boolean>;
  completeJob(input: { jobId: string; leaseToken: string; result: readonly unknown[]; resultDigest: string; now: Date }): Promise<boolean>;
  failJob(input: { jobId: string; leaseToken: string; failure: JobFailure; now: Date }): Promise<{ accepted: boolean; exhausted: boolean }>;
  claimCommittableAttempt(input: { workerId: string; leaseMs: number; now: Date }): Promise<CommitWork | undefined>;
  heartbeatCommit(input: { attemptId: string; leaseToken: string; leaseMs: number; now: Date }): Promise<boolean>;
  loadLedger(attemptId: string): Promise<Ledger | undefined>;
  startLedger(attemptId: string): Promise<Ledger>;
  completeLedgerStep(attemptId: string, step: LedgerStep): Promise<Ledger>;
  markCommitRetry(attemptId: string, failure: JobFailure): Promise<void>;
  markCommitted(attemptId: string, manifest: PluginManifest, status: RunStatus): Promise<void>;

  /** Idempotently schedule Agent Execution cleanup for a terminal run. */
  enqueueRunRelease(runId: string): Promise<void>;
  claimRunRelease(input: { workerId: string; leaseMs: number; now: Date }): Promise<RunRelease | undefined>;
  completeRunRelease(input: { runId: string; leaseToken: string; now: Date }): Promise<boolean>;
  failRunRelease(input: { runId: string; leaseToken: string; failure: JobFailure; retryBackoffMs: number; now: Date }): Promise<boolean>;

  saveManifest(manifest: PluginManifest): Promise<void>;
  findManifest(ref: string): Promise<PluginManifest | undefined>;
  findManifestForRound(runId: string, roundId: number): Promise<PluginManifest | undefined>;
  listCommittedManifests(runId: string, input: { cursor?: string | undefined; limit: number }): Promise<{ items: PluginManifest[]; nextCursor: string | undefined }>;
  findReceipt<T>(scope: string, transitionId: string, stepId: string): Promise<StoredReceipt<T> | undefined>;
  saveReceipt<T>(scope: string, transitionId: string, stepId: string, receipt: StoredReceipt<T>): Promise<void>;
  findRunAgentRegistration(input: { runId: string; agentId: string }): Promise<RunAgentRegistration | undefined>;
  listRunAgentRegistrations(runId: string): Promise<readonly RunAgentRegistration[]>;
  revokeRunAgentRegistrations(input: { runId: string; revokedAt: string }): Promise<void>;
  listWorldGenerators(): Promise<{ drafts: WorldGeneratorDraft[]; versions: WorldGeneratorVersion[] }>;
  findWorldGeneratorDraft(generatorId: string): Promise<WorldGeneratorDraft | undefined>;
  findWorldGeneratorVersion(versionRef: string): Promise<WorldGeneratorVersion | undefined>;
  saveWorldGeneratorDraft(draft: WorldGeneratorDraft): Promise<void>;
  saveWorldGeneratorVersion(version: WorldGeneratorVersion): Promise<void>;
  listPopulations(): Promise<{ drafts: PopulationDraft[]; versions: PopulationVersion[] }>;
  findPopulationDraft(populationId: string): Promise<PopulationDraft | undefined>;
  findPopulationVersion(versionRef: string): Promise<PopulationVersion | undefined>;
  savePopulationDraft(draft: PopulationDraft): Promise<void>;
  savePopulationVersion(version: PopulationVersion): Promise<void>;
  listAgentBlueprints(): Promise<{ drafts: AgentBlueprintDraft[]; versions: AgentBlueprintVersion[] }>;
  findAgentBlueprintDraft(blueprintId: string): Promise<AgentBlueprintDraft | undefined>;
  findAgentBlueprintVersion(versionRef: string): Promise<AgentBlueprintVersion | undefined>;
  saveAgentBlueprintDraft(draft: AgentBlueprintDraft): Promise<void>;
  saveAgentBlueprintVersion(version: AgentBlueprintVersion): Promise<void>;
  listTurnPrompts(): Promise<{ drafts: TurnPromptDraft[]; versions: TurnPromptVersion[] }>;
  findTurnPromptDraft(promptId: string): Promise<TurnPromptDraft | undefined>;
  findTurnPromptVersion(versionRef: string): Promise<TurnPromptVersion | undefined>;
  saveTurnPromptDraft(draft: TurnPromptDraft): Promise<void>;
  saveTurnPromptVersion(version: TurnPromptVersion): Promise<void>;
  findAssetTombstone(input: { assetKind: string; target: AssetDeleteTarget; assetId: string }): Promise<AssetTombstone | undefined>;
  listAssetTombstones(assetKind: string): Promise<AssetTombstone[]>;
  saveAssetTombstone(tombstone: AssetTombstone): Promise<void>;
}

/** Credentialless Python runner used only for Population and Network plugins. */
export interface WorldGeneratorPort {
  validate(input: { kind: WorldGeneratorKind; source: string; dependencies: readonly string[]; limits: WorldGeneratorLimits }): Promise<{ valid: boolean; configSchema?: Record<string, unknown>; defaultConfig?: Record<string, unknown>; errors: string[] }>;
  executePopulation(input: { source: string; dependencies: readonly string[]; limits: WorldGeneratorLimits; config: Record<string, unknown>; seed: string }): Promise<unknown>;
  executeNetwork(input: { source: string; dependencies: readonly string[]; limits: WorldGeneratorLimits; config: Record<string, unknown>; seed: string; population: readonly ResolvedProfileMember[] }): Promise<unknown>;
}

export interface ContextMutation {
  transitionId: string;
  stepId: string;
  payloadDigest: string;
  expectedCheckpointRef: string;
}

export interface AgentExecutionPort {
  validate(specification: PluginSpecification["agentExecution"]): Promise<PluginSpecification["agentExecution"]>;
  validateAgentsMdVersions(versionRefs: readonly string[]): Promise<void>;
  mcpPolicyVersion(versionRef: string): Promise<{ versionRef: string; artifactDigest: string; tools: McpPolicyDefinition["tools"]; resources: McpPolicyDefinition["resources"]; contexts?: McpPolicyDefinition["contexts"] }>;
  skillVersion(versionRef: string): Promise<{ versionRef: string; artifactDigest: string; skillName: string; requirements?: { tools: readonly string[]; resources: readonly string[] } }>;
  initialize(runId: string, input: { section: PluginSpecification["agentExecution"]; turnPrompt: FrozenTurnPrompt; agents: readonly { agentId: string; agentsMdVersionRef: string; skillVersionRefs: readonly string[]; mcpContexts: readonly string[] }[] }, mutation: ContextMutation, mcp: readonly ContextMcpConnection[]): Promise<Checkpoint>;
  execute(input: { runId: string; roundId: number; agentId: string; attemptId: string; orchestrationTurnId: string; utcDate: string; mutation: ContextMutation; baseline: Checkpoint }): Promise<void>;
  seal(input: { runId: string; roundId: number; mutation: ContextMutation }): Promise<Checkpoint>;
  publish(input: { runId: string; roundId: number; mutation: ContextMutation; checkpoint: Checkpoint }): Promise<void>;
  fork(input: { sourceRunId: string; source: Checkpoint; targetRunId: string; mutation: ContextMutation; mcp: readonly ContextMcpConnection[]; section: PluginSpecification["agentExecution"]; agentsMdByAgentId?: Readonly<Record<string, string>>; turnPrompt?: FrozenTurnPrompt }): Promise<Checkpoint>;
  /** Idempotent terminal cleanup of the Agent Execution runtime for a run. */
  release(runId: string): Promise<void>;
}

/** Runtime-v2 lease returned by any Context while an Agent turn is active. */
export interface ContextMcpScopeLease {
  scopeId: string;
  runId: string;
  roundId: number;
  agentId: string;
  principalId: string;
  turnId: string;
  attemptId: string;
  expiresAt: string;
}

export interface ContextPorts {
  agentExecution: AgentExecutionPort;
  pluginContexts: PluginContextPort;
  contextGateway?: ContextGatewayPort;
  worldGenerator?: WorldGeneratorPort;
}

export class FaultInjectedError extends Error {
  constructor(readonly step: LedgerStep, readonly moment: FaultBoundaryMoment | "after_effect" = "after_effect") {
    super(`fault injected ${moment.replace("_", " ")} ${step}`);
  }
}
