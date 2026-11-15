import type {
  AgentBackendName,
  AgentExecutionSection,
  AgentIdentity,
  AgentsMdDraft,
  AgentsMdVersion,
  McpPolicyDraft,
  McpPolicyVersion,
  SkillDraft,
  SkillVersion,
  CandidateAction,
  JsonValue,
  SandboxDescriptor,
  StaticArtifact,
  WorkspaceDriftEvent,
  CodexRuntimeProfile,
  FrozenTurnPrompt,
  AgentTurnTokenUsage,
  ContextMcpConnection,
  AgentMemoryBinding,
  ContextCompactionPolicy,
  ToolCallBudget,
  AgentSessionTranscript,
  CodexHookPolicy,
  ContinuityRuntimeProfile,
} from "./types";
import type { AssetTombstone } from "@openleek/contracts/assets";

export interface BackendExecutionInput {
  readonly runId: string;
  readonly roundId: number;
  readonly attemptId: string;
  readonly orchestrationTurnId: string;
  readonly agent: AgentIdentity;
  readonly model: string;
  /** Explicit Codex provider selected by the immutable native runtime profile. */
  readonly modelProvider: string;
  /** This is deliberately the whole provider input. */
  readonly text: string;
  /** Null means this is the agent's first persisted cognition turn. */
  readonly sessionId: string | null;
  /** The run-scoped sandbox selected by Agent Execution, never a global host. */
  readonly sandbox: SandboxDescriptor;
  /** CWD within that sandbox; it maps to the immutable static workspace. */
  readonly sandboxWorkspacePath: string;
  /** Per-Agent Context credentials supplied as thread-scoped Codex overrides. */
  readonly mcpConnections: readonly ContextMcpConnection[];
  readonly baseInstructions: string;
  readonly developerInstructions: string;
  readonly memory?: AgentMemoryBinding;
  readonly contextCompactionPolicy?: ContextCompactionPolicy;
  readonly toolCallBudget?: ToolCallBudget;
}

export interface BackendExecutionOutput {
  readonly sessionId: string | null;
  readonly evidence?: unknown;
  readonly tokenUsage?: AgentTurnTokenUsage;
  readonly transcript?: AgentSessionTranscript;
}

/** A backend owns Codex cognition only. It cannot receive observations or actions. */
export interface AgentExecutionBackend {
  readonly name: AgentBackendName;
  health?(): Promise<void>;
  initializeRun?(input: { readonly runId: string; readonly section: AgentExecutionSection; readonly agents: readonly AgentIdentity[] }): Promise<Readonly<Record<string, string | null>>>;
  execute(input: BackendExecutionInput): Promise<BackendExecutionOutput>;
  forkRun?(input: {
    readonly sourceRunId: string;
    readonly targetRunId: string;
    readonly agents: readonly AgentIdentity[];
    readonly sourceSessions: Readonly<Record<string, string | null>>;
  }): Promise<Readonly<Record<string, string | null>>>;
}

/** A storage port has no visibility into another Context's database. */
export interface AgentExecutionStateStore {
  initialize?(): Promise<void>;
  load(): Promise<AgentExecutionSnapshot | null>;
  save(snapshot: AgentExecutionSnapshot): Promise<void>;
  commitExecution?(snapshot: AgentExecutionSnapshot, transcript: AgentSessionTranscript): Promise<void>;
  appendTranscript?(transcript: AgentSessionTranscript): Promise<void>;
  listTranscripts?(runId: string): Promise<readonly AgentSessionTranscript[]>;
}

export interface PersistedAgentRun {
  readonly runId: string;
  readonly model: string;
  readonly profile: CodexRuntimeProfile;
  readonly agents: readonly AgentIdentity[];
  readonly sessions: Readonly<Record<string, string | null>>;
  readonly sandbox: SandboxDescriptor;
  readonly artifacts: readonly StaticArtifact[];
  readonly executions: readonly PersistedExecution[];
  readonly driftEvents: readonly WorkspaceDriftEvent[];
  readonly instructionPolicyMigrations: readonly import("./types").InstructionPolicyMigration[];
  readonly sealed: readonly AgentCheckpointSnapshot[];
  readonly publishedRound: number;
  readonly turnPrompt: FrozenTurnPrompt;
  readonly memoryProfile?: { readonly routeId: string; readonly llmConfigRevision: string };
  readonly toolCallBudget?: ToolCallBudget;
  readonly continuityRuntimeProfile: ContinuityRuntimeProfile;
  readonly hookPolicy: CodexHookPolicy;
  readonly lineageParentCheckpointRef?: string;
  /** Audit-only migrated state from the removed prompt/observation runtime. */
  readonly legacy?: boolean;
}

export interface PersistedExecution {
  readonly roundId: number;
  readonly agentId: string;
  readonly result: {
    readonly agentId: string;
    readonly candidates: readonly CandidateAction[];
    readonly evidenceRef: string;
    readonly transcriptRef?: string;
    readonly tokenUsage?: AgentTurnTokenUsage;
  };
}

export interface AgentCheckpointSnapshot {
  readonly ref: string;
  readonly runId: string;
  readonly roundId: number;
  readonly digest: string;
  readonly parentRef?: string;
  readonly staticArtifactDigest?: string;
  readonly model?: string;
  readonly codexConfigDigest?: string;
  readonly toolCallBudget?: ToolCallBudget;
}

/** A started mutation is durable to protect partial-success replay. */
export interface PersistedIdempotencyRecord {
  readonly key: string;
  readonly digest: string;
  readonly state: "started" | "completed";
  readonly response?: JsonValue;
}

export interface AgentExecutionSnapshot {
  readonly version: 16;
  readonly runs: readonly PersistedAgentRun[];
  readonly idempotency: readonly PersistedIdempotencyRecord[];
  readonly agentsMdDrafts: readonly AgentsMdDraft[];
  readonly agentsMdVersions: readonly AgentsMdVersion[];
  readonly mcpPolicyDrafts: readonly McpPolicyDraft[];
  readonly mcpPolicyVersions: readonly McpPolicyVersion[];
  readonly skillDrafts: readonly SkillDraft[];
  readonly skillVersions: readonly SkillVersion[];
  readonly assetTombstones?: readonly AssetTombstone[];
  /** Audit-only archive retained when Turn Prompt ownership moved to Experiment. */
  readonly legacyTurnPromptAssets?: {
    readonly drafts: readonly unknown[];
    readonly versions: readonly unknown[];
  };
}

export interface SqlExecutor {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly T[] }>;
  transaction?<T>(operation: (executor: SqlExecutor) => Promise<T>): Promise<T>;
}
