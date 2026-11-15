import { type AgentExecutionSection as ContractAgentExecutionSection, type McpPolicyDefinition as ContractMcpPolicyDefinition, type SkillDefinition as ContractSkillDefinition, type SkillFile as ContractSkillFile, type SkillRequirements as ContractSkillRequirements } from "@openleek/contracts/agent";
import { type Checkpoint as ContractCheckpoint } from "@openleek/contracts/context";
import { type MutationHeader } from "@openleek/contracts/core";
import { type CandidateAction as ContractCandidateAction } from "@openleek/contracts/experiment";
import { type FrozenTurnPrompt as ContractFrozenTurnPrompt } from "@openleek/contracts/turn-prompt";
import { type AgentSessionTranscript as ContractAgentSessionTranscript } from "@openleek/contracts/observability";

export type JsonValue = null | boolean | number | string | JsonValue[] | { readonly [key: string]: JsonValue };

/** The public research runtime is intentionally fixed to Codex. */
export type AgentBackendName = "codex";

export interface AgentIdentity {
  readonly agentId: string;
  /** Immutable template selected by the Population generator. */
  readonly agentsMdVersionRef: string;
  /** Content digest of that version; no template text is interpolated. */
  readonly agentsMdDigest: string;
  /** Immutable Codex Skills selected by the published Agent Blueprint. */
  readonly skills: readonly FrozenSkill[];
  /** MCPs enabled by the Experiment-derived authority policy, never AGENTS.md. */
  readonly mcpContexts: readonly ContextMcpServer[];
}

/** Runtime validation belongs to the shared specification contract. */
export type AgentExecutionSection = ContractAgentExecutionSection;
export type CandidateAction = ContractCandidateAction;
export type FrozenTurnPrompt = ContractFrozenTurnPrompt;
export type McpPolicyDefinition = ContractMcpPolicyDefinition;
export type SkillDefinition = ContractSkillDefinition;
export type SkillFile = ContractSkillFile;
export type SkillRequirements = ContractSkillRequirements;
export type AgentSessionTranscript = ContractAgentSessionTranscript;

export interface FrozenSkill {
  readonly versionRef: string;
  readonly artifactDigest: string;
  readonly skillName: string;
  readonly files: readonly SkillFile[];
}

/** Context-owned MCP servers that Codex connects to from an Agent workspace. */
export type ContextMcpServer = string;

export interface ContextMcpConnection {
  readonly context: ContextMcpServer;
  readonly agentId: string;
  /** Run-scoped principal registered and signed by Experiment. */
  readonly principalId: string;
  readonly endpoint: string;
  /** Audience-specific Experiment JWS; never returned in runtime evidence. */
  readonly credential: string;
}

export type MemoryToolProfile = "combined-v1" | "split-v2" | "hook-v1";

export type ContinuityRuntimeProfile = "legacy-tools-v1" | "hook-v1";

export interface CodexHookPolicy {
  readonly strategyInjectionEnabled: boolean;
  readonly revision: number;
  readonly updatedAt: string;
}

/** Runtime-owned binding for agent-private continuity Dynamic Tools. */
export interface AgentMemoryBinding {
  readonly bankId: string;
  readonly routeId: string;
  readonly llmConfigRevision: string;
  readonly roundId: number;
  readonly toolProfile: MemoryToolProfile;
}

/** Agent Execution-owned policy frozen into every newly-created Agent workspace. */
export interface ContextCompactionPolicy {
  readonly mode: "auto";
  readonly tokenLimit: number;
  /** `body_after_prefix` remains valid for immutable artifacts created before the 64K total policy. */
  readonly scope: "total" | "body_after_prefix";
  readonly prompt: "codex-default";
}

export interface AgentContextCompaction {
  readonly itemId: string;
  readonly completedAt: string;
}

export interface ToolCallBudget {
  readonly maxCallsPerToolPerTurn: number;
}

export interface ToolCallBudgetEvidence extends ToolCallBudget {
  readonly counts: readonly { readonly toolName: string; readonly calls: number }[];
  readonly termination?: {
    readonly reason: "tool_repeat_budget_exhausted";
    readonly toolName: string;
    readonly limit: number;
    readonly attemptedCall: number;
    readonly toolUseId: string;
    readonly occurredAt: string;
  };
}

export interface ExecutionResult {
  readonly agentId: string;
  readonly candidates: readonly CandidateAction[];
  /** The final Codex text is evidence only; actions come from MCP staging. */
  readonly evidenceRef: string;
  readonly transcriptRef?: string;
  /** Exact upstream-response usage captured from Codex app-server notifications. */
  readonly tokenUsage?: AgentTurnTokenUsage;
}

export interface TokenUsageBreakdown {
  readonly totalTokens: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
}

export interface TokenAttributedToolCall {
  readonly callId: string;
  readonly name: string;
  readonly namespace?: string;
}

export type TokenAttributionClassification =
  | "mcp_action"
  | "final_response"
  | "batched_actions"
  | "unclassified";

/**
 * One record per upstream model response. Tokens are never divided between
 * multiple tool calls: a response with multiple calls remains one batch.
 */
export interface ActionTokenAttribution {
  readonly responseId: string;
  readonly sequence: number;
  readonly classification: TokenAttributionClassification;
  readonly toolCalls: readonly TokenAttributedToolCall[];
  readonly usage: TokenUsageBreakdown | null;
}

export type TokenUsageCompleteness =
  | "complete"
  | "missing_usage"
  | "batched_actions"
  | "missing_usage_and_batched_actions";

export interface AgentTurnTokenUsage {
  readonly threadId: string;
  readonly turnId: string;
  readonly responses: readonly ActionTokenAttribution[];
  /** Sum of all non-null raw response usage records. */
  readonly totals: TokenUsageBreakdown;
  /** App-server's independent turn-level counter, used as a cross-check. */
  readonly turnCounter: TokenUsageBreakdown | null;
  /** App-server's cumulative thread counter at the end of this Turn. */
  readonly threadCounter?: TokenUsageBreakdown | null;
  readonly modelContextWindow?: number | null;
  /** Native context-compaction items completed during this Turn. */
  readonly compactions?: readonly AgentContextCompaction[];
  readonly toolCallBudget?: ToolCallBudgetEvidence;
  readonly countersMatch: boolean | null;
  readonly completeness: TokenUsageCompleteness;
}

export interface RunAgentTurnTokenUsage extends AgentTurnTokenUsage {
  readonly runId: string;
  readonly roundId: number;
  readonly agentId: string;
}

export type Mutation = MutationHeader;
export type AgentCheckpoint = ContractCheckpoint;

export interface ExecutionKey {
  readonly runId: string;
  readonly roundId: number;
  readonly agentId: string;
}

export interface ExecuteAgentInput {
  readonly runId: string;
  readonly roundId: number;
  readonly agentId: string;
  readonly attemptId?: string;
  readonly orchestrationTurnId?: string;
  /** UTC calendar date derived by Experiment's simulation clock. */
  readonly utcDate: string;
  readonly mutation: Mutation;
}

export interface ExecutionResponse {
  readonly results: readonly ExecutionResult[];
  readonly replayed: boolean;
}

export interface CommittedExecution {
  readonly key: ExecutionKey;
  readonly result: ExecutionResult;
}

export interface StaticArtifact {
  readonly agentId: string;
  /** Host path, bind-mounted into the run's sandbox. */
  readonly workspacePath: string;
  /** The corresponding pathname as seen by the per-run sandbox. */
  readonly sandboxWorkspacePath: string;
  readonly agentsMd: string;
  readonly skills: readonly FrozenSkill[];
  readonly codexConfig: string;
  /** System-owned model instructions; never sourced from an external model router. */
  readonly baseInstructions: string;
  /** A stable environment description with no host current_date. */
  readonly developerInstructions: string;
  readonly instructionPolicyVersion: string;
  readonly instructionPolicyDigest: string;
  /** Missing only on historical artifacts created before native compaction was frozen. */
  readonly contextCompactionPolicy?: ContextCompactionPolicy;
  /** Missing only on historical Runs created before repeat budgets existed. */
  readonly toolCallBudget?: ToolCallBudget;
  readonly mcpConnections: readonly ContextMcpConnection[];
  /** Digest of the complete frozen static Agent condition: AGENTS.md plus Skills. */
  readonly conditionDigest: string;
  readonly manifestDigest: string;
}

/** Mutable source record for a raw AGENTS.md file. */
export interface AgentsMdDraft {
  readonly templateId: string;
  readonly name: string;
  readonly source: string;
  readonly revision: number;
  readonly updatedAt: string;
}

/** Immutable raw AGENTS.md version. Its source is written byte-for-byte. */
export interface AgentsMdVersion extends Omit<AgentsMdDraft, "revision" | "updatedAt"> {
  readonly versionRef: string;
  readonly artifactDigest: string;
  readonly publishedAt: string;
  readonly draftRevision: number;
}

export interface McpPolicyDraft extends McpPolicyDefinition {
  readonly policyId: string;
  readonly name: string;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface McpPolicyVersion extends Omit<McpPolicyDraft, "revision" | "updatedAt"> {
  readonly versionRef: string;
  readonly artifactDigest: string;
  readonly publishedAt: string;
  readonly draftRevision: number;
}

export interface SkillDraft extends SkillDefinition {
  readonly skillId: string;
  readonly name: string;
  readonly skillName: string;
  readonly description: string;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface SkillVersion extends Omit<SkillDraft, "revision" | "updatedAt"> {
  readonly versionRef: string;
  readonly artifactDigest: string;
  readonly publishedAt: string;
  readonly draftRevision: number;
}

/**
 * Credential-free, immutable Codex material owned by Agent Execution.
 * The DeepSeek API key is supplied only to the sandbox process environment.
 */
export interface CodexRuntimeProfile {
  readonly model: string;
  readonly provider: string;
  readonly reasoningEffort: string;
  readonly providerConfigToml: string;
  /** Empty for providers whose catalog is supplied by Codex account discovery. */
  readonly modelsJson: string;
  /** SHA-256 digest of the non-secret provider and model catalog configuration. */
  readonly configDigest: string;
}

/** Durable identity and lifecycle of a run-scoped Codex sandbox. */
export type SandboxLifecycle = "running" | "stopped" | "released" | "failed";

/**
 * This is intentionally persisted with the run instead of being process-local.
 * A later Agent Execution process can reconnect to the same sandbox, or start
 * it again and resume the already-persisted Codex thread IDs.
 */
export interface SandboxDescriptor {
  readonly runId: string;
  readonly containerId: string | null;
  readonly containerName: string;
  readonly endpoint: string;
  readonly hostRunRoot: string;
  readonly remoteRunRoot: string;
  readonly codexHomePath: string;
  /** Docker networks selected from this Run's frozen Context authority. */
  readonly networks?: readonly string[];
  readonly lifecycle: SandboxLifecycle;
  /** Increments whenever a stopped/released container is replaced or restarted. */
  readonly restartCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly releasedAt?: string;
}

/** Deliberately no-secret lifecycle data exposed to the Experiment orchestration. */
export interface SandboxRuntimeEvidence {
  readonly state: "active" | "released" | "unavailable";
  readonly restartCount: number;
  readonly createdAt?: string;
  readonly releasedAt?: string;
}

/** A non-secret default offered only for compatibility clients. */
export interface AgentExecutionRuntimeCapability {
  readonly model: string;
  readonly configDigest: string;
}

export interface WorkspaceDriftEvent {
  readonly runId: string;
  readonly agentId: string;
  readonly roundId: number;
  readonly phase: "before_turn" | "after_turn";
  readonly detectedAt: string;
  readonly expectedDigest: string;
  readonly observedDigest: string;
  readonly restored: true;
}

export interface InstructionPolicyMigration {
  readonly from: "legacy-model-catalog";
  readonly to: string;
  readonly checkpointRef: string;
  readonly migratedAt: string;
}
