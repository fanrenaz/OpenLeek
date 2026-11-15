import { agentExecutionSectionSchema, mcpPolicyDefinitionSchema, type McpPolicyDefinition, type SkillDefinition } from "@openleek/contracts/agent";
import type { AssetDeletionResult, AssetDeleteTarget, AssetTombstone } from "@openleek/contracts/assets";
import { checkpointSchema } from "@openleek/contracts/context";
import { parseMutationHeader } from "@openleek/contracts/core";
import { frozenTurnPromptSchema } from "@openleek/contracts/turn-prompt";
import { randomUUID } from "node:crypto";

import { sha256 } from "./canonical";
import { idempotencyConflict, invalidArgument, notFound, preconditionFailed, retryable } from "./errors";
import type {
  AgentExecutionBackend,
  AgentExecutionSnapshot,
  AgentExecutionStateStore,
  PersistedAgentRun,
  PersistedIdempotencyRecord,
} from "./ports";
import type {
  AgentCheckpoint,
  AgentExecutionSection,
  AgentExecutionRuntimeCapability,
  AgentIdentity,
  AgentsMdDraft,
  AgentsMdVersion,
  CommittedExecution,
  ExecuteAgentInput,
  ExecutionKey,
  ExecutionResponse,
  ExecutionResult,
  ContextMcpConnection,
  Mutation,
  CodexRuntimeProfile,
  SandboxDescriptor,
  SandboxRuntimeEvidence,
  StaticArtifact,
  WorkspaceDriftEvent,
  FrozenTurnPrompt,
  FrozenSkill,
  InstructionPolicyMigration,
  McpPolicyDraft,
  McpPolicyVersion,
  SkillDraft,
  SkillVersion,
  RunAgentTurnTokenUsage,
  CodexHookPolicy,
  ContinuityRuntimeProfile,
  ToolCallBudget,
  AgentSessionTranscript,
} from "./types";
import { WorkspaceArtifacts, type WorkspaceArtifactOptions } from "./workspace-artifacts";
import { InMemorySandboxManager, type SandboxManager } from "./sandbox";
import { deepSeekCodexProfile, DEEPSEEK_MODEL } from "./deepseek-codex";
import { ChatGptAuthClient, openAiCodexProfile } from "./chatgpt-auth";
import { OPENLEEK_CONTEXT_COMPACTION_POLICY } from "./runtime-instructions";
import { renderTurnPrompt } from "./turn-prompt";
import { validateSkillDefinition } from "./skill-definition";
import type { MemoryToolPort } from "./memory-tools";

interface AgentRun {
  readonly runId: string;
  readonly model: string;
  readonly profile: CodexRuntimeProfile;
  readonly memoryProfile?: { readonly routeId: string; readonly llmConfigRevision: string };
  readonly toolCallBudget?: ToolCallBudget;
  readonly continuityRuntimeProfile: ContinuityRuntimeProfile;
  hookPolicy: CodexHookPolicy;
  readonly agents: readonly AgentIdentity[];
  readonly sessions: Record<string, string | null>;
  sandbox: SandboxDescriptor;
  readonly artifacts: Map<string, StaticArtifact>;
  readonly executions: Map<string, StoredExecution>;
  readonly driftEvents: WorkspaceDriftEvent[];
  readonly instructionPolicyMigrations: InstructionPolicyMigration[];
  readonly sealed: Map<number, AgentCheckpoint>;
  readonly lineageParentCheckpointRef?: string;
  readonly turnPrompt: FrozenTurnPrompt;
  publishedRound: number;
}

interface StoredExecution { readonly key: ExecutionKey; readonly result: ExecutionResult; }
interface IdempotencyRecord { readonly digest: string; state: "started" | "completed"; response?: unknown; }

export interface MutationOutcome<T> { readonly value: T; readonly replayed: boolean; }

export interface AgentExecutionServiceOptions extends WorkspaceArtifactOptions {
  /** Optional test override for the legacy compatibility capability. */
  readonly runtimeCapability?: AgentExecutionRuntimeCapability;
  readonly chatGptAuth?: ChatGptAuthClient;
  /** Production supplies DockerSandboxManager; tests get a no-I/O manager. */
  readonly sandboxManager?: SandboxManager;
  /** Runtime-only memory lifecycle; Agents never receive this administrative port. */
  readonly memoryPort?: MemoryToolPort;
}
/**
 * Agent Execution owns static workspaces, provider sessions, drift recovery,
 * idempotency, and checkpoint lifecycle. Contexts own MCP scopes and world
 * actions; Codex receives only the frozen Turn Prompt rendered for this round.
 */
export class AgentExecutionService {
  private readonly runs = new Map<string, AgentRun>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly runLocks = new Map<string, Promise<void>>();
  private readonly inFlight = new Map<string, Promise<ExecutionResponse>>();
  /** Agent Execution owns raw AGENTS.md source and published immutable versions. */
  private readonly agentsMdDrafts = new Map<string, AgentsMdDraft>();
  private readonly agentsMdVersions = new Map<string, AgentsMdVersion>();
  private readonly mcpPolicyDrafts = new Map<string, McpPolicyDraft>();
  private readonly mcpPolicyVersions = new Map<string, McpPolicyVersion>();
  private readonly skillDrafts = new Map<string, SkillDraft>();
  private readonly skillVersions = new Map<string, SkillVersion>();
  private readonly assetTombstones = new Map<string, AssetTombstone>();
  private legacyTurnPromptAssets: { drafts: unknown[]; versions: unknown[] } = { drafts: [], versions: [] };
  private readonly artifacts: WorkspaceArtifacts;
  private readonly sandboxManager: SandboxManager;

  private constructor(
    private readonly backend: AgentExecutionBackend,
    private readonly stateStore: AgentExecutionStateStore,
    private readonly options: AgentExecutionServiceOptions,
  ) {
    this.artifacts = new WorkspaceArtifacts(options);
    this.sandboxManager = options.sandboxManager ?? new InMemorySandboxManager();
  }

  static async open(backend: AgentExecutionBackend, stateStore: AgentExecutionStateStore, options: AgentExecutionServiceOptions = {}): Promise<AgentExecutionService> {
    if (backend.name !== "codex") invalidArgument("public Agent Execution only supports the Codex backend");
    if (options.runtimeCapability !== undefined && !options.runtimeCapability.model.trim()) invalidArgument("configured Agent Execution model must not be empty");
    const service = new AgentExecutionService(backend, stateStore, options);
    await stateStore.initialize?.();
    const snapshot = await stateStore.load();
    if (snapshot !== null) {
      const needsMigration = typeof snapshot === "object"
        && snapshot !== null
        && ((snapshot as { version?: unknown }).version === 14 || (snapshot as { version?: unknown }).version === 15);
      service.restore(snapshot);
      if (needsMigration) await service.persist();
    }
    return service;
  }

  validate(sectionInput: unknown): AgentExecutionSection {
    return agentExecutionSectionSchema.parse(sectionInput);
  }

  listAgentsMd(includeDeleted = false): { drafts: AgentsMdDraft[]; versions: AgentsMdVersion[]; tombstones?: AssetTombstone[] } {
    return {
      drafts: [...this.agentsMdDrafts.values()].filter((item) => includeDeleted || !this.deleted("agents-md", "draft", item.templateId)).sort((left, right) => left.name.localeCompare(right.name)).map(clone),
      versions: [...this.agentsMdVersions.values()].filter((item) => includeDeleted || !this.deleted("agents-md", "version", item.versionRef)).sort((left, right) => right.publishedAt.localeCompare(left.publishedAt)).map(clone),
      ...(includeDeleted ? { tombstones: this.tombstones("agents-md") } : {}),
    };
  }

  getAgentsMdDraft(templateId: string, includeDeleted = false): AgentsMdDraft {
    const draft = this.agentsMdDrafts.get(templateId);
    if (!draft || (!includeDeleted && this.deleted("agents-md", "draft", templateId))) notFound(`unknown AGENTS.md draft '${templateId}'`);
    return clone(draft);
  }

  getAgentsMdVersion(versionRef: string, includeDeleted = false): AgentsMdVersion { return clone(this.requireAgentsMdVersion(versionRef, includeDeleted)); }

  async saveAgentsMdDraft(input: { templateId?: string; expectedRevision?: number; name: string; source: string }): Promise<AgentsMdDraft> {
    if (!input.name.trim()) invalidArgument("AGENTS.md template name must not be empty", { name: "must not be empty" });
    if (!input.source.trim()) invalidArgument("AGENTS.md source must not be empty", { source: "must not be empty" });
    const templateId = input.templateId ?? `agents-md:${randomUUID()}`;
    if (this.deleted("agents-md", "draft", templateId)) preconditionFailed("deleted AGENTS.md draft IDs cannot be reused");
    const existing = this.agentsMdDrafts.get(templateId);
    if (existing && input.expectedRevision !== existing.revision) preconditionFailed("AGENTS.md draft has changed; reload before saving");
    if (!existing && input.expectedRevision !== undefined) notFound("AGENTS.md draft does not exist");
    const draft: AgentsMdDraft = {
      templateId,
      name: input.name.trim(),
      // Preserve raw Markdown exactly. No interpolation, header, or core rules.
      source: input.source,
      revision: (existing?.revision ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    this.agentsMdDrafts.set(templateId, draft);
    await this.persist();
    return clone(draft);
  }

  async publishAgentsMd(input: { templateId: string; expectedRevision: number }): Promise<AgentsMdVersion> {
    const draft = this.agentsMdDrafts.get(input.templateId);
    if (!draft) notFound(`unknown AGENTS.md draft '${input.templateId}'`);
    if (draft.revision !== input.expectedRevision) preconditionFailed("AGENTS.md draft has changed; reload before publishing");
    const artifactDigest = sha256({ source: draft.source });
    const existing = [...this.agentsMdVersions.values()].find((version) => version.artifactDigest === artifactDigest);
    if (existing) {
      if (this.deleted("agents-md", "version", existing.versionRef)) preconditionFailed("identical content belongs to a deleted AGENTS.md version");
      return clone(existing);
    }
    const version: AgentsMdVersion = {
      templateId: draft.templateId,
      name: draft.name,
      source: draft.source,
      versionRef: `agents-md:${draft.templateId}:${artifactDigest.slice(0, 16)}`,
      artifactDigest,
      publishedAt: new Date().toISOString(),
      draftRevision: draft.revision,
    };
    this.agentsMdVersions.set(version.versionRef, version);
    await this.persist();
    return clone(version);
  }

  validateAgentsMdVersions(versionRefs: readonly string[]): void {
    for (const versionRef of versionRefs) this.requireAgentsMdVersion(versionRef);
  }

  listMcpPolicies(includeDeleted = false): { drafts: McpPolicyDraft[]; versions: McpPolicyVersion[]; tombstones?: AssetTombstone[] } {
    return {
      drafts: [...this.mcpPolicyDrafts.values()].filter((item) => includeDeleted || !this.deleted("mcp-policy", "draft", item.policyId)).sort((a, b) => a.name.localeCompare(b.name)).map(clone),
      versions: [...this.mcpPolicyVersions.values()].filter((item) => includeDeleted || !this.deleted("mcp-policy", "version", item.versionRef)).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).map(clone),
      ...(includeDeleted ? { tombstones: this.tombstones("mcp-policy") } : {}),
    };
  }

  getMcpPolicyDraft(policyId: string, includeDeleted = false): McpPolicyDraft {
    const value = this.mcpPolicyDrafts.get(policyId);
    if (!value || (!includeDeleted && this.deleted("mcp-policy", "draft", policyId))) notFound("MCP Policy draft does not exist");
    return clone(value);
  }

  getMcpPolicyVersion(versionRef: string, includeDeleted = false): McpPolicyVersion {
    return clone(this.requireMcpPolicyVersion(versionRef, includeDeleted));
  }

  async saveMcpPolicyDraft(input: {
    policyId?: string;
    expectedRevision?: number;
    name: string;
    tools: McpPolicyDefinition["tools"];
    resources: McpPolicyDefinition["resources"];
    contexts?: McpPolicyDefinition["contexts"];
  }): Promise<McpPolicyDraft> {
    if (!input.name.trim()) invalidArgument("MCP Policy name must not be empty");
    const definition = normalizeMcpPolicy({ tools: input.tools, resources: input.resources, contexts: input.contexts ?? {} });
    const policyId = input.policyId ?? `mcp-policy:${randomUUID()}`;
    if (this.deleted("mcp-policy", "draft", policyId)) preconditionFailed("deleted MCP Policy draft IDs cannot be reused");
    const existing = this.mcpPolicyDrafts.get(policyId);
    if (existing && existing.revision !== input.expectedRevision) preconditionFailed("MCP Policy draft has changed; reload before saving");
    if (!existing && input.expectedRevision !== undefined) notFound("MCP Policy draft does not exist");
    const draft: McpPolicyDraft = {
      policyId,
      name: input.name.trim(),
      ...definition,
      revision: (existing?.revision ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    this.mcpPolicyDrafts.set(policyId, draft);
    await this.persist();
    return clone(draft);
  }

  async publishMcpPolicy(input: { policyId: string; expectedRevision: number }): Promise<McpPolicyVersion> {
    const draft = this.getMcpPolicyDraft(input.policyId);
    if (draft.revision !== input.expectedRevision) preconditionFailed("MCP Policy draft has changed; reload before publishing");
    const definition = normalizeMcpPolicy({ tools: draft.tools, resources: draft.resources, contexts: draft.contexts });
    const artifactDigest = sha256(definition);
    const found = [...this.mcpPolicyVersions.values()].find((item) => item.artifactDigest === artifactDigest);
    if (found) {
      if (this.deleted("mcp-policy", "version", found.versionRef)) preconditionFailed("identical content belongs to a deleted MCP Policy version");
      return clone(found);
    }
    const version: McpPolicyVersion = {
      policyId: draft.policyId,
      name: draft.name,
      ...definition,
      versionRef: `mcp-policy:${draft.policyId}:${artifactDigest.slice(0, 16)}`,
      artifactDigest,
      publishedAt: new Date().toISOString(),
      draftRevision: draft.revision,
    };
    this.mcpPolicyVersions.set(version.versionRef, version);
    await this.persist();
    return clone(version);
  }

  listSkills(includeDeleted = false): { drafts: SkillDraft[]; versions: SkillVersion[]; tombstones?: AssetTombstone[] } {
    return {
      drafts: [...this.skillDrafts.values()].filter((item) => includeDeleted || !this.deleted("skill", "draft", item.skillId)).sort((a, b) => a.name.localeCompare(b.name)).map(clone),
      versions: [...this.skillVersions.values()].filter((item) => includeDeleted || !this.deleted("skill", "version", item.versionRef)).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).map(clone),
      ...(includeDeleted ? { tombstones: this.tombstones("skill") } : {}),
    };
  }

  getSkillDraft(skillId: string, includeDeleted = false): SkillDraft {
    const value = this.skillDrafts.get(skillId);
    if (!value || (!includeDeleted && this.deleted("skill", "draft", skillId))) notFound("Skill draft does not exist");
    return clone(value);
  }

  getSkillVersion(versionRef: string, includeDeleted = false): SkillVersion {
    return clone(this.requireSkillVersion(versionRef, includeDeleted));
  }

  validateSkill(input: SkillDefinition): ReturnType<typeof validateSkillDefinition> {
    return validateSkillDefinition(input);
  }

  async saveSkillDraft(input: {
    skillId?: string;
    expectedRevision?: number;
    name: string;
    files: SkillDefinition["files"];
    requirements: SkillDefinition["requirements"];
  }): Promise<SkillDraft> {
    if (!input.name.trim()) invalidArgument("Skill asset name must not be empty");
    const definition = validateSkillDefinition({ files: input.files, requirements: input.requirements });
    const skillId = input.skillId ?? `skill:${randomUUID()}`;
    if (this.deleted("skill", "draft", skillId)) preconditionFailed("deleted Skill draft IDs cannot be reused");
    const existing = this.skillDrafts.get(skillId);
    if (existing && existing.revision !== input.expectedRevision) preconditionFailed("Skill draft has changed; reload before saving");
    if (!existing && input.expectedRevision !== undefined) notFound("Skill draft does not exist");
    const draft: SkillDraft = {
      skillId,
      name: input.name.trim(),
      skillName: definition.skillName,
      description: definition.description,
      files: definition.files,
      requirements: definition.requirements,
      revision: (existing?.revision ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    this.skillDrafts.set(skillId, draft);
    await this.persist();
    return clone(draft);
  }

  async publishSkill(input: { skillId: string; expectedRevision: number }): Promise<SkillVersion> {
    const draft = this.getSkillDraft(input.skillId);
    if (draft.revision !== input.expectedRevision) preconditionFailed("Skill draft has changed; reload before publishing");
    const definition = validateSkillDefinition({ files: draft.files, requirements: draft.requirements });
    const artifactDigest = sha256({ files: definition.files, requirements: definition.requirements });
    const found = [...this.skillVersions.values()].find((item) => item.artifactDigest === artifactDigest);
    if (found) {
      if (this.deleted("skill", "version", found.versionRef)) preconditionFailed("identical content belongs to a deleted Skill version");
      return clone(found);
    }
    const version: SkillVersion = {
      skillId: draft.skillId,
      name: draft.name,
      skillName: definition.skillName,
      description: definition.description,
      files: definition.files,
      requirements: definition.requirements,
      versionRef: `skill:${draft.skillId}:${artifactDigest.slice(0, 16)}`,
      artifactDigest,
      publishedAt: new Date().toISOString(),
      draftRevision: draft.revision,
    };
    this.skillVersions.set(version.versionRef, version);
    await this.persist();
    return clone(version);
  }

  validateSkillVersions(versionRefs: readonly string[]): SkillVersion[] {
    return this.resolveSkillVersions(versionRefs).map(clone);
  }

  deleteAgentsMdDraft(input: { templateId: string; expectedRevision: number; idempotencyKey: string }) { return this.deleteDraft("agents-md", input.templateId, input.expectedRevision, input.idempotencyKey, this.agentsMdDrafts); }
  deleteAgentsMdVersion(input: { versionRef: string; idempotencyKey: string }) { return this.deleteVersion("agents-md", input.versionRef, input.idempotencyKey, this.agentsMdVersions); }
  deleteMcpPolicyDraft(input: { policyId: string; expectedRevision: number; idempotencyKey: string }) { return this.deleteDraft("mcp-policy", input.policyId, input.expectedRevision, input.idempotencyKey, this.mcpPolicyDrafts); }
  deleteMcpPolicyVersion(input: { versionRef: string; idempotencyKey: string }) { return this.deleteVersion("mcp-policy", input.versionRef, input.idempotencyKey, this.mcpPolicyVersions); }
  deleteSkillDraft(input: { skillId: string; expectedRevision: number; idempotencyKey: string }) { return this.deleteDraft("skill", input.skillId, input.expectedRevision, input.idempotencyKey, this.skillDrafts); }
  deleteSkillVersion(input: { versionRef: string; idempotencyKey: string }) { return this.deleteVersion("skill", input.versionRef, input.idempotencyKey, this.skillVersions); }

  runtimeCapability(): AgentExecutionRuntimeCapability {
    return this.options.runtimeCapability ?? {
      model: DEEPSEEK_MODEL,
      configDigest: deepSeekCodexProfile().configDigest,
    };
  }

  async executionProviders(): Promise<unknown> {
    const deepseek = { provider: "deepseek", available: true, models: [{ id: DEEPSEEK_MODEL, displayName: "DeepSeek V4 Flash", defaultReasoningEffort: "high", supportedReasoningEfforts: ["high", "xhigh"] }] };
    if (!this.options.chatGptAuth) return { providers: [deepseek, { provider: "openai", available: false, account: null, models: [] }] };
    const status = await this.options.chatGptAuth.status();
    const models = status.account?.type === "chatgpt" ? await this.options.chatGptAuth.models() : { data: [] };
    return { providers: [deepseek, { provider: "openai", available: status.account?.type === "chatgpt", ...status, models: normalizeCodexModels(models) }] };
  }

  chatGptAuthStatus() { if (!this.options.chatGptAuth) preconditionFailed("ChatGPT authorization is not configured"); return this.options.chatGptAuth.status(); }
  startChatGptDeviceAuthorization() { if (!this.options.chatGptAuth) preconditionFailed("ChatGPT authorization is not configured"); return this.options.chatGptAuth.startDeviceLogin(); }
  cancelChatGptDeviceAuthorization() { if (!this.options.chatGptAuth) preconditionFailed("ChatGPT authorization is not configured"); return this.options.chatGptAuth.cancelDeviceLogin(); }
  logoutChatGpt() { if (!this.options.chatGptAuth) preconditionFailed("ChatGPT authorization is not configured"); return this.options.chatGptAuth.logout(); }
  chatGptRateLimits() { if (!this.options.chatGptAuth) preconditionFailed("ChatGPT authorization is not configured"); return this.options.chatGptAuth.rateLimits(); }

  async initialize(runId: string, input: { section: unknown; turnPrompt: unknown; agents: readonly { agentId: string; agentsMdVersionRef: string; skillVersionRefs?: readonly string[]; mcpContexts: readonly string[] }[] }, mutationInput: unknown, mcp: readonly ContextMcpConnection[]): Promise<MutationOutcome<AgentCheckpoint>> {
    const hasExplicitToolCallBudget = input.section !== null && typeof input.section === "object" && Object.prototype.hasOwnProperty.call(input.section, "toolCallBudget");
    const section = this.validate(input.section);
    const turnPrompt = frozenTurnPromptSchema.parse(input.turnPrompt);
    const mutation = parseMutationHeader(mutationInput, { initialization: true });
    if (mutation.expectedCheckpointRef !== "") invalidArgument("initialization must use an empty expectedCheckpointRef", { "mutation.expectedCheckpointRef": "must be empty for initialization" });
    requireIdentifier(runId, "runId");
    return this.withRunLock(runId, async () => this.mutate(mutation, async () => {
      const existing = this.runs.get(runId);
      if (existing !== undefined) {
        return this.checkpoint(existing, 0);
      }
      const agents = input.agents.map((agent) => this.identityFromPublishedAgentsMd(agent));
      uniqueAgentBindings(agents);
      const connections = mcpConnections(agents, mcp);
      const profile = await this.profileFor(section);
      await this.artifacts.restoreProfile(runId, profile, OPENLEEK_CONTEXT_COMPACTION_POLICY);
      const artifacts = new Map<string, StaticArtifact>();
      for (const agent of agents) {
        const connection = connections.get(agent.agentId);
        if (!connection) throw new Error("Agent Execution invariant: Context MCP connections are missing");
        artifacts.set(agent.agentId, await this.artifacts.create({ runId, agent, agentsMd: this.requireAgentsMdVersion(agent.agentsMdVersionRef, true).source, profile, mcpConnections: connection, ...(hasExplicitToolCallBudget ? { toolCallBudget: section.toolCallBudget } : {}) }));
      }
      const sandbox = await this.sandboxManager.ensure({
        runId,
        hostRunRoot: this.artifacts.sandboxHostRunRoot(runId),
        remoteRunRoot: this.artifacts.sandboxRunRoot(runId),
        contexts: [...new Set(mcp.map((connection) => connection.context))].sort(),
        provider: profile.provider === "openai" ? "openai" : "deepseek",
      });
      const sessions = Object.fromEntries(agents.map((agent) => [agent.agentId, null])) as Record<string, string | null>;
      if (this.backend.initializeRun !== undefined) {
        const initialized = await this.backend.initializeRun({ runId, section, agents });
        for (const agent of agents) {
          const session = initialized[agent.agentId];
          if (session !== undefined && session !== null && !session.trim()) invalidArgument("backend returned an empty session id");
          if (session !== undefined) sessions[agent.agentId] = session;
        }
      }
      const run: AgentRun = {
        runId, model: profile.model, profile,
        ...(section.memoryProfile ? { memoryProfile: clone(section.memoryProfile) } : {}),
        ...(hasExplicitToolCallBudget ? { toolCallBudget: clone(section.toolCallBudget) } : {}),
        continuityRuntimeProfile: "hook-v1",
        hookPolicy: {
          strategyInjectionEnabled: true,
          revision: 1,
          updatedAt: new Date().toISOString(),
        },
        agents, sessions, sandbox, artifacts,
        executions: new Map(), driftEvents: [], instructionPolicyMigrations: [], sealed: new Map(), publishedRound: 0,
        turnPrompt: clone(turnPrompt),
      };
      this.runs.set(runId, run);
      const baseline = this.checkpoint(run, 0);
      run.sealed.set(0, baseline);
      return baseline;
    }));
  }

  private async profileFor(section: AgentExecutionSection): Promise<CodexRuntimeProfile> {
    const runtime = section.runtime ?? { provider: "deepseek" as const, model: DEEPSEEK_MODEL, reasoningEffort: "high" as const };
    if (runtime.provider === "deepseek") return deepSeekCodexProfile(runtime.reasoningEffort);
    if (!this.options.chatGptAuth) preconditionFailed("ChatGPT authorization is not configured");
    const status = await this.options.chatGptAuth.status();
    if (status.account?.type !== "chatgpt") preconditionFailed("ChatGPT account authorization is required for an OpenAI Run");
    const models = normalizeCodexModels(await this.options.chatGptAuth.models());
    const selected = models.find((model) => model.id === runtime.model);
    if (!selected) invalidArgument(`OpenAI model '${runtime.model}' is not available to the authorized account`);
    if (!selected.supportedReasoningEfforts.includes(runtime.reasoningEffort)) invalidArgument(`Reasoning effort '${runtime.reasoningEffort}' is not supported by '${runtime.model}'`);
    return openAiCodexProfile(runtime.model, runtime.reasoningEffort);
  }

  async execute(input: ExecuteAgentInput): Promise<ExecutionResponse> {
    const mutation = parseMutationHeader(input.mutation);
    requireIdentifier(input.runId, "runId"); requireIdentifier(input.agentId, "agentId");
    if (input.attemptId !== undefined) requireIdentifier(input.attemptId, "attemptId");
    if (input.orchestrationTurnId !== undefined) requireIdentifier(input.orchestrationTurnId, "orchestrationTurnId");
    requireRound(input.roundId);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.utcDate)) invalidArgument("utcDate must use YYYY-MM-DD", { utcDate: "must be a UTC calendar date" });
    const key: ExecutionKey = { runId: input.runId, roundId: input.roundId, agentId: input.agentId };
    const stableKey = executionKey(key);
    const existing = await this.withRunLock(input.runId, async () => {
      const run = this.run(input.runId);
      this.requireCurrentRuntime(run);
      const record = this.idempotency.get(mutationKey(mutation));
      if (record !== undefined && record.digest !== mutation.payloadDigest) idempotencyConflict("transitionId and stepId already exist with a different payload digest");
      if (record?.state === "completed") return { ...(clone(record.response) as ExecutionResponse), replayed: true };
      const stored = run.executions.get(stableKey);
      if (stored !== undefined) return { results: [clone(stored.result)], replayed: true } satisfies ExecutionResponse;
      this.requireExpectedCheckpoint(run, mutation);
      if (!run.agents.some((agent) => agent.agentId === input.agentId)) invalidArgument(`unknown agent '${input.agentId}' for run '${input.runId}'`);
      if (record === undefined) { this.idempotency.set(mutationKey(mutation), { digest: mutation.payloadDigest, state: "started" }); await this.persist(); }
      return undefined;
    });
    if (existing !== undefined) return existing;
    const active = this.inFlight.get(stableKey);
    if (active) return active;
    const operation = this.executeProvider(input, mutation, key);
    this.inFlight.set(stableKey, operation);
    try { return await operation; } finally { if (this.inFlight.get(stableKey) === operation) this.inFlight.delete(stableKey); }
  }

  private async executeProvider(input: ExecuteAgentInput, mutation: Mutation, key: ExecutionKey): Promise<ExecutionResponse> {
    const prepared = await this.withRunLock(input.runId, async () => {
      const run = this.run(input.runId); this.requireExpectedCheckpoint(run, mutation);
      this.requireCurrentRuntime(run);
      const agent = run.agents.find((candidate) => candidate.agentId === input.agentId);
      if (!agent) invalidArgument(`unknown agent '${input.agentId}' for run '${input.runId}'`);
      const artifact = run.artifacts.get(agent.agentId);
      if (!artifact) throw new Error("Agent Execution invariant: static artifact is missing");
      await this.artifacts.restoreProfile(run.runId, run.profile, artifact.contextCompactionPolicy);
      await this.detectAndRestoreDrift(run, artifact, input.roundId, "before_turn");
      run.sandbox = await this.sandboxManager.ensure({
        runId: run.runId,
        hostRunRoot: this.artifacts.sandboxHostRunRoot(run.runId),
        remoteRunRoot: this.artifacts.sandboxRunRoot(run.runId),
        contexts: [...new Set(run.agents.flatMap((agent) => agent.mcpContexts))].sort(),
        existing: run.sandbox,
        provider: run.profile.provider === "openai" ? "openai" : "deepseek",
      });
      await this.persist();
      return {
        agent,
        model: run.model,
        modelProvider: run.profile.provider,
        sessionId: run.sessions[input.agentId] ?? null,
        sandbox: run.sandbox,
        sandboxWorkspacePath: artifact.sandboxWorkspacePath,
        mcpConnections: artifact.mcpConnections,
        baseInstructions: artifact.baseInstructions,
        developerInstructions: artifact.developerInstructions,
        ...(artifact.contextCompactionPolicy ? { contextCompactionPolicy: artifact.contextCompactionPolicy } : {}),
        ...(run.toolCallBudget ? { toolCallBudget: clone(run.toolCallBudget) } : {}),
        ...(run.memoryProfile ? {
          memory: {
            bankId: `agent-${sha256({ runId: run.runId, agentId: agent.agentId })}`,
            routeId: run.memoryProfile.routeId,
            llmConfigRevision: run.memoryProfile.llmConfigRevision,
            roundId: input.roundId,
            toolProfile: memoryToolProfile(artifact.skills, run.continuityRuntimeProfile),
          },
        } : {}),
        text: renderTurnPrompt(run.turnPrompt, { utcDate: input.utcDate, roundId: input.roundId }),
      };
    });
    try {
      const backendResult = await this.backend.execute({
        runId: input.runId, roundId: input.roundId,
        attemptId: input.attemptId ?? `attempt:${mutation.transitionId}:${mutation.stepId}`,
        orchestrationTurnId: input.orchestrationTurnId ?? `turn:${input.runId}:${input.roundId}:${input.agentId}`,
        agent: prepared.agent, model: prepared.model, modelProvider: prepared.modelProvider,
        sessionId: prepared.sessionId,
        sandbox: prepared.sandbox,
        sandboxWorkspacePath: prepared.sandboxWorkspacePath,
        mcpConnections: prepared.mcpConnections,
        baseInstructions: prepared.baseInstructions,
        developerInstructions: prepared.developerInstructions,
        ...(prepared.contextCompactionPolicy ? { contextCompactionPolicy: prepared.contextCompactionPolicy } : {}),
        ...(prepared.toolCallBudget ? { toolCallBudget: prepared.toolCallBudget } : {}),
        ...(prepared.memory ? { memory: prepared.memory } : {}),
        text: prepared.text,
      });
      if (backendResult.sessionId !== null && !backendResult.sessionId.trim()) invalidArgument("backend returned an empty session id");
      if (!backendResult.transcript) throw new Error("Agent Execution backend did not return a complete Turn transcript");
      const transcript = backendResult.transcript;
      if (transcript.status !== "completed") {
        if (!this.stateStore.appendTranscript) throw new Error("Agent transcript storage is unavailable");
        await this.stateStore.appendTranscript(transcript);
        throw new Error(`Codex Turn ended with status '${transcript.status}'${transcript.error === null ? "" : `: ${JSON.stringify(transcript.error)}`}`);
      }
      return await this.withRunLock(input.runId, async () => {
        const run = this.run(input.runId);
        const existing = run.executions.get(executionKey(key));
        if (existing !== undefined) return { results: [clone(existing.result)], replayed: true };
        const artifact = run.artifacts.get(input.agentId);
        if (!artifact) throw new Error("Agent Execution invariant: static artifact is missing");
        await this.detectAndRestoreDrift(run, artifact, input.roundId, "after_turn");
        if (transcript.runId !== input.runId || transcript.roundId !== input.roundId || transcript.agentId !== input.agentId) {
          throw new Error("Agent Execution backend returned a transcript for a different execution");
        }
        const previousSession = run.sessions[input.agentId] ?? null;
        run.sessions[input.agentId] = backendResult.sessionId;
        const result: ExecutionResult = {
          agentId: input.agentId,
          candidates: [],
          evidenceRef: `codex:${sha256({ runId: input.runId, roundId: input.roundId, agentId: input.agentId, sessionId: backendResult.sessionId, evidence: backendResult.evidence ?? null })}`,
          transcriptRef: transcript.transcriptRef,
          ...(backendResult.tokenUsage === undefined ? {} : { tokenUsage: clone(backendResult.tokenUsage) }),
        };
        run.executions.set(executionKey(key), { key, result });
        const record = this.idempotency.get(mutationKey(mutation));
        if (!record) throw new Error("Agent Execution idempotency record disappeared");
        record.state = "completed";
        const response: ExecutionResponse = { results: [clone(result)], replayed: false };
        record.response = clone(response);
        try {
          if (!this.stateStore.commitExecution) throw new Error("Agent transcript storage is unavailable");
          await this.stateStore.commitExecution(this.snapshot(), transcript);
        } catch (error) {
          run.executions.delete(executionKey(key));
          run.sessions[input.agentId] = previousSession;
          record.state = "started";
          delete record.response;
          throw error;
        }
        return response;
      });
    } catch (error) {
      await this.withRunLock(input.runId, async () => {
        const run = this.runs.get(input.runId);
        if (run) await this.persist();
      });
      console.error("Agent cognition provider failure", { runId: input.runId, roundId: input.roundId, agentId: input.agentId, reason: error instanceof Error ? error.message : String(error) });
      retryable(`Agent cognition failed for ${input.agentId}`, error);
    }
  }

  async runtimeEvidence(runId: string): Promise<{
    conditionDigest: string;
    staticArtifactDigest: string;
    modelConfiguration: Pick<CodexRuntimeProfile, "model" | "configDigest">;
    turnPrompt: { versionRef: string; artifactDigest: string; variables: FrozenTurnPrompt["variables"] };
    instructionPolicy: {
      version: string;
      baseInstructionsDigest: string;
      environmentContextDigest: string;
      nativeEnvironmentContext: boolean | null;
      hostCurrentDateExposed: boolean | null;
    };
    contextCompaction: {
      policy: {
        mode: "auto" | "model-default";
        tokenLimit: number | null;
        scope: "total" | "body_after_prefix" | null;
        prompt: "codex-default";
      };
      events: readonly {
        runId: string;
        roundId: number;
        agentId: string;
        threadId: string;
        turnId: string;
        itemId: string;
        trigger: "auto";
        completedAt: string;
      }[];
    };
    toolCallBudget?: {
      policy: ToolCallBudget;
      exhaustionEvents: readonly {
        runId: string; roundId: number; agentId: string; threadId: string; turnId: string;
        reason: "tool_repeat_budget_exhausted"; toolName: string; limit: number; attemptedCall: number; toolUseId: string; occurredAt: string;
      }[];
    };
    artifacts: readonly Pick<StaticArtifact, "agentId" | "conditionDigest" | "manifestDigest">[];
    driftEvents: readonly WorkspaceDriftEvent[];
    instructionPolicyMigrations: readonly InstructionPolicyMigration[];
    sandbox: SandboxRuntimeEvidence;
  }> {
    return this.withRunLock(runId, async () => {
      const run = this.run(runId);
      const artifacts = [...run.artifacts.values()].sort((a, b) => a.agentId.localeCompare(b.agentId));
      const firstArtifact = artifacts[0];
      if (!firstArtifact) throw new Error("Agent Execution invariant: runtime evidence requires an artifact");
      const compactionEvents = [...run.executions.values()]
        .sort((left, right) => compareExecutionKey(left.key, right.key))
        .flatMap(({ key, result }) => (result.tokenUsage?.compactions ?? []).map((event) => ({
          runId: key.runId,
          roundId: key.roundId,
          agentId: key.agentId,
          threadId: result.tokenUsage!.threadId,
          turnId: result.tokenUsage!.turnId,
          itemId: event.itemId,
          trigger: "auto" as const,
          completedAt: event.completedAt,
        })));
      const exhaustionEvents = [...run.executions.values()]
        .sort((left, right) => compareExecutionKey(left.key, right.key))
        .flatMap(({ key, result }) => result.tokenUsage?.toolCallBudget?.termination ? [{
          runId: key.runId,
          roundId: key.roundId,
          agentId: key.agentId,
          threadId: result.tokenUsage.threadId,
          turnId: result.tokenUsage.turnId,
          ...clone(result.tokenUsage.toolCallBudget.termination),
        }] : []);
      return {
        conditionDigest: sha256({
          agents: run.agents.map((agent) => ({
            agentId: agent.agentId,
            agentsMdVersionRef: agent.agentsMdVersionRef,
            agentsMdDigest: agent.agentsMdDigest,
            skills: agent.skills.map(({ versionRef, artifactDigest, skillName }) => ({ versionRef, artifactDigest, skillName })),
          })),
          turnPrompt: run.turnPrompt,
          ...(firstArtifact === undefined ? {} : { instructionPolicyDigest: firstArtifact.instructionPolicyDigest }),
        }),
        staticArtifactDigest: staticArtifactDigest(artifacts),
        modelConfiguration: { model: run.profile.model, configDigest: run.profile.configDigest },
        turnPrompt: { versionRef: run.turnPrompt.versionRef, artifactDigest: run.turnPrompt.artifactDigest, variables: clone(run.turnPrompt.variables) },
        instructionPolicy: {
          version: firstArtifact.instructionPolicyVersion,
          baseInstructionsDigest: sha256(firstArtifact.baseInstructions),
          environmentContextDigest: sha256(firstArtifact.developerInstructions),
          nativeEnvironmentContext: false,
          hostCurrentDateExposed: false,
        },
        contextCompaction: firstArtifact?.contextCompactionPolicy ? {
          policy: clone(firstArtifact.contextCompactionPolicy),
          events: compactionEvents,
        } : {
          policy: {
            mode: "model-default",
            tokenLimit: null,
            scope: null,
            prompt: "codex-default",
          },
          events: compactionEvents,
        },
        ...(run.toolCallBudget ? { toolCallBudget: { policy: clone(run.toolCallBudget), exhaustionEvents } } : {}),
        artifacts: artifacts.map(({ agentId, conditionDigest, manifestDigest }) => ({ agentId, conditionDigest, manifestDigest })),
        driftEvents: clone(run.driftEvents),
        instructionPolicyMigrations: clone(run.instructionPolicyMigrations),
        sandbox: sandboxEvidence(run.sandbox),
      };
    });
  }

  async tokenUsage(runId: string): Promise<readonly RunAgentTurnTokenUsage[]> {
    requireIdentifier(runId, "runId");
    return this.withRunLock(runId, async () => [...this.run(runId).executions.values()]
      .filter((execution) => execution.result.tokenUsage !== undefined)
      .sort((left, right) => compareExecutionKey(left.key, right.key))
      .map(({ key, result }) => ({
        runId: key.runId,
        roundId: key.roundId,
        agentId: key.agentId,
        ...clone(result.tokenUsage!),
      })));
  }

  async transcripts(runId: string, input: { cursor?: string; limit: number; agentId?: string; roundId?: number; attemptId?: string; turnId?: string }): Promise<{ availability: "available" | "legacy_unavailable"; items: readonly AgentSessionTranscript[]; nextCursor?: string }> {
    requireIdentifier(runId, "runId");
    const run = this.run(runId);
    const all = this.stateStore.listTranscripts ? await this.stateStore.listTranscripts(runId) : [];
    const filtered = all.filter((item) => (input.agentId === undefined || item.agentId === input.agentId)
      && (input.roundId === undefined || item.roundId === input.roundId)
      && (input.attemptId === undefined || item.attemptId === input.attemptId)
      && (input.turnId === undefined || item.turnId === input.turnId));
    const offset = decodeTranscriptCursor(input.cursor);
    const items = filtered.slice(offset, offset + input.limit).map(clone);
    const nextOffset = offset + items.length;
    return {
      availability: all.length === 0 && run.executions.size > 0 ? "legacy_unavailable" : "available",
      items,
      ...(nextOffset < filtered.length ? { nextCursor: `offset:${nextOffset}` } : {}),
    };
  }

  async getCheckpoint(runId: string, checkpointRef: string): Promise<AgentCheckpoint> {
    requireIdentifier(runId, "runId"); requireIdentifier(checkpointRef, "checkpointRef");
    return this.withRunLock(runId, async () => {
      const found = [...this.run(runId).sealed.values()].find((checkpoint) => checkpoint.ref === checkpointRef);
      if (!found) notFound(`unknown Agent Execution checkpoint: ${checkpointRef}`);
      return clone(found);
    });
  }

  async seal(runId: string, roundId: number, mutationInput: unknown): Promise<MutationOutcome<AgentCheckpoint>> {
    const mutation = parseMutationHeader(mutationInput); requireRound(roundId);
    return this.withRunLock(runId, async () => {
      const run = this.run(runId);
      this.requireCurrentRuntime(run);
      return this.mutate(mutation, async () => {
        this.requireExpectedCheckpoint(run, mutation);
        if ([...run.executions.values()].some(({ key, result }) => key.roundId === roundId && result.transcriptRef === undefined)) {
          preconditionFailed("every Agent execution in this round must have a durable transcript before sealing");
        }
        const checkpoint = this.checkpoint(run, roundId); run.sealed.set(roundId, checkpoint); return checkpoint;
      });
    });
  }

  async publish(runId: string, roundId: number, checkpointRef: string, mutationInput: unknown): Promise<MutationOutcome<null>> {
    const mutation = parseMutationHeader(mutationInput); requireRound(roundId); requireIdentifier(checkpointRef, "checkpointRef");
    return this.withRunLock(runId, async () => {
      const run = this.run(runId);
      this.requireCurrentRuntime(run);
      return this.mutate(mutation, async () => {
        this.requireExpectedCheckpoint(run, mutation);
        const sealed = run.sealed.get(roundId);
        if (!sealed || sealed.ref !== checkpointRef) preconditionFailed("only the sealed checkpoint for this round may be published");
        if (roundId !== run.publishedRound + 1) preconditionFailed("rounds must be published sequentially");
        run.publishedRound = roundId;
        return null;
      });
    });
  }

  async fork(sourceRunId: string, targetRunId: string, sourceCheckpointRef: string, mutationInput: unknown, mcp: readonly ContextMcpConnection[], agentsMdByAgentId: Readonly<Record<string, string>> = {}, turnPromptInput?: unknown, sectionInput?: unknown): Promise<MutationOutcome<AgentCheckpoint>> {
    const targetSection = this.validate(sectionInput ?? {});
    const mutation = parseMutationHeader(mutationInput); requireIdentifier(sourceRunId, "sourceRunId"); requireIdentifier(targetRunId, "targetRunId"); requireIdentifier(sourceCheckpointRef, "sourceCheckpointRef");
    if (sourceRunId === targetRunId) invalidArgument("fork targetRunId must differ from sourceRunId");
    return this.withRunLock(sourceRunId, async () => this.withRunLock(targetRunId, async () => {
      const source = this.run(sourceRunId);
      this.requireCurrentRuntime(source);
      return this.mutate(mutation, async () => {
        const sourceCheckpoint = [...source.sealed.values()].find((item) => item.ref === sourceCheckpointRef);
        if (!sourceCheckpoint || sourceCheckpoint.roundId > source.publishedRound) preconditionFailed("fork source must be a published Agent checkpoint");
        if (mutation.expectedCheckpointRef !== sourceCheckpoint.ref) preconditionFailed("fork mutation must bind the requested source checkpoint");
        const existing = this.runs.get(targetRunId);
        if (existing) {
          if (existing.lineageParentCheckpointRef !== sourceCheckpoint.ref) preconditionFailed("fork target already belongs to a different source checkpoint");
          return this.checkpoint(existing, sourceCheckpoint.roundId, existing.lineageParentCheckpointRef);
        }
        const agents = source.agents.map((agent) => this.identityFromPublishedAgentsMd({
          agentId: agent.agentId,
          agentsMdVersionRef: agentsMdByAgentId[agent.agentId] ?? agent.agentsMdVersionRef,
          mcpContexts: agent.mcpContexts,
        }));
        uniqueAgentBindings(agents);
        const connections = mcpConnections(agents, mcp);
        await this.artifacts.restoreProfile(targetRunId, source.profile, OPENLEEK_CONTEXT_COMPACTION_POLICY);
        const artifacts = new Map<string, StaticArtifact>();
        for (const agent of agents) {
          const connection = connections.get(agent.agentId);
          if (!connection) throw new Error("Agent Execution invariant: Context MCP connections are missing");
          artifacts.set(agent.agentId, await this.artifacts.create({ runId: targetRunId, agent, agentsMd: this.requireAgentsMdVersion(agent.agentsMdVersionRef, true).source, profile: source.profile, mcpConnections: connection, toolCallBudget: targetSection.toolCallBudget }));
        }
        const sandbox = await this.sandboxManager.ensure({
          runId: targetRunId,
          hostRunRoot: this.artifacts.sandboxHostRunRoot(targetRunId),
          remoteRunRoot: this.artifacts.sandboxRunRoot(targetRunId),
          contexts: [...new Set(mcp.map((connection) => connection.context))].sort(),
          provider: source.profile.provider === "openai" ? "openai" : "deepseek",
        });
        const target: AgentRun = {
          runId: targetRunId, model: source.model, profile: clone(source.profile),
          ...(source.memoryProfile ? { memoryProfile: clone(source.memoryProfile) } : {}),
          toolCallBudget: clone(targetSection.toolCallBudget),
          continuityRuntimeProfile: "hook-v1",
          hookPolicy: {
            strategyInjectionEnabled: source.hookPolicy.strategyInjectionEnabled,
            revision: 1,
            updatedAt: new Date().toISOString(),
          },
          agents: clone(agents),
          sessions: Object.fromEntries(agents.map((agent) => [agent.agentId, null])), sandbox, artifacts,
          executions: new Map([...source.executions.values()].filter(({ key }) => key.roundId <= sourceCheckpoint.roundId).map(({ key, result }) => {
            const targetKey = { ...key, runId: targetRunId }; return [executionKey(targetKey), { key: targetKey, result: clone(result) }];
          })),
          driftEvents: [], instructionPolicyMigrations: [], sealed: new Map(), lineageParentCheckpointRef: sourceCheckpoint.ref, publishedRound: sourceCheckpoint.roundId,
          turnPrompt: turnPromptInput === undefined ? clone(source.turnPrompt) : frozenTurnPromptSchema.parse(turnPromptInput),
        };
        if (source.memoryProfile && target.memoryProfile && this.options.memoryPort?.fork) {
          for (const agent of agents) {
            await this.options.memoryPort.fork(
              memoryBinding(source.runId, agent.agentId, source.memoryProfile, sourceCheckpoint.roundId, agent.skills, source.continuityRuntimeProfile),
              memoryBinding(target.runId, agent.agentId, target.memoryProfile, sourceCheckpoint.roundId, agent.skills, target.continuityRuntimeProfile),
              sourceCheckpoint.roundId,
            );
          }
        }
        this.runs.set(targetRunId, target);
        const checkpoint = this.checkpoint(target, sourceCheckpoint.roundId, sourceCheckpoint.ref);
        target.sealed.set(checkpoint.roundId, checkpoint);
        return checkpoint;
      });
    }));
  }

  async listCommittedFacts(runId: string): Promise<readonly CommittedExecution[]> {
    return this.withRunLock(runId, async () => [...this.run(runId).executions.values()]
      .filter(({ key }) => key.roundId <= this.run(runId).publishedRound)
      .sort((left, right) => compareExecutionKey(left.key, right.key))
      .map(({ key, result }) => ({ key: clone(key), result: clone(result) })));
  }

  getHookPolicy(runId: string): CodexHookPolicy {
    return clone(this.run(runId).hookPolicy);
  }

  async updateHookPolicy(input: {
    runId: string;
    strategyInjectionEnabled: boolean;
    expectedRevision: number;
    idempotencyKey: string;
  }): Promise<{ policy: CodexHookPolicy; replayed: boolean }> {
    requireIdentifier(input.runId, "runId");
    requireIdentifier(input.idempotencyKey, "idempotencyKey");
    return this.withRunLock(input.runId, async () => {
      const run = this.run(input.runId);
      const key = `codex-hook-policy:${input.runId}:${input.idempotencyKey}`;
      const digest = sha256({
        runId: input.runId,
        strategyInjectionEnabled: input.strategyInjectionEnabled,
        expectedRevision: input.expectedRevision,
      });
      const existing = this.idempotency.get(key);
      if (existing && existing.digest !== digest) idempotencyConflict("idempotencyKey already exists with a different Codex Hook policy update");
      if (existing?.state === "completed") {
        const response = clone(existing.response) as { policy: CodexHookPolicy };
        return { policy: response.policy, replayed: true };
      }
      if (run.sandbox.lifecycle === "released") preconditionFailed("Codex Hook policy cannot change after the Run sandbox is released");
      if (run.hookPolicy.revision !== input.expectedRevision) preconditionFailed("Codex Hook policy has changed; reload before saving");
      this.idempotency.set(key, { digest, state: "started" });
      run.hookPolicy = {
        strategyInjectionEnabled: input.strategyInjectionEnabled,
        revision: run.hookPolicy.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      const response = { policy: clone(run.hookPolicy) };
      this.idempotency.set(key, { digest, state: "completed", response });
      await this.persist();
      return { ...response, replayed: false };
    });
  }

  async committedCheckpoint(runId: string): Promise<AgentCheckpoint> {
    return this.withRunLock(runId, async () => {
      const run = this.run(runId); const checkpoint = run.sealed.get(run.publishedRound);
      if (!checkpoint) throw new Error("Agent Execution invariant: missing published checkpoint");
      return clone(checkpoint);
    });
  }
  /** Readiness validates local configuration/state only; it never needs a run sandbox. */
  async health(): Promise<void> {}

  async release(runId: string): Promise<SandboxRuntimeEvidence> {
    requireIdentifier(runId, "runId");
    return this.withRunLock(runId, async () => {
      const run = this.run(runId);
      this.requireCurrentRuntime(run);
      run.sandbox = await this.sandboxManager.release(run.sandbox);
      await this.persist();
      return sandboxEvidence(run.sandbox);
    });
  }

  private async detectAndRestoreDrift(run: AgentRun, artifact: StaticArtifact, roundId: number, phase: WorkspaceDriftEvent["phase"]): Promise<void> {
    const observed = await this.artifacts.inspect(artifact);
    if (observed === undefined || observed === artifact.manifestDigest) return;
    await this.artifacts.restore(artifact);
    run.driftEvents.push({ runId: run.runId, agentId: artifact.agentId, roundId, phase, detectedAt: new Date().toISOString(), expectedDigest: artifact.manifestDigest, observedDigest: observed, restored: true });
  }

  private requireAgentsMdVersion(versionRef: string, includeDeleted = false): AgentsMdVersion {
    const version = this.agentsMdVersions.get(versionRef);
    if (!version || (!includeDeleted && this.deleted("agents-md", "version", versionRef))) preconditionFailed(`AGENTS.md version '${versionRef}' is not published`);
    return version;
  }

  private requireMcpPolicyVersion(versionRef: string, includeDeleted = false): McpPolicyVersion {
    const version = this.mcpPolicyVersions.get(versionRef);
    if (!version || (!includeDeleted && this.deleted("mcp-policy", "version", versionRef))) preconditionFailed(`MCP Policy version '${versionRef}' is not published`);
    return version;
  }

  private requireSkillVersion(versionRef: string, includeDeleted = false): SkillVersion {
    const version = this.skillVersions.get(versionRef);
    if (!version || (!includeDeleted && this.deleted("skill", "version", versionRef))) preconditionFailed(`Skill version '${versionRef}' is not published`);
    return version;
  }

  private resolveSkillVersions(versionRefs: readonly string[], includeDeleted = false): SkillVersion[] {
    const uniqueRefs = [...new Set(versionRefs)].sort();
    if (uniqueRefs.length !== versionRefs.length) invalidArgument("Agent Blueprint Skill versions must be unique");
    const versions = uniqueRefs.map((versionRef) => this.requireSkillVersion(versionRef, includeDeleted));
    const names = new Set<string>();
    for (const version of versions) {
      if (names.has(version.skillName)) invalidArgument(`Agent Blueprint selects multiple Skill versions named '${version.skillName}'`);
      names.add(version.skillName);
    }
    return versions;
  }

  private requireSkillPolicyCompatibility(skills: readonly SkillVersion[], policy: McpPolicyVersion): void {
    const tools = new Set(policy.tools);
    const resources = new Set(policy.resources);
    for (const skill of skills) {
      const missingTools = skill.requirements.tools.filter((tool) => !tools.has(tool));
      const missingResources = skill.requirements.resources.filter((resource) => !resources.has(resource));
      if (missingTools.length || missingResources.length) {
        preconditionFailed(`Skill '${skill.skillName}' requires MCP capabilities not granted by the selected MCP Policy: ${[...missingTools, ...missingResources].join(", ")}`);
      }
    }
  }

  private identityFromPublishedAgentsMd(input: { agentId: string; agentsMdVersionRef: string; skillVersionRefs?: readonly string[]; mcpContexts: readonly string[] }): AgentIdentity {
    const version = this.requireAgentsMdVersion(input.agentsMdVersionRef, true);
    const skills = this.resolveSkillVersions(input.skillVersionRefs ?? [], true);
    return {
      agentId: input.agentId,
      agentsMdVersionRef: version.versionRef,
      agentsMdDigest: version.artifactDigest,
      skills: skills.map((skill) => ({
        versionRef: skill.versionRef,
        artifactDigest: skill.artifactDigest,
        skillName: skill.skillName,
        files: clone(skill.files),
      })),
      mcpContexts: [...new Set(input.mcpContexts)].sort(),
    };
  }

  private run(runId: string): AgentRun { const run = this.runs.get(runId); if (!run) notFound(`unknown Agent Execution run: ${runId}`); return run; }
  private requireCurrentRuntime(_run: AgentRun): void {}
  private requireExpectedCheckpoint(run: AgentRun, mutation: Mutation): void { const committed = run.sealed.get(run.publishedRound); if (!committed || mutation.expectedCheckpointRef !== committed.ref) preconditionFailed("expectedCheckpointRef is not this run's committed checkpoint"); }
  private checkpoint(run: AgentRun, roundId: number, parentRef?: string): AgentCheckpoint {
    const artifacts = [...run.artifacts.values()].sort((a, b) => a.agentId.localeCompare(b.agentId));
    const staticDigest = staticArtifactDigest(artifacts);
    const records = [...run.executions.values()].filter(({ key }) => key.roundId <= roundId).sort((a, b) => compareExecutionKey(a.key, b.key)).map(({ key, result }) => ({ roundId: key.roundId, agentId: key.agentId, candidates: result.candidates.map((candidate) => ({ actionId: candidate.actionId, digest: sha256(candidate) })), evidenceRef: result.evidenceRef, ...(result.transcriptRef ? { transcriptRef: result.transcriptRef } : {}) }));
    const digestInput = { runId: run.runId, model: run.model, codexConfigDigest: run.profile.configDigest, turnPrompt: run.turnPrompt, roundId, staticArtifactDigest: staticDigest, records, ...(run.toolCallBudget ? { toolCallBudget: run.toolCallBudget } : {}), ...(parentRef === undefined ? {} : { parentRef }) };
    return checkpointSchema.parse({ ref: `checkpoint:agent-execution:${run.runId}:round:${roundId}`, runId: run.runId, roundId, staticArtifactDigest: staticDigest, model: run.model, codexConfigDigest: run.profile.configDigest, ...(run.toolCallBudget ? { toolCallBudget: run.toolCallBudget } : {}), digest: sha256(digestInput), ...(parentRef === undefined ? {} : { parentRef }) });
  }
  private async mutate<T>(mutation: Mutation, operation: () => Promise<T>): Promise<MutationOutcome<T>> {
    const key = mutationKey(mutation); const existing = this.idempotency.get(key);
    if (existing) {
      if (existing.digest !== mutation.payloadDigest) idempotencyConflict("transitionId and stepId already exist with a different payload digest");
      if (existing.state === "completed") return { value: clone(existing.response) as T, replayed: true };
      const value = await operation(); existing.state = "completed"; existing.response = clone(value); await this.persist(); return { value: clone(value), replayed: true };
    }
    this.idempotency.set(key, { digest: mutation.payloadDigest, state: "started" }); await this.persist();
    try { const value = await operation(); const record = this.idempotency.get(key); if (!record) throw new Error("Agent Execution invariant: mutation record disappeared"); record.state = "completed"; record.response = clone(value); await this.persist(); return { value: clone(value), replayed: false }; }
    catch (error) { await this.persist(); throw error; }
  }
  private async withRunLock<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.runLocks.get(runId) ?? Promise.resolve(); let release!: () => void; const current = new Promise<void>((resolve) => { release = resolve; }); const queued = previous.then(() => current); this.runLocks.set(runId, queued); await previous;
    try { return await operation(); } finally { release(); if (this.runLocks.get(runId) === queued) this.runLocks.delete(runId); }
  }
  private deleted(assetKind: string, target: AssetDeleteTarget, assetId: string) { return this.assetTombstones.has(assetTombstoneKey(assetKind, target, assetId)); }
  private tombstones(assetKind: string) { return [...this.assetTombstones.values()].filter((item) => item.assetKind === assetKind).map(clone); }
  private async deleteDraft<T extends { revision: number }>(
    assetKind: string,
    assetId: string,
    expectedRevision: number,
    idempotencyKey: string,
    records: ReadonlyMap<string, T>,
  ): Promise<AssetDeletionResult> {
    const key = assetTombstoneKey(assetKind, "draft", assetId);
    const existing = this.assetTombstones.get(key);
    if (existing) return { status: "already-deleted", replayed: existing.idempotencyKey === idempotencyKey, tombstone: clone(existing) };
    const record = records.get(assetId);
    if (!record) notFound(`${assetKind} draft does not exist`);
    if (record.revision !== expectedRevision) preconditionFailed(`${assetKind} draft has changed; reload before deleting`);
    const tombstone: AssetTombstone = { assetKind, assetId, target: "draft", deletedAt: new Date().toISOString(), idempotencyKey, expectedRevision };
    this.assetTombstones.set(key, tombstone);
    await this.persist();
    return { status: "deleted", replayed: false, tombstone: clone(tombstone) };
  }
  private async deleteVersion<T>(
    assetKind: string,
    versionRef: string,
    idempotencyKey: string,
    records: ReadonlyMap<string, T>,
  ): Promise<AssetDeletionResult> {
    const key = assetTombstoneKey(assetKind, "version", versionRef);
    const existing = this.assetTombstones.get(key);
    if (existing) return { status: "already-deleted", replayed: existing.idempotencyKey === idempotencyKey, tombstone: clone(existing) };
    if (!records.has(versionRef)) notFound(`${assetKind} version does not exist`);
    const tombstone: AssetTombstone = { assetKind, assetId: versionRef, target: "version", deletedAt: new Date().toISOString(), idempotencyKey };
    this.assetTombstones.set(key, tombstone);
    await this.persist();
    return { status: "deleted", replayed: false, tombstone: clone(tombstone) };
  }
  private async persist(): Promise<void> { await this.stateStore.save(this.snapshot()); }
  private snapshot(): AgentExecutionSnapshot {
    return {
      version: 16,
      runs: [...this.runs.values()].sort((a, b) => a.runId.localeCompare(b.runId)).map((run): PersistedAgentRun => ({
        runId: run.runId, model: run.model, profile: clone(run.profile),
        ...(run.memoryProfile ? { memoryProfile: clone(run.memoryProfile) } : {}),
        ...(run.toolCallBudget ? { toolCallBudget: clone(run.toolCallBudget) } : {}),
        continuityRuntimeProfile: run.continuityRuntimeProfile,
        hookPolicy: clone(run.hookPolicy),
        agents: clone(run.agents), sessions: clone(run.sessions), sandbox: clone(run.sandbox), artifacts: [...run.artifacts.values()].map(clone),
        executions: [...run.executions.values()].map(({ key, result }) => ({ roundId: key.roundId, agentId: key.agentId, result: clone(result) })),
        driftEvents: [...clone(run.driftEvents)], instructionPolicyMigrations: [...clone(run.instructionPolicyMigrations)], sealed: [...run.sealed.values()].map((checkpoint) => ({ ref: checkpoint.ref, runId: checkpoint.runId, roundId: checkpoint.roundId, digest: checkpoint.digest, ...(checkpoint.parentRef === undefined ? {} : { parentRef: checkpoint.parentRef }), ...(checkpoint.staticArtifactDigest === undefined ? {} : { staticArtifactDigest: checkpoint.staticArtifactDigest }), ...(checkpoint.model === undefined ? {} : { model: checkpoint.model }), ...(checkpoint.codexConfigDigest === undefined ? {} : { codexConfigDigest: checkpoint.codexConfigDigest }), ...(checkpoint.toolCallBudget === undefined ? {} : { toolCallBudget: clone(checkpoint.toolCallBudget) }) })), publishedRound: run.publishedRound, turnPrompt: clone(run.turnPrompt), ...(run.lineageParentCheckpointRef ? { lineageParentCheckpointRef: run.lineageParentCheckpointRef } : {}),
      })),
      idempotency: [...this.idempotency.entries()].map(([key, value]): PersistedIdempotencyRecord => ({ key, digest: value.digest, state: value.state, ...(value.response === undefined ? {} : { response: clone(value.response) as import("./types").JsonValue }) })),
      agentsMdDrafts: [...this.agentsMdDrafts.values()].map(clone),
      agentsMdVersions: [...this.agentsMdVersions.values()].map(clone),
      mcpPolicyDrafts: [...this.mcpPolicyDrafts.values()].map(clone),
      mcpPolicyVersions: [...this.mcpPolicyVersions.values()].map(clone),
      skillDrafts: [...this.skillDrafts.values()].map(clone),
      skillVersions: [...this.skillVersions.values()].map(clone),
      assetTombstones: [...this.assetTombstones.values()].map(clone),
      legacyTurnPromptAssets: clone(this.legacyTurnPromptAssets),
    };
  }
  private restore(snapshot: unknown): void {
    if (snapshot === null || typeof snapshot !== "object") {
      throw new Error("Agent Execution snapshot predates native DeepSeek configuration and is not executable");
    }
    const version = (snapshot as { version?: unknown }).version;
    if (version === 14) {
      // Native DeepSeek deliberately does not restore legacy provider-backed Runs. Keep the
      // independently managed asset library, then persist a clean v15 snapshot.
      this.restoreAssets(snapshot as Partial<AgentExecutionSnapshot>);
      return;
    }
    if (version !== 15 && version !== 16) throw new Error("Agent Execution snapshot predates native DeepSeek configuration and is not executable");
    const current = snapshot as AgentExecutionSnapshot;
    for (const persisted of current.runs) {
      if (persisted.profile.provider !== "deepseek" && persisted.profile.provider !== "openai") throw new Error("Agent Execution snapshot contains an unsupported provider");
      const profile = { ...clone(persisted.profile), reasoningEffort: persisted.profile.reasoningEffort ?? "high" };
      const run: AgentRun = { runId: persisted.runId, model: persisted.model, profile, ...(persisted.memoryProfile ? { memoryProfile: clone(persisted.memoryProfile) } : {}), ...(persisted.toolCallBudget ? { toolCallBudget: clone(persisted.toolCallBudget) } : {}), continuityRuntimeProfile: persisted.continuityRuntimeProfile, hookPolicy: clone(persisted.hookPolicy), agents: clone(persisted.agents), sessions: clone(persisted.sessions), sandbox: clone(persisted.sandbox), artifacts: new Map(persisted.artifacts.map((artifact) => [artifact.agentId, clone(artifact)])), executions: new Map(), driftEvents: [...clone(persisted.driftEvents)], instructionPolicyMigrations: [...clone(persisted.instructionPolicyMigrations)], sealed: new Map(persisted.sealed.map((checkpoint) => [checkpoint.roundId, clone(checkpoint)])), publishedRound: persisted.publishedRound, turnPrompt: clone(persisted.turnPrompt), ...(persisted.lineageParentCheckpointRef ? { lineageParentCheckpointRef: persisted.lineageParentCheckpointRef } : {}) };
      for (const execution of persisted.executions) { const key = { runId: run.runId, roundId: execution.roundId, agentId: execution.agentId }; run.executions.set(executionKey(key), { key, result: clone(execution.result) }); }
      this.runs.set(run.runId, run);
    }
    for (const record of current.idempotency) this.idempotency.set(record.key, { digest: record.digest, state: record.state, ...(record.response === undefined ? {} : { response: clone(record.response) }) });
    this.restoreAssets(current);
  }
  private restoreAssets(current: Partial<AgentExecutionSnapshot>): void {
    for (const draft of current.agentsMdDrafts ?? []) this.agentsMdDrafts.set(draft.templateId, clone(draft));
    for (const version of current.agentsMdVersions ?? []) this.agentsMdVersions.set(version.versionRef, clone(version));
    for (const draft of current.mcpPolicyDrafts ?? []) this.mcpPolicyDrafts.set(draft.policyId, clone(draft));
    for (const version of current.mcpPolicyVersions ?? []) this.mcpPolicyVersions.set(version.versionRef, clone(version));
    for (const draft of current.skillDrafts ?? []) this.skillDrafts.set(draft.skillId, clone(draft));
    for (const version of current.skillVersions ?? []) this.skillVersions.set(version.versionRef, clone(version));
    for (const tombstone of current.assetTombstones ?? []) this.assetTombstones.set(assetTombstoneKey(tombstone.assetKind, tombstone.target, tombstone.assetId), clone(tombstone));
    this.legacyTurnPromptAssets = current.legacyTurnPromptAssets === undefined
      ? { drafts: [], versions: [] }
      : clone(current.legacyTurnPromptAssets) as { drafts: unknown[]; versions: unknown[] };
  }
}

function decodeTranscriptCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const match = /^offset:(\d+)$/.exec(cursor);
  if (!match) invalidArgument("transcript cursor is invalid");
  return Number(match[1]);
}


function uniqueAgentBindings(agents: readonly AgentIdentity[]): void {
  const values = agents.map((agent) => agent.agentId);
  if (new Set(values).size !== values.length) invalidArgument("run agents must have unique agentId values", { agentId: "contains duplicate values" });
}
function memoryBinding(
  runId: string,
  agentId: string,
  profile: { readonly routeId: string; readonly llmConfigRevision: string },
  roundId: number,
  skills: readonly FrozenSkill[],
  continuityRuntimeProfile: ContinuityRuntimeProfile,
) {
  return {
    bankId: `agent-${sha256({ runId, agentId })}`,
    routeId: profile.routeId,
    llmConfigRevision: profile.llmConfigRevision,
    roundId,
    toolProfile: memoryToolProfile(skills, continuityRuntimeProfile),
  };
}
function memoryToolProfile(skills: readonly FrozenSkill[], continuityRuntimeProfile: ContinuityRuntimeProfile): "combined-v1" | "split-v2" | "hook-v1" {
  if (continuityRuntimeProfile === "hook-v1") return "hook-v1";
  return skills.some((skill) => skill.skillName === "long-term-strategy") ? "split-v2" : "combined-v1";
}
function mcpConnections(agents: readonly AgentIdentity[], connections: readonly ContextMcpConnection[]): ReadonlyMap<string, readonly ContextMcpConnection[]> {
  const byAgent = new Map<string, ContextMcpConnection[]>(agents.map((agent) => [agent.agentId, []]));
  for (const connection of connections) {
    if (!connection.principalId) invalidArgument("Context MCP principal is invalid");
    if (!connection.credential || connection.credential.length < 32) invalidArgument("Experiment MCP credential is invalid");
    try { new URL(connection.endpoint); } catch { invalidArgument("Context MCP endpoint is invalid"); }
    const current = byAgent.get(connection.agentId);
    if (!current) invalidArgument(`Context MCP connection references unknown agent '${connection.agentId}'`);
    if (current.some((item) => item.context === connection.context)) invalidArgument("Context MCP connections must be unique by agent and context");
    current.push(connection);
    byAgent.set(connection.agentId, current);
  }
  if (byAgent.size !== agents.length || agents.some((agent) => {
    const bindings = byAgent.get(agent.agentId);
    return bindings === undefined
      || new Set(bindings.map((binding) => binding.principalId)).size !== 1
      || !agent.mcpContexts.every((context) => bindings.some((binding) => binding.context === context))
      || bindings.some((binding) => !agent.mcpContexts.includes(binding.context));
  })) invalidArgument("Context MCP connections must exactly cover each agent's Experiment-derived authority policy");
  return byAgent;
}
function staticArtifactDigest(artifacts: readonly StaticArtifact[]): string { return sha256(artifacts.map(({ agentId, conditionDigest, manifestDigest }) => ({ agentId, conditionDigest, manifestDigest }))); }
function executionKey(key: ExecutionKey): string { return encode([key.runId, String(key.roundId), key.agentId]); }
function mutationKey(mutation: Mutation): string { return encode([mutation.transitionId, mutation.stepId]); }
function encode(parts: readonly string[]): string { return parts.map((part) => `${part.length}:${part}`).join("|"); }
function compareExecutionKey(left: ExecutionKey, right: ExecutionKey): number { return left.roundId - right.roundId || left.agentId.localeCompare(right.agentId); }
function requireIdentifier(value: string, field: string): void { if (!value.trim()) invalidArgument(`${field} must not be empty`, { [field]: "must not be empty" }); }
function requireRound(roundId: number): void { if (!Number.isInteger(roundId) || roundId < 0) invalidArgument("roundId must be a non-negative integer", { roundId: "must be non-negative" }); }
function clone<T>(value: T): T { return structuredClone(value); }

function normalizeMcpPolicy(input: McpPolicyDefinition): McpPolicyDefinition {
  const parsed = mcpPolicyDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    invalidArgument("MCP Policy definition is invalid", Object.fromEntries(parsed.error.issues.map((issue) => [issue.path.join(".") || "definition", issue.message])));
  }
  return {
    tools: [...new Set(parsed.data.tools)].sort(),
    resources: [...new Set(parsed.data.resources)].sort(),
    contexts: Object.fromEntries(Object.entries(parsed.data.contexts ?? {}).sort(([left], [right]) => left.localeCompare(right))),
  };
}

function sandboxEvidence(sandbox: SandboxDescriptor): SandboxRuntimeEvidence {
  const state = sandbox.lifecycle === "running"
    ? "active"
    : sandbox.lifecycle === "released"
      ? "released"
      : "unavailable";
  return {
    state,
    restartCount: sandbox.restartCount,
    ...(state === "unavailable" ? {} : { createdAt: sandbox.createdAt }),
    ...(sandbox.releasedAt === undefined ? {} : { releasedAt: sandbox.releasedAt }),
  };
}

function assetTombstoneKey(assetKind: string, target: AssetDeleteTarget, assetId: string) {
  return `${assetKind}\u0000${target}\u0000${assetId}`;
}

function normalizeCodexModels(value: unknown): { id: string; displayName: string; defaultReasoningEffort: string; supportedReasoningEfforts: string[] }[] {
  const record = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
  const items = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : [];
  return items.flatMap((raw) => {
    if (raw === null || typeof raw !== "object") return [];
    const model = raw as Record<string, unknown>;
    const id = [model.id, model.model, model.slug].find((item) => typeof item === "string" && item.length) as string | undefined;
    if (!id) return [];
    const levels = [model.supportedReasoningEfforts, model.supportedReasoningLevels, model.supported_reasoning_levels].find(Array.isArray) as unknown[] | undefined;
    const supportedReasoningEfforts = (levels ?? []).flatMap((level) => {
      if (typeof level === "string") return [level];
      if (!level || typeof level !== "object") return [];
      const option = level as Record<string, unknown>;
      const effort = typeof option.reasoningEffort === "string" ? option.reasoningEffort : typeof option.effort === "string" ? option.effort : undefined;
      return effort ? [effort] : [];
    });
    const fallback = [model.defaultReasoningEffort, model.defaultReasoningLevel, model.default_reasoning_level].find((item) => typeof item === "string") as string | undefined;
    const efforts: string[] = [...new Set(supportedReasoningEfforts.length ? supportedReasoningEfforts : fallback ? [fallback] : ["medium"])].filter((effort): effort is string => typeof effort === "string");
    return [{ id, displayName: typeof model.displayName === "string" ? model.displayName : typeof model.display_name === "string" ? model.display_name : id, defaultReasoningEffort: fallback ?? efforts[0]!, supportedReasoningEfforts: efforts }];
  });
}
