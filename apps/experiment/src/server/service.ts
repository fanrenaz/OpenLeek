import { agentBlueprintDefinitionSchema, mcpPolicyDefinitionSchema, type AgentBlueprintDefinition } from "@openleek/contracts/agent";
import type { AssetDeletionResult, AssetDeleteTarget, AssetTombstone } from "@openleek/contracts/assets";
import { type Checkpoint, type ContextParticipant, type DynamicContextRevision } from "@openleek/contracts/context";
import { type MutationHeader } from "@openleek/contracts/core";
import { pluginSpecificationSchema, type PluginManifest, type PluginSpecification, type RoundProgress, type RunStatus } from "@openleek/contracts/experiment";
import { type TurnPromptSelection, type TurnPromptVariableDefinition } from "@openleek/contracts/turn-prompt";
import { populationDefinitionSchema, type PopulationEntry, type NameTheme } from "@openleek/contracts/world";
import { sha256Digest } from "@openleek/contracts/canonical";
import { randomUUID } from "node:crypto";
import type { ExperimentCredentialSigner } from "@openleek/experiment-credentials";
import { observeWorkerOperation } from "@openleek/observability";
import { OpenLeekDomainError } from "@openleek/trpc";
import {
  type AgentJob,
  type ClaimedJob,
  type CommitWork,
  type ContextMutation,
  type ContextMcpConnection,
  type ContextMcpScopeLease,
  type ContextPorts,
  type FaultBoundaryMoment,
  FaultInjectedError,
  type ExperimentRepository,
  type JobFailure,
  type Ledger,
  type LedgerStep,
  type RoundAttempt,
  type RoundSnapshot,
  type RunAgentRegistration,
  type RunRecord,
  type ResolvedWorldRecord,
  type WorldGeneratorDraft,
  type WorldGeneratorKind,
  type WorldGeneratorLimits,
  type WorldGeneratorVersion,
  type PopulationDraft,
  type PopulationVersion,
  type AgentBlueprintDraft,
  type AgentBlueprintVersion,
  type TurnPromptDraft,
  type TurnPromptVersion,
} from "./model";
import { renderTurnPrompt, resolveTurnPrompt, validateTurnPromptDefinition } from "./turn-prompt";

function startLeaseHeartbeat(callback: () => Promise<unknown>, intervalMs: number): () => Promise<void> {
  let inFlight: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = callback()
      .then(() => undefined)
      // A later heartbeat retries transient failures. Keep the rejection
      // handled here so shutdown can drain the callback before closing the
      // repository without producing an unhandled rejection.
      .catch(() => undefined)
      .finally(() => { inFlight = undefined; });
  }, intervalMs);
  return async () => {
    clearInterval(timer);
    await inFlight;
  };
}

const NAME_THEME_VALUES: Record<NameTheme, readonly string[]> = {
  "research-codes-v1": ["AXIOM", "BAYES", "CURIE", "DARWIN", "EULER", "FARADAY", "GAUSS", "HOPPER", "IVANOV", "JOULE", "KEPLER", "LOVELACE"],
  "three-kingdoms-v1": ["刘备", "关羽", "张飞", "诸葛亮", "赵云", "曹操", "孙权", "周瑜", "吕布", "司马懿", "黄忠", "马超"],
  "journey-to-the-west-v1": ["孙悟空", "唐三藏", "猪八戒", "沙悟净", "白龙马", "观音", "哪吒", "二郎神", "太白金星", "牛魔王", "铁扇公主", "红孩儿"],
  "wandering-swords-v1": ["沈青崖", "谢孤鸿", "楚听雪", "顾长风", "叶照川", "陆归舟", "温辞镜", "苏问岚", "裴夜雨", "江停云", "林逐月", "萧无尘"],
  "wizard-academy-v1": ["Aster Vale", "Mira Wren", "Orin Blackwood", "Lyra Ash", "Felix Thorn", "Iris Moon", "Rowan Voss", "Elio Frost", "Nova Reed", "Cassian Pike", "Thea Bloom", "Silas Crow"],
  "deep-space-crew-v1": ["Commander Vega", "Pilot Rook", "Doctor Sol", "Engineer Quill", "Navigator Io", "Analyst Nyx", "Specialist Mars", "Officer Luna", "Scout Kepler", "Tech Atlas", "Medic Ceres", "Operator Vela"],
  "mythic-creatures-v1": ["Phoenix", "Qilin", "Griffin", "Leviathan", "Sphinx", "Basilisk", "Kitsune", "Garuda", "Selkie", "Chimera", "Pegasus", "Naga"],
  "cyber-city-v1": ["Neon", "Cipher", "Vector", "Glitch", "Proxy", "Kernel", "Chrome", "Pulse", "Relay", "Pixel", "Flux", "Circuit"],
};

function resolvedDisplayName(theme: NameTheme, seed: number, slotIndex: number): string {
  const names = NAME_THEME_VALUES[theme];
  const offset = Number.parseInt(sha256Digest({ seed, theme }).slice(0, 8), 16) % names.length;
  const base = names[(offset + slotIndex) % names.length]!;
  const cycle = Math.floor(slotIndex / names.length);
  return cycle === 0 ? base : `${base} ${cycle + 1}`;
}

export interface ExperimentOptions {
  /** Test-only hooks for every durable commit ledger boundary. */
  faultAfterStep?: LedgerStep;
  faultBoundary?: { step: LedgerStep; moment: FaultBoundaryMoment };
  /** The Experiment-only Ed25519 issuer for run-local MCP credentials. */
  credentialSigner?: ExperimentCredentialSigner;
  /** Owner-drain barrier tuning; production defaults to a two-minute bound. */
  settlementTimeoutMs?: number;
  settlementInitialBackoffMs?: number;
  settlementMaxBackoffMs?: number;
}

/** HTTP/control-plane application service. It never executes a model call. */
export class ExperimentService {
  constructor(
    private readonly repository: ExperimentRepository,
    private readonly ports: ContextPorts,
    private readonly options: ExperimentOptions = {},
  ) {}

  listResearchTemplates() { return { versions: [triContextResearchTemplate()] }; }
  researchTemplateVersion(versionRef: string) { const value = triContextResearchTemplate(); if (value.versionRef !== versionRef) throw this.notFound("Research Template version"); return value; }

  async listPopulations(includeDeleted = false) { return this.filterDeletedLibrary("population", await this.repository.listPopulations(), includeDeleted); }
  async getPopulationDraft(populationId: string, includeDeleted = false): Promise<PopulationDraft> { const value = await this.repository.findPopulationDraft(populationId); if (!value || (!includeDeleted && await this.deleted("population", "draft", populationId))) throw this.notFound("Population draft"); return value; }
  async getPopulationVersion(versionRef: string, includeDeleted = false): Promise<PopulationVersion> { const value = await this.repository.findPopulationVersion(versionRef); if (!value || (!includeDeleted && await this.deleted("population", "version", versionRef))) throw this.notFound("Population version"); return value; }
  async savePopulationDraft(input: { populationId?: string; expectedRevision?: number; name: string; entries: PopulationEntry[] }): Promise<PopulationDraft> { if (!input.name.trim()) throw this.invalid("name", "must not be empty"); const definition = populationDefinitionSchema.parse({ entries: input.entries }); await this.rejectDeletedBlueprintReferences(definition.entries); const populationId = input.populationId ?? `population:${randomUUID()}`; if (await this.deleted("population", "draft", populationId)) throw this.precondition("deleted Population draft IDs cannot be reused"); const existing = await this.repository.findPopulationDraft(populationId); if (existing && existing.revision !== input.expectedRevision) throw this.precondition("Population draft has changed; reload before saving"); if (!existing && input.expectedRevision !== undefined) throw this.notFound("Population draft"); const draft: PopulationDraft = { populationId, name: input.name.trim(), entries: structuredClone(definition.entries), revision: (existing?.revision ?? 0) + 1, updatedAt: new Date().toISOString() }; await this.repository.savePopulationDraft(draft); return draft; }
  async publishPopulation(input: { populationId: string; expectedRevision: number }): Promise<PopulationVersion> { const draft = await this.getPopulationDraft(input.populationId); if (draft.revision !== input.expectedRevision) throw this.precondition("Population draft has changed; reload before publishing"); populationDefinitionSchema.parse({ entries: draft.entries }); await this.rejectDeletedBlueprintReferences(draft.entries); const artifactDigest = sha256Digest({ entries: draft.entries }); const existing = (await this.repository.listPopulations()).versions.find((item) => item.artifactDigest === artifactDigest); if (existing) { if (await this.deleted("population", "version", existing.versionRef)) throw this.precondition("identical content belongs to a deleted Population version"); return existing; } const version: PopulationVersion = { populationId: draft.populationId, name: draft.name, entries: structuredClone(draft.entries), versionRef: `population:${draft.populationId}:${artifactDigest.slice(0, 16)}`, artifactDigest, publishedAt: new Date().toISOString(), draftRevision: draft.revision }; await this.repository.savePopulationVersion(version); return version; }

  async listAgentBlueprints(includeDeleted = false) { return this.filterDeletedLibrary("agent-blueprint", await this.repository.listAgentBlueprints(), includeDeleted); }
  async getAgentBlueprintDraft(blueprintId: string, includeDeleted = false): Promise<AgentBlueprintDraft> { const value = await this.repository.findAgentBlueprintDraft(blueprintId); if (!value || (!includeDeleted && await this.deleted("agent-blueprint", "draft", blueprintId))) throw this.notFound("Agent Blueprint draft"); return value; }
  async getAgentBlueprintVersion(versionRef: string, includeDeleted = false): Promise<AgentBlueprintVersion> { const value = await this.repository.findAgentBlueprintVersion(versionRef); if (!value || (!includeDeleted && await this.deleted("agent-blueprint", "version", versionRef))) throw this.notFound("Agent Blueprint version"); return value; }
  async saveAgentBlueprintDraft(input: { blueprintId?: string; expectedRevision?: number; name: string; definition: AgentBlueprintDefinition }): Promise<AgentBlueprintDraft> {
    if (!input.name.trim()) throw this.invalid("name", "must not be empty");
    const definition = agentBlueprintDefinitionSchema.parse(input.definition);
    await this.validateAgentBlueprint(definition);
    const blueprintId = input.blueprintId ?? `agent-blueprint:${randomUUID()}`;
    if (await this.deleted("agent-blueprint", "draft", blueprintId)) throw this.precondition("deleted Agent Blueprint draft IDs cannot be reused");
    const existing = await this.repository.findAgentBlueprintDraft(blueprintId);
    if (existing && existing.revision !== input.expectedRevision) throw this.precondition("Agent Blueprint draft has changed; reload before saving");
    if (!existing && input.expectedRevision !== undefined) throw this.notFound("Agent Blueprint draft");
    const draft = { blueprintId, name: input.name.trim(), ...structuredClone(definition), revision: (existing?.revision ?? 0) + 1, updatedAt: new Date().toISOString() };
    await this.repository.saveAgentBlueprintDraft(draft);
    return draft;
  }
  async publishAgentBlueprint(input: { blueprintId: string; expectedRevision: number }): Promise<AgentBlueprintVersion> {
    const draft = await this.getAgentBlueprintDraft(input.blueprintId);
    if (draft.revision !== input.expectedRevision) throw this.precondition("Agent Blueprint draft has changed; reload before publishing");
    const definition = agentBlueprintDefinitionSchema.parse({
      agentsMdVersionRef: draft.agentsMdVersionRef,
      mcpPolicyVersionRef: draft.mcpPolicyVersionRef,
      skillVersionRefs: draft.skillVersionRefs,
    });
    await this.validateAgentBlueprint(definition);
    const artifactDigest = sha256Digest(definition);
    const existing = (await this.repository.listAgentBlueprints()).versions.find((item) => item.artifactDigest === artifactDigest);
    if (existing) { if (await this.deleted("agent-blueprint", "version", existing.versionRef)) throw this.precondition("identical content belongs to a deleted Agent Blueprint version"); return existing; }
    const version = { ...structuredClone(draft), versionRef: `agent-blueprint:${draft.blueprintId}:${artifactDigest.slice(0, 16)}`, artifactDigest, publishedAt: new Date().toISOString(), draftRevision: draft.revision };
    delete (version as Partial<AgentBlueprintDraft>).revision;
    delete (version as Partial<AgentBlueprintDraft>).updatedAt;
    await this.repository.saveAgentBlueprintVersion(version);
    return version;
  }

  async listTurnPrompts(includeDeleted = false) { return this.filterDeletedLibrary("turn-prompt", await this.repository.listTurnPrompts(), includeDeleted); }
  async getTurnPromptDraft(promptId: string, includeDeleted = false): Promise<TurnPromptDraft> { const value = await this.repository.findTurnPromptDraft(promptId); if (!value || (!includeDeleted && await this.deleted("turn-prompt", "draft", promptId))) throw this.notFound("Turn Prompt draft"); return value; }
  async getTurnPromptVersion(versionRef: string, includeDeleted = false): Promise<TurnPromptVersion> { const value = await this.repository.findTurnPromptVersion(versionRef); if (!value || (!includeDeleted && await this.deleted("turn-prompt", "version", versionRef))) throw this.notFound("Turn Prompt version"); return value; }
  validateTurnPrompt(input: { source: string; variables: readonly TurnPromptVariableDefinition[] }) { return { valid: true as const, variables: validateTurnPromptDefinition(input.source, input.variables) }; }
  previewTurnPrompt(input: { source: string; definitions: readonly TurnPromptVariableDefinition[]; variables: TurnPromptSelection["variables"]; utcDate: string; roundId: number }) {
    const definitions = validateTurnPromptDefinition(input.source, input.definitions);
    const version: TurnPromptVersion = { promptId: "preview", name: "Preview", source: input.source, variables: definitions, versionRef: "turn-prompt:preview", artifactDigest: sha256Digest({ source: input.source, variables: definitions }), publishedAt: new Date(0).toISOString(), draftRevision: 0 };
    return { text: renderTurnPrompt(resolveTurnPrompt(version, { versionRef: version.versionRef, variables: input.variables }), { utcDate: input.utcDate, roundId: input.roundId }) };
  }
  async saveTurnPromptDraft(input: { promptId?: string; expectedRevision?: number; name: string; source: string; variables: readonly TurnPromptVariableDefinition[] }): Promise<TurnPromptDraft> {
    if (!input.name.trim()) throw this.invalid("name", "must not be empty");
    const variables = validateTurnPromptDefinition(input.source, input.variables);
    const promptId = input.promptId ?? `turn-prompt:${randomUUID()}`;
    if (await this.deleted("turn-prompt", "draft", promptId)) throw this.precondition("deleted Turn Prompt draft IDs cannot be reused");
    const existing = await this.repository.findTurnPromptDraft(promptId);
    if (existing && existing.revision !== input.expectedRevision) throw this.precondition("Turn Prompt draft has changed; reload before saving");
    if (!existing && input.expectedRevision !== undefined) throw this.notFound("Turn Prompt draft");
    const draft: TurnPromptDraft = { promptId, name: input.name.trim(), source: input.source, variables, revision: (existing?.revision ?? 0) + 1, updatedAt: new Date().toISOString() };
    await this.repository.saveTurnPromptDraft(draft);
    return draft;
  }
  async publishTurnPrompt(input: { promptId: string; expectedRevision: number }): Promise<TurnPromptVersion> {
    const draft = await this.getTurnPromptDraft(input.promptId);
    if (draft.revision !== input.expectedRevision) throw this.precondition("Turn Prompt draft has changed; reload before publishing");
    const variables = validateTurnPromptDefinition(draft.source, draft.variables);
    const artifactDigest = sha256Digest({ source: draft.source, variables });
    const existing = (await this.repository.listTurnPrompts()).versions.find((item) => item.artifactDigest === artifactDigest);
    if (existing) { if (await this.deleted("turn-prompt", "version", existing.versionRef)) throw this.precondition("identical content belongs to a deleted Turn Prompt version"); return existing; }
    const version: TurnPromptVersion = { promptId: draft.promptId, name: draft.name, source: draft.source, variables, versionRef: `turn-prompt:${draft.promptId}:${artifactDigest.slice(0, 16)}`, artifactDigest, publishedAt: new Date().toISOString(), draftRevision: draft.revision };
    await this.repository.saveTurnPromptVersion(version);
    return version;
  }

  deletePopulationDraft(input: { populationId: string; expectedRevision: number; idempotencyKey: string }) { return this.deleteDraft("population", input.populationId, input.expectedRevision, input.idempotencyKey, () => this.repository.findPopulationDraft(input.populationId)); }
  deletePopulationVersion(input: { versionRef: string; idempotencyKey: string }) { return this.deleteVersion("population", input.versionRef, input.idempotencyKey, () => this.repository.findPopulationVersion(input.versionRef)); }
  deleteAgentBlueprintDraft(input: { blueprintId: string; expectedRevision: number; idempotencyKey: string }) { return this.deleteDraft("agent-blueprint", input.blueprintId, input.expectedRevision, input.idempotencyKey, () => this.repository.findAgentBlueprintDraft(input.blueprintId)); }
  deleteAgentBlueprintVersion(input: { versionRef: string; idempotencyKey: string }) { return this.deleteVersion("agent-blueprint", input.versionRef, input.idempotencyKey, () => this.repository.findAgentBlueprintVersion(input.versionRef)); }
  deleteTurnPromptDraft(input: { promptId: string; expectedRevision: number; idempotencyKey: string }) { return this.deleteDraft("turn-prompt", input.promptId, input.expectedRevision, input.idempotencyKey, () => this.repository.findTurnPromptDraft(input.promptId)); }
  deleteTurnPromptVersion(input: { versionRef: string; idempotencyKey: string }) { return this.deleteVersion("turn-prompt", input.versionRef, input.idempotencyKey, () => this.repository.findTurnPromptVersion(input.versionRef)); }

  async listWorldGenerators() { return this.repository.listWorldGenerators(); }
  async getWorldGeneratorDraft(generatorId: string): Promise<WorldGeneratorDraft> {
    const draft = await this.repository.findWorldGeneratorDraft(generatorId);
    if (!draft) throw this.notFound("world generator draft");
    return draft;
  }
  async getWorldGeneratorVersion(versionRef: string): Promise<WorldGeneratorVersion> {
    const version = await this.repository.findWorldGeneratorVersion(versionRef);
    if (!version) throw this.notFound("world generator version");
    return version;
  }
  async saveWorldGeneratorDraft(input: { generatorId?: string; expectedRevision?: number; kind: WorldGeneratorKind; name: string; source: string; defaultConfig?: Record<string, unknown>; configSchema?: Record<string, unknown>; dependencies?: string[]; limits?: WorldGeneratorLimits }): Promise<WorldGeneratorDraft> {
    if (!input.name.trim()) throw this.invalid("name", "must not be empty");
    if (!input.source.trim()) throw this.invalid("source", "must not be empty");
    const generatorId = input.generatorId ?? `world-generator:${randomUUID()}`;
    const existing = await this.repository.findWorldGeneratorDraft(generatorId);
    if (existing && input.expectedRevision !== existing.revision) throw this.precondition("world generator draft has changed; reload before saving");
    if (!existing && input.expectedRevision !== undefined) throw this.notFound("world generator draft");
    const draft: WorldGeneratorDraft = {
      generatorId,
      kind: input.kind,
      name: input.name.trim(),
      source: input.source,
      defaultConfig: structuredClone(input.defaultConfig ?? existing?.defaultConfig ?? {}),
      configSchema: structuredClone(input.configSchema ?? existing?.configSchema ?? {}),
      dependencies: normalizeGeneratorDependencies(input.dependencies ?? existing?.dependencies ?? []),
      limits: normalizeGeneratorLimits(input.limits ?? existing?.limits),
      revision: (existing?.revision ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    await this.repository.saveWorldGeneratorDraft(draft);
    return draft;
  }
  async validateWorldGenerator(input: { generatorId: string; source?: string; dependencies?: string[]; limits?: WorldGeneratorLimits }) {
    const draft = await this.getWorldGeneratorDraft(input.generatorId);
    return this.worldGenerator().validate({
      kind: draft.kind,
      source: input.source ?? draft.source,
      dependencies: normalizeGeneratorDependencies(input.dependencies ?? draft.dependencies),
      limits: normalizeGeneratorLimits(input.limits ?? draft.limits),
    });
  }
  async publishWorldGenerator(input: { generatorId: string; expectedRevision: number }): Promise<WorldGeneratorVersion> {
    const draft = await this.getWorldGeneratorDraft(input.generatorId);
    if (draft.revision !== input.expectedRevision) throw this.precondition("world generator draft has changed; reload before publishing");
    const validation = await this.worldGenerator().validate({ kind: draft.kind, source: draft.source, dependencies: draft.dependencies, limits: draft.limits });
    if (!validation.valid) throw this.invalid("source", `world generator validation failed: ${validation.errors.join("; ") || "unknown error"}`);
    const configSchema = validation.configSchema ?? draft.configSchema;
    const defaultConfig = validation.defaultConfig ?? draft.defaultConfig;
    const artifactDigest = sha256Digest({ kind: draft.kind, source: draft.source, configSchema, defaultConfig, dependencies: draft.dependencies, limits: draft.limits });
    const existing = (await this.repository.listWorldGenerators()).versions.find((candidate) => candidate.artifactDigest === artifactDigest);
    if (existing) return existing;
    const version: WorldGeneratorVersion = {
      generatorId: draft.generatorId,
      kind: draft.kind,
      name: draft.name,
      source: draft.source,
      configSchema: structuredClone(configSchema),
      defaultConfig: structuredClone(defaultConfig),
      dependencies: [...draft.dependencies],
      limits: structuredClone(draft.limits),
      versionRef: `world-generator:${draft.kind}:${draft.generatorId}:${artifactDigest.slice(0, 16)}`,
      artifactDigest,
      publishedAt: new Date().toISOString(),
      draftRevision: draft.revision,
    };
    await this.repository.saveWorldGeneratorVersion(version);
    return version;
  }

  async validateSpecification(input: unknown): Promise<{ specification: PluginSpecification; digest: string }> {
    const parsed = pluginSpecificationSchema.parse(input);
    const template = this.researchTemplateVersion(parsed.researchTemplate.versionRef);
    const selected = new Set(Object.keys(parsed.contexts));
    for (const contextId of template.definition.requiredContexts) if (!selected.has(contextId)) throw this.invalid("specification.contexts", `required Context '${contextId}' is missing`);
    const allowed = new Set([...template.definition.requiredContexts, ...template.definition.optionalContexts]);
    for (const contextId of selected) if (!allowed.has(contextId)) throw this.invalid("specification.contexts", `Context '${contextId}' is not allowed by the selected Research Template`);
    const catalog = new Map((await this.ports.pluginContexts.catalog()).map((descriptor) => [descriptor.contextId, descriptor]));
    for (const [contextId, selection] of Object.entries(parsed.contexts)) {
      const descriptor = catalog.get(contextId);
      if (!descriptor) throw this.invalid(`specification.contexts.${contextId}`, "must reference an active Context installation");
      if (descriptor.revision !== selection.descriptorRevision) throw this.invalid(`specification.contexts.${contextId}.descriptorRevision`, "does not match the active descriptor revision");
    }
    const agentExecution = await this.ports.agentExecution.validate(parsed.agentExecution);
    const specification = pluginSpecificationSchema.parse({ ...parsed, agentExecution });
    await this.resolveTurnPromptSelection(specification.turnPrompt);
    await this.validateWorldGeneratorSelections(specification);
    return { specification, digest: sha256Digest(specification) };
  }

  async validateSpecificationV2(input: unknown) { return this.validateSpecification(input); }

  async createRun(input: { mutation: MutationHeader; specification: unknown }): Promise<RunStatus> {
    this.requireInitialization(input.mutation);
    const validated = await this.validateSpecification(input.specification);
    if (input.mutation.payloadDigest !== validated.digest) throw this.invalid("mutation.payloadDigest", "must equal the canonical specification digest");
    const runId = `run:${input.mutation.transitionId}`;
    const existing = await this.repository.findRun(runId);
    if (existing) {
      if (existing.specificationDigest !== validated.digest) throw this.conflict("transition already created this run with another digest");
      return existing.status;
    }
    const resolvedWorld = await this.resolveWorld(runId, validated.specification);
    const registrations = this.registrationsFor(runId, resolvedWorld);
    await Promise.all([
      ...Object.entries(validated.specification.contexts).map(([contextId, selection]) => this.ports.pluginContexts.execute(selection.installationRef, { operation: "validate", configuration: selection.configuration, participants: this.contextParticipants(contextId, runId, resolvedWorld, registrations, false) })),
      this.ports.agentExecution.validateAgentsMdVersions(resolvedWorld.population.map((member) => member.agentsMdVersionRef)),
    ]);
    const record: RunRecord = {
      status: { runId, lifecycle: "queued", committedRound: 0, configuredRounds: validated.specification.roundCount, conditionDigest: conditionDigest(validated.specification, resolvedWorld) },
      specification: validated.specification,
      specificationDigest: validated.digest,
      resolvedWorld,
      turnPrompt: await this.resolveTurnPromptSelection(validated.specification.turnPrompt),
    };
    await this.repository.createRun(record, registrations);
    await this.repository.saveReceipt("create", input.mutation.transitionId, input.mutation.stepId, { requestDigest: validated.digest, result: record.status });
    return record.status;
  }

  async createRunV2(input: { mutation: MutationHeader; specification: unknown }) { return this.createRun(input); }

  async getRun(runId: string): Promise<RunRecord> { return this.mustRun(runId); }
  async listRuns(input: { cursor?: string | undefined; limit: number; lifecycle?: RunStatus["lifecycle"] | undefined }) {
    const result = await this.repository.listRuns(input);
    return { runs: result.items.map((run) => run.status), nextCursor: result.nextCursor };
  }
  async roundProgress(runId: string): Promise<RoundProgress | undefined> { await this.mustRun(runId); return this.repository.getRoundProgress(runId); }
  async agentRegistrations(runId: string): Promise<readonly RunAgentRegistration[]> {
    await this.mustRun(runId);
    return this.repository.listRunAgentRegistrations(runId);
  }

  async cancelRun(input: { runId: string; mutation: MutationHeader }): Promise<RunStatus> {
    return this.repository.withRunLock(input.runId, async () => {
      const current = await this.mustRun(input.runId);
      this.requireCurrentManifest(input.mutation, current);
      if (["completed", "cancelled"].includes(current.status.lifecycle)) return current.status;
      await this.repository.cancelActiveAttempt(input.runId);
      const revokedAt = new Date().toISOString();
      await this.repository.revokeRunAgentRegistrations({ runId: input.runId, revokedAt });
      const initialized = current.status.committedManifestRef !== undefined;
      if (initialized) {
        await Promise.all([
          ...Object.entries(current.specification.contexts).map(([contextId, selection]) => this.ports.pluginContexts.execute(selection.installationRef, { operation: "revoke", runId: input.runId, mutation: this.contextMutation(input.runId, current.status.committedRound, `revoke:${contextId}`, current.status.committedManifestRef ?? "") })),
          ...(this.ports.contextGateway ? [this.ports.contextGateway.revokeRun(input.runId)] : []),
        ]);
      }
      const status = { ...current.status, lifecycle: "cancelled" as const };
      await this.repository.saveRun({ ...current, status });
      if (initialized) await this.repository.enqueueRunRelease(input.runId);
      await this.repository.saveReceipt(`cancel:${input.runId}`, input.mutation.transitionId, input.mutation.stepId, { requestDigest: input.mutation.payloadDigest, result: status });
      return status;
    });
  }

  /** Freeze and enqueue only. Model work and commit work happen in RoundWorker. */
  async resumeRun(input: { runId: string; mutation: MutationHeader }): Promise<RunStatus> {
    const replay = await this.repository.findReceipt<RunStatus>(`resume:${input.runId}`, input.mutation.transitionId, input.mutation.stepId);
    if (replay) { this.ensureSameDigest(input.mutation.payloadDigest, replay.requestDigest); return replay.result; }
    return this.repository.withRunLock(input.runId, async () => {
      let run = await this.mustRun(input.runId);
      const active = await this.repository.findActiveAttempt(input.runId);
      // A genuinely concurrent first resume can arrive with the empty
      // initialization checkpoint after its peer has already frozen the
      // round. It joins that immutable attempt instead of manufacturing a
      // stale-manifest error or another snapshot.
      if (active) return { ...run.status, lifecycle: active.state === "retry_wait" ? "retry_wait" : "running" };
      this.requireCurrentManifest(input.mutation, run);
      if (["completed", "cancelled"].includes(run.status.lifecycle)) return run.status;
      if (run.status.lifecycle === "failed") return run.status;
      if (!run.status.committedManifestRef) run = await this.initialize(run);
      if (run.status.committedRound >= run.status.configuredRounds) {
        const completed = { ...run.status, lifecycle: "completed" as const };
        await this.repository.saveRun({ ...run, status: completed });
        await this.repository.enqueueRunRelease(input.runId);
        return completed;
      }
      try {
        run = await this.freezeAndEnqueue(run);
      } catch (error) {
        const failureCategory = algorithmExecutionFailureCategory(error);
        if (failureCategory === undefined) throw error;
        const failed: RunStatus = {
          ...run.status,
          lifecycle: "failed",
          failure: {
            category: failureCategory,
            message: error instanceof Error ? error.message.slice(0, 10_000) : String(error).slice(0, 10_000),
            occurredAt: new Date().toISOString(),
          },
        };
        await this.repository.saveRun({ ...run, status: failed });
        await this.repository.enqueueRunRelease(input.runId);
        await this.repository.saveReceipt(`resume:${input.runId}`, input.mutation.transitionId, input.mutation.stepId, { requestDigest: input.mutation.payloadDigest, result: failed });
        return failed;
      }
      await this.repository.saveReceipt(`resume:${input.runId}`, input.mutation.transitionId, input.mutation.stepId, { requestDigest: input.mutation.payloadDigest, result: run.status });
      return run.status;
    });
  }

  /** Retry is intentionally narrow: only a wait state may be retried. */
  async retryRun(input: { runId: string; mutation: MutationHeader }): Promise<RunStatus> {
    const replay = await this.repository.findReceipt<RunStatus>(`retry:${input.runId}`, input.mutation.transitionId, input.mutation.stepId);
    if (replay) { this.ensureSameDigest(input.mutation.payloadDigest, replay.requestDigest); return replay.result; }
    return this.repository.withRunLock(input.runId, async () => {
      const run = await this.mustRun(input.runId);
      this.requireCurrentManifest(input.mutation, run);
      if (
        run.status.lifecycle === "failed"
        && run.status.failure?.category.startsWith("round_advance_")
        && await this.repository.findActiveAttempt(input.runId) === undefined
      ) {
        const { failure: _failure, advanceRetry: _advanceRetry, ...rest } = run.status;
        const status: RunStatus = { ...rest, lifecycle: "running" };
        await this.repository.saveRun({ ...run, status });
        await this.repository.saveReceipt(`retry:${input.runId}`, input.mutation.transitionId, input.mutation.stepId, { requestDigest: input.mutation.payloadDigest, result: status });
        return status;
      }
      if (run.status.lifecycle !== "retry_wait") throw this.precondition("run is not waiting for retry");
      const previous = await this.repository.findActiveAttempt(input.runId);
      if (!previous || previous.state !== "retry_wait") throw this.precondition("no retryable round attempt exists");
      if (previous.commitStarted) {
        await this.repository.markAttemptQueued(previous.attemptId);
      } else {
        const snapshot = await this.repository.findSnapshot(previous.snapshotId);
        if (!snapshot) throw new Error("retry attempt snapshot is missing");
        const oldJobs = await this.repository.listAttemptJobs(previous.attemptId);
        const retry = this.roundAttempt(snapshot, previous.attempt + 1);
        const jobs = oldJobs.map((job) => this.retryJob(job, retry, snapshot));
        await this.repository.createRetryAttempt(previous, retry, jobs);
      }
      const { failure: _failure, advanceRetry: _advanceRetry, ...rest } = run.status;
      const status = { ...rest, lifecycle: "running" as const };
      await this.repository.saveRun({ ...run, status });
      await this.repository.saveReceipt(`retry:${input.runId}`, input.mutation.transitionId, input.mutation.stepId, { requestDigest: input.mutation.payloadDigest, result: status });
      return status;
    });
  }

  async forkRun(input: {
    sourceRunId: string;
    sourceManifestRef: string;
    mutation: MutationHeader;
    turnPrompt?: PluginSpecification["turnPrompt"];
    /** Explicit cognition-only intervention; keys must be source Run agent IDs. */
    agentsMdByAgentId?: Readonly<Record<string, string>>;
    contextConfigurations?: Readonly<Record<string, Record<string, unknown>>>;
  }): Promise<RunStatus> {
    this.requireNonEmptyCheckpoint(input.mutation);
    const source = await this.mustRun(input.sourceRunId);
    if (input.mutation.expectedCheckpointRef !== input.sourceManifestRef) {
      throw this.precondition("fork mutation must bind the requested source manifest");
    }
    const sourceManifest = await this.repository.findManifest(input.sourceManifestRef);
    if (!sourceManifest || sourceManifest.runId !== source.status.runId || sourceManifest.state !== "committed") throw this.precondition("fork source must be a committed manifest owned by source run");
    if (sourceManifest.roundId >= source.status.configuredRounds) throw this.precondition("fork source has no configured rounds remaining");
    const runId = `run:fork:${input.mutation.transitionId}`;
    const existing = await this.repository.findRun(runId);
    if (existing) return existing.status;
    const requestedSpecification: PluginSpecification = {
      ...source.specification,
      turnPrompt: input.turnPrompt ?? source.specification.turnPrompt,
      contexts: Object.fromEntries(Object.entries(source.specification.contexts).map(([contextId, selection]) => [contextId, { ...selection, configuration: structuredClone(input.contextConfigurations?.[contextId] ?? selection.configuration) }])),
    };
    const specification: PluginSpecification = {
      ...requestedSpecification,
      agentExecution: await this.ports.agentExecution.validate(requestedSpecification.agentExecution),
    };
    const turnPrompt = input.turnPrompt === undefined ? structuredClone(source.turnPrompt) : await this.resolveTurnPromptSelection(specification.turnPrompt);
    const sourceWorld = this.requireResolvedWorld(source);
    const agentsMdByAgentId = input.agentsMdByAgentId ?? {};
    const knownAgentIds = new Set(sourceWorld.population.map((member) => member.agentId));
    for (const agentId of Object.keys(agentsMdByAgentId)) {
      if (!knownAgentIds.has(agentId)) throw this.invalid("agentsMdByAgentId", `unknown source Run agent '${agentId}'`);
    }
    await this.ports.agentExecution.validateAgentsMdVersions(Object.values(agentsMdByAgentId));
    const resolvedWorld: ResolvedWorldRecord = {
      population: sourceWorld.population.map((member) => ({ ...member, agentsMdVersionRef: agentsMdByAgentId[member.agentId] ?? member.agentsMdVersionRef })),
      digest: "",
    };
    resolvedWorld.digest = sha256Digest({ population: resolvedWorld.population });
    const registrations = this.registrationsFor(runId, resolvedWorld);
    const contexts = Object.fromEntries(await Promise.all(Object.entries(specification.contexts).map(async ([contextId, selection]) => {
      const sourceRevision = sourceManifest.contexts[contextId];
      if (!sourceRevision) throw new Error(`Context '${contextId}' is missing from the source manifest`);
      const result = await this.ports.pluginContexts.execute(selection.installationRef, { operation: "fork", sourceRunId: source.status.runId, sourceRevision, targetRun: this.runtimeRun(runId, specification), configuration: selection.configuration, participants: this.contextParticipants(contextId, runId, resolvedWorld, registrations, true), mutation: this.contextMutation(runId, sourceManifest.roundId, `fork:${contextId}`, sourceRevision.ref) });
      if (!result.revision) throw new Error(`Context '${contextId}' did not return a fork revision`);
      return [contextId, result.revision] as const;
    })));
    const mcp = await this.contextMcpBindings(runId, sourceManifest.roundId, contexts, resolvedWorld, registrations, specification);
    const agentExecution = await this.ports.agentExecution.fork({
      sourceRunId: source.status.runId,
      source: sourceManifest.agentExecution,
      targetRunId: runId,
      mutation: this.contextMutation(runId, sourceManifest.roundId, "fork_agent", sourceManifest.agentExecution.ref),
      mcp,
      section: specification.agentExecution,
      ...(Object.keys(agentsMdByAgentId).length ? { agentsMdByAgentId } : {}),
      ...(input.turnPrompt === undefined ? {} : { turnPrompt }),
    });
    const manifest = this.manifest(runId, sourceManifest.roundId, "committed", agentExecution, contexts, sourceManifest.ref);
    const record: RunRecord = {
      status: { runId, lifecycle: "running", committedRound: sourceManifest.roundId, configuredRounds: source.status.configuredRounds, committedManifestRef: manifest.ref, conditionDigest: conditionDigest(specification, resolvedWorld) },
      specification,
      specificationDigest: sha256Digest(specification),
      lineageParentManifestRef: sourceManifest.ref,
      resolvedWorld,
      turnPrompt,
    };
    await this.repository.createRun(record, registrations);
    await this.repository.saveManifest(manifest);
    return record.status;
  }

  async committedRounds(runId: string, input: { cursor?: string | undefined; limit: number }) { await this.mustRun(runId); return this.repository.listCommittedManifests(runId, input); }
  async committedManifest(runId: string, ref?: string): Promise<PluginManifest> {
    const run = await this.mustRun(runId);
    const manifest = await this.repository.findManifest(ref ?? run.status.committedManifestRef ?? "");
    if (!manifest || manifest.runId !== runId || manifest.state !== "committed") throw this.notFound("committed manifest");
    return manifest;
  }

  /** Worker entry point for terminal runtime cleanup. Its failure is retried
   * by the durable release queue and deliberately cannot change run status. */
  async releaseRun(runId: string): Promise<void> {
    const run = await this.mustRun(runId);
    await Promise.all([
      this.ports.agentExecution.release(runId),
      ...Object.entries(run.specification.contexts).map(([contextId, selection]) => this.ports.pluginContexts.execute(selection.installationRef, { operation: "revoke", runId, mutation: this.contextMutation(runId, run.status.committedRound, `release:${contextId}`, run.status.committedManifestRef ?? "") })),
      ...(this.ports.contextGateway ? [this.ports.contextGateway.revokeRun(runId)] : []),
    ]);
    await this.repository.revokeRunAgentRegistrations({ runId, revokedAt: new Date().toISOString() });
  }

  /** Worker entry point; deliberately exported so test doubles can drive it. */
  async executeClaim(claim: ClaimedJob): Promise<void> {
    const mutation = this.contextMutation(claim.attempt.runId, claim.attempt.roundId, `execute_agent:${claim.job.agentId}`, claim.snapshot.baseline.agentExecution.ref);
    const token = claim.job.leaseToken;
    if (!token) throw new Error("claimed job has no lease token");
    const scopes = new Map<string, ContextMcpScopeLease>();
    const run = await this.mustRun(claim.attempt.runId);
    let executionFailure: { error: unknown } | undefined;
    try {
      const registration = await this.activeRegistration(claim.attempt.runId, claim.job.agentId);
      const member = this.requireResolvedWorld(run).population.find((candidate) => candidate.agentId === claim.job.agentId);
      if (!member) throw new Error(`Experiment identity invariant: resolved Agent is missing for ${claim.job.agentId}`);
      for (const [contextId, context] of Object.entries(member.contexts).filter(([, binding]) => binding.enabled)) {
        const revision = claim.snapshot.contextReadRevisions[contextId];
        const selection = run.specification.contexts[contextId];
        if (!revision || !selection) throw new Error(`Context '${contextId}' is missing from the round snapshot`);
        const result = await this.ports.pluginContexts.execute(selection.installationRef, { operation: "open_scope", runId: claim.attempt.runId, roundId: claim.attempt.roundId, revision, agentId: claim.job.agentId, principalId: registration.principalId, turnId: claim.job.turnId, attemptId: claim.attempt.attemptId });
        if (!result.scope) throw new Error(`Context '${contextId}' did not return an MCP scope lease`);
        this.validateMcpScopeLease(contextId, result.scope, claim, registration.principalId);
        scopes.set(contextId, result.scope);
      }
      await this.ports.agentExecution.execute({ runId: claim.attempt.runId, roundId: claim.attempt.roundId, agentId: claim.job.agentId, attemptId: claim.attempt.attemptId, orchestrationTurnId: claim.job.turnId, utcDate: claim.snapshot.utcDate, mutation, baseline: claim.snapshot.baseline.agentExecution });
    } catch (error) {
      executionFailure = { error };
    } finally {
      try {
        await this.closeMcpScopes(run, claim.job.agentId, scopes);
      } catch (error) {
        executionFailure ??= { error };
      }
    }
    if (executionFailure !== undefined) {
      await this.repository.failJob({ jobId: claim.job.jobId, leaseToken: token, failure: failureFrom(executionFailure.error), now: new Date() });
      return;
    }
    // Context-owned MCP tools durably enqueue their intents themselves.
    // Experiment records only provider completion, never business actions.
    await this.repository.completeJob({ jobId: claim.job.jobId, leaseToken: token, result: [], resultDigest: sha256Digest([]), now: new Date() });
  }

  /** Worker entry point for the single-winner move of the global manifest HEAD. */
  async commitAttempt(work: CommitWork): Promise<void> {
    const run = await this.mustRun(work.attempt.runId);
    const baseline = work.snapshot.baseline;
    let ledger = await this.repository.loadLedger(work.attempt.attemptId) ?? await this.repository.startLedger(work.attempt.attemptId);
    const mutation = (stepId: string, revision: { ref: string }) => this.contextMutation(run.status.runId, work.attempt.roundId, stepId, revision.ref);
    const finalFailedTurnIds = work.jobs.filter((job) => job.state === "failed").map((job) => job.turnId);
    const through = async (step: LedgerStep, effect: () => Promise<void>) => {
      if (ledger.completed.has(step)) return;
      if (this.options.faultBoundary?.step === step && this.options.faultBoundary.moment === "before") throw new FaultInjectedError(step, "before");
      await effect();
      if (this.options.faultAfterStep === step) throw new FaultInjectedError(step, "after_effect");
      ledger = await this.repository.completeLedgerStep(work.attempt.attemptId, step);
      if (this.options.faultBoundary?.step === step && this.options.faultBoundary.moment === "after") throw new FaultInjectedError(step, "after");
    };
    try {
      await this.waitForContextSettlement(work.attempt.runId, work.attempt.roundId, finalFailedTurnIds);
      const agentCheckpoint = await this.ports.agentExecution.seal({ runId: run.status.runId, roundId: work.attempt.roundId, mutation: mutation("seal_agent", baseline.agentExecution) });
      await through("seal_agent", async () => undefined);
      const contexts: Record<string, DynamicContextRevision> = {};
      for (const [contextId, baseRevision] of Object.entries(baseline.contexts).sort(([left], [right]) => left.localeCompare(right))) {
        const readRevision = work.snapshot.contextReadRevisions[contextId];
        const selection = run.specification.contexts[contextId];
        if (!readRevision || !selection) throw new Error(`Context '${contextId}' is missing from the commit inputs`);
        const step = `seal_context:${contextId}`;
        const result = await this.ports.pluginContexts.execute(selection.installationRef, { operation: "seal", runId: run.status.runId, roundId: work.attempt.roundId, baseline: baseRevision, readRevision, finalFailedTurnIds: [...finalFailedTurnIds], mutation: mutation(step, baseRevision) });
        if (!result.revision) throw new Error(`Context '${contextId}' did not return a sealed revision`);
        contexts[contextId] = result.revision;
        await through(step, async () => undefined);
      }
      const decision = this.manifest(run.status.runId, work.attempt.roundId, "publishing", agentCheckpoint, contexts, baseline.ref);
      await through("write_commit_decision", () => this.repository.saveManifest(decision));
      await through("publish_agent", () => this.ports.agentExecution.publish({ runId: run.status.runId, roundId: work.attempt.roundId, mutation: mutation("publish_agent", baseline.agentExecution), checkpoint: agentCheckpoint }));
      for (const [contextId, candidate] of Object.entries(contexts).sort(([left], [right]) => left.localeCompare(right))) {
        const selection = run.specification.contexts[contextId]!;
        const baseRevision = baseline.contexts[contextId]!;
        const step = `publish_context:${contextId}`;
        await through(step, () => this.ports.pluginContexts.execute(selection.installationRef, { operation: "publish", runId: run.status.runId, roundId: work.attempt.roundId, candidate, mutation: mutation(step, baseRevision) }).then(() => undefined));
      }
      await through("mark_committed", async () => {
        const committed = this.manifest(run.status.runId, work.attempt.roundId, "committed", agentCheckpoint, contexts, baseline.ref);
        const status: RunStatus = { ...run.status, lifecycle: work.attempt.roundId >= run.status.configuredRounds ? "completed" : "running", committedRound: work.attempt.roundId, committedManifestRef: committed.ref };
        await this.repository.markCommitted(work.attempt.attemptId, committed, status);
      });
    } catch (error) {
      await this.repository.markCommitRetry(work.attempt.attemptId, failureFrom(error));
    }
  }

  private async waitForContextSettlement(runId: string, roundId: number, finalFailedTurnIds: readonly string[]): Promise<void> {
    const run = await this.mustRun(runId);
    const timeoutMs = this.options.settlementTimeoutMs ?? 120_000;
    const deadline = Date.now() + timeoutMs;
    let backoffMs = this.options.settlementInitialBackoffMs ?? 100;
    const maxBackoffMs = this.options.settlementMaxBackoffMs ?? 1_000;
    while (true) {
      const statuses = await Promise.all(Object.entries(run.specification.contexts).map(async ([contextId, selection]) => ({ contextId, result: (await this.ports.pluginContexts.execute(selection.installationRef, { operation: "settlement", runId, roundId, finalFailedTurnIds: [...finalFailedTurnIds] })).settlement })));
      if (statuses.every(({ result }) => result?.settled)) return;
      if (Date.now() >= deadline) {
        throw new Error(`Context settlement timed out after ${timeoutMs}ms (${statuses.map(({ contextId, result }) => `${contextId} pending=${result?.pendingCount ?? "unknown"} rejected=${result?.rejectedCount ?? "unknown"}`).join("; ")})`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(backoffMs, Math.max(0, deadline - Date.now()))));
      backoffMs = Math.min(maxBackoffMs, backoffMs * 2);
    }
  }

  private worldGenerator() {
    if (!this.ports.worldGenerator) throw this.precondition("Population and Network generator runner is not configured");
    return this.ports.worldGenerator;
  }

  private async validateWorldGeneratorSelections(specification: PluginSpecification): Promise<void> {
    try {
      await this.getPopulationVersion(specification.initialWorld.population.versionRef);
    } catch {
      throw this.invalid("initialWorld.population.versionRef", "must reference a non-deleted published Population");
    }
  }

  private async rejectDeletedBlueprintReferences(entries: readonly PopulationEntry[]): Promise<void> {
    for (const entry of entries) {
      if (await this.deleted("agent-blueprint", "version", entry.agentBlueprintVersionRef)) {
        throw this.precondition(`Population references deleted Agent Blueprint version '${entry.agentBlueprintVersionRef}'`);
      }
    }
  }

  private async validateAgentBlueprint(definition: AgentBlueprintDefinition): Promise<void> {
    await this.ports.agentExecution.validateAgentsMdVersions([definition.agentsMdVersionRef]);
    const policyVersion = await this.ports.agentExecution.mcpPolicyVersion(definition.mcpPolicyVersionRef);
    const policy = mcpPolicyDefinitionSchema.parse({ tools: policyVersion.tools, resources: policyVersion.resources, ...(policyVersion.contexts === undefined ? {} : { contexts: policyVersion.contexts }) });
    const enabled = new Set(Object.entries(policy.contexts ?? {}).filter(([, binding]) => binding.enabled).map(([contextId]) => contextId));
    for (const capability of [...policy.tools, ...policy.resources]) {
      const context = capability.split(".", 1)[0]!;
      if (!enabled.has(context)) throw this.invalid("mcpPolicyVersionRef", `grants ${context} access but that Context is disabled`);
    }
    const skills = await Promise.all(definition.skillVersionRefs.map((versionRef) => this.ports.agentExecution.skillVersion(versionRef)));
    for (const skill of skills) {
      for (const tool of skill.requirements?.tools ?? []) if (!policy.tools.includes(tool as never)) throw this.invalid("skillVersionRefs", `Skill '${skill.versionRef}' requires MCP tool '${tool}'`);
      for (const resource of skill.requirements?.resources ?? []) if (!policy.resources.includes(resource as never)) throw this.invalid("skillVersionRefs", `Skill '${skill.versionRef}' requires MCP resource '${resource}'`);
    }
  }

  private async resolveWorld(runId: string, specification: PluginSpecification): Promise<ResolvedWorldRecord> {
    const version = await this.getPopulationVersion(specification.initialWorld.population.versionRef);
    const expanded = version.entries.flatMap((entry) => Array.from({ length: entry.count }, (_, index) => ({ entry, cohortIndex: index + 1 })));
    const population: ResolvedWorldRecord["population"][number][] = [];
    for (const [{ entry, cohortIndex }, index] of expanded.map((value, index) => [value, index] as const)) {
      const blueprint = await this.getAgentBlueprintVersion(entry.agentBlueprintVersionRef);
      await this.validateAgentBlueprint(blueprint);
      const policyVersion = await this.ports.agentExecution.mcpPolicyVersion(blueprint.mcpPolicyVersionRef);
      const mcpPolicy = mcpPolicyDefinitionSchema.parse({ tools: policyVersion.tools, resources: policyVersion.resources, ...(policyVersion.contexts === undefined ? {} : { contexts: policyVersion.contexts }) });
      const skills = await Promise.all(blueprint.skillVersionRefs.map((versionRef) => this.ports.agentExecution.skillVersion(versionRef)));
      const number = String(index + 1).padStart(6, "0");
      const agentId = `agent:${runId}:${number}`;
      population.push({
        slotId: `slot:${number}`, cohortKey: entry.key, cohortIndex,
        agentId,
        displayName: resolvedDisplayName(specification.initialWorld.nameTheme, specification.seed, index),
        agentBlueprintVersionRef: blueprint.versionRef,
        agentsMdVersionRef: blueprint.agentsMdVersionRef,
        skills: skills.map(({ versionRef, artifactDigest, skillName }) => ({ versionRef, artifactDigest, skillName })),
        mcpPolicyVersionRef: policyVersion.versionRef, mcpPolicyArtifactDigest: policyVersion.artifactDigest, mcpPolicy,
        contexts: structuredClone(mcpPolicy.contexts ?? {}),
      });
    }
    await this.ports.agentExecution.validateAgentsMdVersions(population.map((item) => item.agentsMdVersionRef));
    const digest = sha256Digest({ population });
    return { population, digest };
  }

  private requireResolvedWorld(run: RunRecord): ResolvedWorldRecord {
    if (!run.resolvedWorld) throw this.precondition("Run has no resolved Population/Network world");
    return run.resolvedWorld;
  }

  private async resolveTurnPromptSelection(selection: PluginSpecification["turnPrompt"]) {
    return resolveTurnPrompt(await this.getTurnPromptVersion(selection.versionRef), selection);
  }

  private async initialize(run: RunRecord): Promise<RunRecord> {
    const resolvedWorld = this.requireResolvedWorld(run);
    await this.repository.saveRun({ ...run, status: { ...run.status, lifecycle: "initializing" } });
    const init = (stepId: string): ContextMutation => ({ transitionId: `${run.status.runId}:initialize`, stepId, payloadDigest: sha256Digest({ runId: run.status.runId, stepId, specification: run.specification }), expectedCheckpointRef: "" });
    const contexts = Object.fromEntries(await Promise.all(Object.entries(run.specification.contexts).map(async ([contextId, selection]) => {
      const result = await this.ports.pluginContexts.execute(selection.installationRef, { operation: "initialize", run: this.runtimeRun(run.status.runId, run.specification), configuration: selection.configuration, participants: this.contextParticipants(contextId, run.status.runId, resolvedWorld, undefined, true), mutation: init(`initialize:${contextId}`) });
      if (!result.revision) throw new Error(`Context '${contextId}' did not return an initialization revision`);
      return [contextId, result.revision] as const;
    })));
    const mcp = await this.contextMcpBindings(run.status.runId, 0, contexts, resolvedWorld, undefined, run.specification);
    const agentExecution = await this.ports.agentExecution.initialize(run.status.runId, {
      section: run.specification.agentExecution,
      turnPrompt: run.turnPrompt,
      agents: resolvedWorld.population.map(({ agentId, agentsMdVersionRef, skills, contexts: memberContexts }) => ({
        agentId, agentsMdVersionRef, skillVersionRefs: skills.map((skill) => skill.versionRef),
        mcpContexts: Object.entries(memberContexts).filter(([contextId, binding]) => binding.enabled && run.specification.contexts[contextId]).map(([contextId]) => contextId).sort(),
      })),
    }, init("initialize_agent"), mcp);
    const manifest = this.manifest(run.status.runId, 0, "committed", agentExecution, contexts);
    await this.repository.saveManifest(manifest);
    const initialized = { ...run, status: { ...run.status, lifecycle: "running" as const, committedManifestRef: manifest.ref } };
    await this.repository.saveRun(initialized);
    return initialized;
  }

  private async freezeAndEnqueue(run: RunRecord): Promise<RunRecord> {
    const baseline = await this.committedManifest(run.status.runId, run.status.committedManifestRef);
    const roundId = run.status.committedRound + 1;
    const agentIds = this.requireResolvedWorld(run).population.map((agent) => agent.agentId);
    const contextReadRevisions = Object.fromEntries(await Promise.all(Object.entries(baseline.contexts).map(async ([contextId, revision]) => {
      const selection = run.specification.contexts[contextId];
      if (!selection) throw new Error(`Context '${contextId}' is missing from the Run specification`);
      const result = await this.ports.pluginContexts.execute(selection.installationRef, { operation: "freeze", runId: run.status.runId, roundId, baseline: revision, mutation: this.contextMutation(run.status.runId, roundId, `freeze:${contextId}`, revision.ref) });
      if (!result.revision) throw new Error(`Context '${contextId}' did not return a frozen revision`);
      return [contextId, result.revision] as const;
    })));
    const snapshotId = `snapshot:${run.status.runId}:round:${roundId}`;
    const utcDate = simulationUtcDate(run.specification, roundId);
    const body = { snapshotId, runId: run.status.runId, roundId, baseline, contextReadRevisions, declaredAgentIds: agentIds, maxConcurrentAgents: run.specification.agentExecution.maxConcurrentAgents, toolCallBudget: run.specification.agentExecution.toolCallBudget, automaticRetryMaxAttempts: run.specification.executionPolicy.automaticRetryMaxAttempts, automaticRetryBackoffMs: run.specification.executionPolicy.automaticRetryBackoffMs, utcDate };
    const snapshot: RoundSnapshot = { ...body, digest: sha256Digest(body), createdAt: new Date().toISOString() };
    const attempt = this.roundAttempt(snapshot, 1);
    const jobs = snapshot.declaredAgentIds.map((agentId, declarationIndex) => this.job(attempt, agentId, declarationIndex));
    await this.repository.saveSnapshotAndAttempt(snapshot, attempt, jobs);
    const { failure: _failure, advanceRetry: _advanceRetry, ...rest } = run.status;
    const status = { ...rest, lifecycle: "running" as const };
    const next = { ...run, status };
    await this.repository.saveRun(next);
    return next;
  }

  private roundAttempt(snapshot: RoundSnapshot, number: number): RoundAttempt {
    const now = new Date().toISOString();
    return { attemptId: `attempt:${snapshot.snapshotId}:${number}`, runId: snapshot.runId, roundId: snapshot.roundId, snapshotId: snapshot.snapshotId, attempt: number, state: "queued", commitStarted: false, createdAt: now, updatedAt: now };
  }
  private job(attempt: RoundAttempt, agentId: string, declarationIndex: number): AgentJob {
    const now = new Date().toISOString();
    return { jobId: `job:${attempt.attemptId}:${agentId}`, attemptId: attempt.attemptId, turnId: `turn:${attempt.snapshotId}:${agentId}`, agentId, declarationIndex, state: "queued", attempts: 0, availableAt: now, updatedAt: now };
  }
  private retryJob(previous: AgentJob, attempt: RoundAttempt, snapshot: RoundSnapshot): AgentJob {
    const fresh = this.job(attempt, previous.agentId, previous.declarationIndex);
    return previous.state === "succeeded" && previous.result && previous.resultDigest
      ? { ...fresh, state: "succeeded", attempts: previous.attempts, result: previous.result, resultDigest: previous.resultDigest }
      : fresh;
  }
  private contextMutation(runId: string, roundId: number, stepId: string, expectedCheckpointRef: string): ContextMutation {
    const transitionId = `transition:${runId}:round:${roundId}`;
    return { transitionId, stepId, expectedCheckpointRef, payloadDigest: sha256Digest({ transitionId, stepId, expectedCheckpointRef }) };
  }
  private manifest(runId: string, roundId: number, state: PluginManifest["state"], agentExecution: Checkpoint, contexts: Readonly<Record<string, DynamicContextRevision>>, parentManifestRef?: string): PluginManifest {
    const ref = `manifest:${runId}:round:${roundId}`;
    const body = { schemaVersion: "3" as const, ref, runId, roundId, state, ...(parentManifestRef ? { parentManifestRef } : {}), agentExecution, contexts: structuredClone(contexts) };
    return { ...body, digest: sha256Digest(body) };
  }
  private async contextMcpBindings(
    runId: string,
    roundId: number,
    revisions: Readonly<Record<string, DynamicContextRevision>>,
    resolvedWorld: ResolvedWorldRecord,
    suppliedRegistrations?: readonly RunAgentRegistration[],
    suppliedSpecification?: PluginSpecification,
  ): Promise<readonly ContextMcpConnection[]> {
    const agents = resolvedWorld.population;
    const registrations = suppliedRegistrations ?? await this.repository.listRunAgentRegistrations(runId);
    const byAgentId = new Map(registrations.map((registration) => [registration.agentId, registration]));
    for (const agent of agents) {
      if (!agent.mcpPolicy || !agent.mcpPolicyVersionRef || !agent.mcpPolicyArtifactDigest) {
        throw this.precondition(`Agent '${agent.agentId}' belongs to a legacy Run without a frozen MCP Policy and cannot initialize a new Run`);
      }
      const registration = byAgentId.get(agent.agentId);
      if (!registration || registration.runId !== runId || registration.status !== "active") {
        throw new Error(`Experiment identity invariant: active principal is missing for ${agent.agentId}`);
      }
    }
    const specification = suppliedSpecification ?? (await this.mustRun(runId)).specification;
    const direct: ContextMcpConnection[] = [];
    for (const [contextId, revision] of Object.entries(revisions).sort(([left], [right]) => left.localeCompare(right))) {
      const selection = specification.contexts[contextId];
      if (!selection) throw new Error(`Context '${contextId}' is missing from the Run specification`);
      const participants = this.contextParticipants(contextId, runId, resolvedWorld, registrations, true);
      const result = await this.ports.pluginContexts.execute(selection.installationRef, { operation: "bind", runId, revision, participants, mutation: this.contextMutation(runId, roundId, `bind:${contextId}`, revision.ref) });
      for (const binding of result.bindings ?? []) {
        const participant = participants.find((candidate) => candidate.agentId === binding.agentId);
        if (!participant || binding.contextId !== contextId) throw new Error(`Context '${contextId}' returned an undeclared MCP binding`);
        direct.push({ context: contextId, agentId: binding.agentId, principalId: participant.principalId, endpoint: binding.endpoint, credential: binding.bearerToken });
      }
      for (const participant of participants) if (!direct.some((binding) => binding.context === contextId && binding.agentId === participant.agentId)) throw new Error(`Context MCP invariant: ${contextId} binding is missing for ${participant.agentId}`);
    }
    if (!this.ports.contextGateway) return direct;
    return await Promise.all(direct.map(async (connection) => {
      const agent = agents.find((candidate) => candidate.agentId === connection.agentId)!;
      const issued = await this.ports.contextGateway!.issue({
        runId,
        agentId: connection.agentId,
        contextId: connection.context,
        installationRef: specification.contexts[connection.context]!.installationRef,
        endpoint: connection.endpoint,
        upstreamCredential: connection.credential,
        tools: agent.mcpPolicy.tools.filter((tool) => tool.startsWith(`${connection.context}.`)),
        resources: agent.mcpPolicy.resources.filter((resource) => resource.startsWith(`${connection.context}.`)),
      });
      return { ...connection, endpoint: issued.endpoint, credential: issued.bearerToken };
    }));
  }
  private validateMcpScopeLease(
    context: string,
    lease: ContextMcpScopeLease,
    claim: ClaimedJob,
    principalId: string,
  ): void {
    const expected = {
      runId: claim.attempt.runId,
      roundId: claim.attempt.roundId,
      agentId: claim.job.agentId,
      principalId,
      turnId: claim.job.turnId,
      attemptId: claim.attempt.attemptId,
    };
    if (
      !lease
      || typeof lease.scopeId !== "string"
      || lease.scopeId.length === 0
      || lease.runId !== expected.runId
      || lease.roundId !== expected.roundId
      || lease.agentId !== expected.agentId
      || lease.principalId !== expected.principalId
      || lease.turnId !== expected.turnId
      || lease.attemptId !== expected.attemptId
      || typeof lease.expiresAt !== "string"
      || !Number.isFinite(Date.parse(lease.expiresAt))
      || Date.parse(lease.expiresAt) <= Date.now()
    ) {
      throw new Error(`${context} MCP scope lease does not match the claimed Agent turn`);
    }
  }

  private async closeMcpScopes(run: RunRecord, agentId: string, scopes: ReadonlyMap<string, ContextMcpScopeLease>): Promise<void> {
    const results = await Promise.allSettled([...scopes].map(([contextId, scope]) => {
      const selection = run.specification.contexts[contextId];
      if (!selection) throw new Error(`Context '${contextId}' is missing from the Run specification`);
      return this.ports.pluginContexts.execute(selection.installationRef, { operation: "close_scope", runId: run.status.runId, agentId, scopeId: scope.scopeId });
    }));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  }
  private registrationsFor(runId: string, resolvedWorld: ResolvedWorldRecord): readonly RunAgentRegistration[] {
    const registeredAt = new Date().toISOString();
    return resolvedWorld.population.map((agent) => ({
      principalId: `principal:${runId}:${agent.agentId}`,
      runId,
      agentId: agent.agentId,
      credentialVersion: 1,
      status: "active" as const,
      registeredAt,
    }));
  }
  private runtimeRun(runId: string, specification: PluginSpecification) {
    return { runId, seed: specification.seed, roundCount: specification.roundCount, clock: specification.clock };
  }
  private contextParticipants(contextId: string, runId: string, resolvedWorld: ResolvedWorldRecord, registrations: readonly RunAgentRegistration[] | undefined, includeBearer: false): Array<Omit<ContextParticipant, "bearerToken">>;
  private contextParticipants(contextId: string, runId: string, resolvedWorld: ResolvedWorldRecord, registrations: readonly RunAgentRegistration[] | undefined, includeBearer: true): ContextParticipant[];
  private contextParticipants(contextId: string, runId: string, resolvedWorld: ResolvedWorldRecord, registrations: readonly RunAgentRegistration[] | undefined, includeBearer: boolean): Array<ContextParticipant | Omit<ContextParticipant, "bearerToken">> {
    const byAgentId = new Map((registrations ?? this.registrationsFor(runId, resolvedWorld)).map((registration) => [registration.agentId, registration]));
    const signer = includeBearer ? this.credentialSigner() : undefined;
    return resolvedWorld.population.flatMap((member) => {
      const binding = member.contexts[contextId];
      if (!binding?.enabled) return [];
      const registration = byAgentId.get(member.agentId);
      if (!registration) throw new Error(`Experiment identity invariant: principal is missing for ${member.agentId}`);
      const base = { agentId: member.agentId, principalId: registration.principalId, displayName: member.displayName, profile: { slotId: member.slotId, cohortKey: member.cohortKey, cohortIndex: member.cohortIndex }, accountPolicy: structuredClone(binding.accountPolicy), tools: member.mcpPolicy.tools.filter((tool) => tool.startsWith(`${contextId}.`)), resources: member.mcpPolicy.resources.filter((resource) => resource.startsWith(`${contextId}.`)) };
      return [includeBearer ? { ...base, bearerToken: signer!.issue({ principalId: registration.principalId, runId, agentId: member.agentId, audience: contextId, credentialVersion: registration.credentialVersion }) } : base];
    });
  }
  private async activeRegistration(runId: string, agentId: string): Promise<RunAgentRegistration> {
    const registration = await this.repository.findRunAgentRegistration({ runId, agentId });
    if (!registration || registration.status !== "active") throw this.precondition("run Agent principal is not active");
    return registration;
  }
  private credentialSigner(): ExperimentCredentialSigner {
    if (!this.options.credentialSigner) throw new Error("Experiment MCP credential signer is required");
    return this.options.credentialSigner;
  }
  private deleted(assetKind: string, target: AssetDeleteTarget, assetId: string) { return this.repository.findAssetTombstone({ assetKind, target, assetId }).then(Boolean); }
  private async filterDeletedLibrary<D extends object, V extends object>(assetKind: string, value: { drafts: D[]; versions: V[] }, includeDeleted: boolean) {
    const tombstones = await this.repository.listAssetTombstones(assetKind);
    if (includeDeleted) return { ...value, tombstones };
    const deleted = new Set(tombstones.map((item) => `${item.target}\u0000${item.assetId}`));
    return {
      drafts: value.drafts.filter((item) => !deleted.has(`draft\u0000${assetRecordId(item, "draft")}`)),
      versions: value.versions.filter((item) => !deleted.has(`version\u0000${assetRecordId(item, "version")}`)),
    };
  }
  private async deleteDraft<T extends { revision: number }>(assetKind: string, assetId: string, expectedRevision: number, idempotencyKey: string, load: () => Promise<T | undefined>): Promise<AssetDeletionResult> {
    return this.repository.withRunLock(`asset:${assetKind}:draft:${assetId}`, async () => {
      const existing = await this.repository.findAssetTombstone({ assetKind, target: "draft", assetId });
      if (existing) return { status: "already-deleted", replayed: existing.idempotencyKey === idempotencyKey, tombstone: existing };
      const record = await load();
      if (!record) throw this.notFound(`${assetKind} draft`);
      if (record.revision !== expectedRevision) throw this.precondition(`${assetKind} draft has changed; reload before deleting`);
      const tombstone: AssetTombstone = { assetKind, assetId, target: "draft", deletedAt: new Date().toISOString(), idempotencyKey, expectedRevision };
      await this.repository.saveAssetTombstone(tombstone);
      return { status: "deleted", replayed: false, tombstone };
    });
  }
  private async deleteVersion<T>(assetKind: string, assetId: string, idempotencyKey: string, load: () => Promise<T | undefined>): Promise<AssetDeletionResult> {
    return this.repository.withRunLock(`asset:${assetKind}:version:${assetId}`, async () => {
      const existing = await this.repository.findAssetTombstone({ assetKind, target: "version", assetId });
      if (existing) return { status: "already-deleted", replayed: existing.idempotencyKey === idempotencyKey, tombstone: existing };
      if (!await load()) throw this.notFound(`${assetKind} version`);
      const tombstone: AssetTombstone = { assetKind, assetId, target: "version", deletedAt: new Date().toISOString(), idempotencyKey };
      await this.repository.saveAssetTombstone(tombstone);
      return { status: "deleted", replayed: false, tombstone };
    });
  }
  private async mustRun(runId: string): Promise<RunRecord> { const run = await this.repository.findRun(runId); if (!run) throw this.notFound("run"); return run; }
  private requireInitialization(mutation: MutationHeader) { if (mutation.expectedCheckpointRef) throw this.invalid("mutation.expectedCheckpointRef", "must be empty for initialization"); }
  private requireNonEmptyCheckpoint(mutation: MutationHeader) { if (!mutation.expectedCheckpointRef) throw this.invalid("mutation.expectedCheckpointRef", "is required"); }
  private requireCurrentManifest(mutation: MutationHeader, run: RunRecord) {
    if (!run.status.committedManifestRef) { this.requireInitialization(mutation); return; }
    this.requireNonEmptyCheckpoint(mutation);
    if (mutation.expectedCheckpointRef !== run.status.committedManifestRef) throw this.precondition("expected checkpoint does not match current committed manifest");
  }
  private ensureSameDigest(actual: string, expected: string) { if (actual !== expected) throw this.conflict("same idempotency key was replayed with a different digest"); }
  private invalid(field: string, message: string) { return new OpenLeekDomainError({ code: "INVALID_ARGUMENT", message, violations: [{ field, message }] }); }
  private conflict(message: string) { return new OpenLeekDomainError({ code: "IDEMPOTENCY_CONFLICT", message }); }
  private precondition(message: string) { return new OpenLeekDomainError({ code: "PRECONDITION_FAILED", message }); }
  private notFound(name: string) { return new OpenLeekDomainError({ code: "NOT_FOUND", message: `${name} was not found` }); }
}

/** Independent queue consumer. Its local parallelism affects throughput only. */
export class RoundWorker {
  constructor(
    private readonly repository: ExperimentRepository,
    private readonly service: ExperimentService,
    private readonly options: { workerId: string; leaseMs?: number; commitLeaseMs?: number; releaseLeaseMs?: number; releaseRetryBackoffMs?: number; idleMs?: number } = { workerId: "worker" },
  ) {}

  async runOnce(): Promise<boolean> {
    if (await this.runReleaseOnce()) return true;
    const claim = await this.claimJob();
    if (claim) {
      await this.executeJobClaim(claim);
      await this.commitOnce();
      return true;
    }
    if (await this.commitOnce()) return true;
    return this.advanceOnce();
  }

  private async runReleaseOnce(): Promise<boolean> {
    const releaseLeaseMs = this.options.releaseLeaseMs ?? 30_000;
    const release = await this.repository.claimRunRelease({ workerId: this.options.workerId, leaseMs: releaseLeaseMs, now: new Date() });
    if (release) {
      if (!release.leaseToken) throw new Error("claimed run release has no lease token");
      try {
        await observeWorkerOperation({
          worker: "experiment",
          operation: "release-run",
          runId: release.runId,
        }, () => this.service.releaseRun(release.runId));
        await this.repository.completeRunRelease({ runId: release.runId, leaseToken: release.leaseToken, now: new Date() });
      } catch (error) {
        await this.repository.failRunRelease({
          runId: release.runId,
          leaseToken: release.leaseToken,
          failure: failureFrom(error),
          retryBackoffMs: this.options.releaseRetryBackoffMs ?? 1_000,
          now: new Date(),
        });
      }
      return true;
    }
    return false;
  }

  private claimJob(): Promise<ClaimedJob | undefined> {
    return this.repository.claimNextJob({
      workerId: this.options.workerId,
      leaseMs: this.options.leaseMs ?? 30_000,
      now: new Date(),
    });
  }

  private async executeJobClaim(claim: ClaimedJob): Promise<void> {
    const leaseMs = this.options.leaseMs ?? 30_000;
    const token = claim.job.leaseToken;
    const stopHeartbeat = token
      ? startLeaseHeartbeat(
        () => this.repository.heartbeatJob({ jobId: claim.job.jobId, leaseToken: token, leaseMs, now: new Date() }),
        Math.max(1_000, Math.floor(leaseMs / 3)),
      )
      : undefined;
    try {
      await observeWorkerOperation({
        worker: "experiment",
        operation: "execute-agent",
        runId: claim.attempt.runId,
        roundId: claim.attempt.roundId,
        agentId: claim.job.agentId,
      }, () => this.service.executeClaim(claim));
    } finally {
      await stopHeartbeat?.();
    }
  }

  private async commitOnce(): Promise<boolean> {
    const commitLeaseMs = this.options.commitLeaseMs ?? 30_000;
    const work = await this.repository.claimCommittableAttempt({ workerId: this.options.workerId, leaseMs: commitLeaseMs, now: new Date() });
    if (work) {
      const stopHeartbeat = work.commitLeaseToken ? startLeaseHeartbeat(
        () => this.repository.heartbeatCommit({ attemptId: work.attempt.attemptId, leaseToken: work.commitLeaseToken!, leaseMs: commitLeaseMs, now: new Date() }),
        Math.max(1_000, Math.floor(commitLeaseMs / 3)),
      ) : undefined;
      try {
        await observeWorkerOperation({
          worker: "experiment", operation: "commit-attempt", runId: work.attempt.runId, roundId: work.attempt.roundId,
        }, () => this.service.commitAttempt(work));
      } finally { await stopHeartbeat?.(); }
      return true;
    }
    return false;
  }

  private async advanceOnce(): Promise<boolean> {
    const automatic = await this.repository.findRunReadyForAutomaticAdvance();
    if (automatic) {
      const expectedCheckpointRef = automatic.status.committedManifestRef ?? "";
      const roundId = automatic.status.committedRound + 1;
      const transitionId = `automatic-advance:${automatic.status.runId}:round:${roundId}`;
      try {
        await observeWorkerOperation({
          worker: "experiment",
          operation: "automatic-advance",
          runId: automatic.status.runId,
          roundId,
        }, () => this.service.resumeRun({
          runId: automatic.status.runId,
          mutation: {
            transitionId,
            stepId: "resume",
            expectedCheckpointRef,
            payloadDigest: sha256Digest({ transitionId, expectedCheckpointRef }),
          },
        }));
        return true;
      } catch (error) {
        const failure = roundAdvanceFailureFrom(error);
        const previousAttempts = automatic.status.advanceRetry?.roundId === roundId
          ? automatic.status.advanceRetry.attempts
          : 0;
        const attempts = previousAttempts + 1;
        const maxAttempts = automatic.specification.executionPolicy.automaticRetryMaxAttempts;
        const backoffMs = automatic.specification.executionPolicy.automaticRetryBackoffMs;
        if (attempts >= maxAttempts) {
          const { advanceRetry: _advanceRetry, ...rest } = automatic.status;
          await this.repository.saveRun({
            ...automatic,
            status: { ...rest, lifecycle: "failed", failure },
          });
        } else {
          const { failure: _failure, ...rest } = automatic.status;
          await this.repository.saveRun({
            ...automatic,
            status: {
              ...rest,
              lifecycle: "running",
              advanceRetry: {
                roundId,
                attempts,
                maxAttempts,
                nextRetryAt: new Date(Date.now() + backoffMs).toISOString(),
                recentError: failure,
              },
            },
          });
        }
        console.error(JSON.stringify({
          event: "experiment.round_advance_failed",
          runId: automatic.status.runId,
          roundId,
          attempts,
          maxAttempts,
          category: failure.category,
        }));
        return false;
      }
    }
    return false;
  }

  async runForever(signal: AbortSignal): Promise<void> {
    const active = new Set<Promise<void>>();
    const idleMs = this.options.idleMs ?? 250;
    while (!signal.aborted) {
      let dispatched = false;
      while (!signal.aborted) {
        const claim = await this.claimJob();
        if (!claim) break;
        dispatched = true;
        let task!: Promise<void>;
        task = this.executeJobClaim(claim)
          .then(() => this.commitOnce())
          .then(() => undefined)
          .finally(() => active.delete(task));
        active.add(task);
      }
      if (signal.aborted) break;
      if (dispatched) continue;
      if (await this.runReleaseOnce()) continue;
      if (await this.commitOnce()) continue;
      if (await this.advanceOnce()) continue;
      if (active.size > 0) {
        await Promise.race([
          ...active,
          new Promise<void>((resolve) => setTimeout(resolve, idleMs)),
        ]);
      } else {
        await new Promise<void>((resolve) => setTimeout(resolve, idleMs));
      }
    }
    await Promise.all(active);
  }
}

/** Conditions bind the immutable population, policies and selected Contexts. */
function conditionDigest(specification: PluginSpecification, resolvedWorld: ResolvedWorldRecord): string {
  return sha256Digest({
    population: specification.initialWorld.population,
    resolvedWorld,
    researchTemplate: specification.researchTemplate,
    contexts: specification.contexts,
    turnPrompt: specification.turnPrompt,
  });
}

function triContextResearchTemplate() {
  const definition = { requiredContexts: ["social", "financial", "news"], optionalContexts: [] as string[] };
  return { templateId: "research-template:tri-context", versionRef: "research-template:tri-context:v1", name: "Social + Financial + News", definition, artifactDigest: sha256Digest(definition), publishedAt: "2026-08-05T00:00:00.000Z" };
}

function normalizeGeneratorLimits(value: WorldGeneratorLimits | undefined): WorldGeneratorLimits {
  const limits = value ?? { maxRuntimeMs: 60_000, maxMemoryMb: 1_024 };
  if (!Number.isInteger(limits.maxRuntimeMs) || limits.maxRuntimeMs < 1 || limits.maxRuntimeMs > 60_000) throw new OpenLeekDomainError({ code: "INVALID_ARGUMENT", message: "world generator maxRuntimeMs must be 1..60000", violations: [{ field: "limits.maxRuntimeMs", message: "out of range" }] });
  if (!Number.isInteger(limits.maxMemoryMb) || limits.maxMemoryMb < 64 || limits.maxMemoryMb > 1_024) throw new OpenLeekDomainError({ code: "INVALID_ARGUMENT", message: "world generator maxMemoryMb must be 64..1024", violations: [{ field: "limits.maxMemoryMb", message: "out of range" }] });
  return { ...limits };
}

function normalizeGeneratorDependencies(value: readonly string[]): string[] {
  const allowed = new Set(["numpy", "networkx", "scipy", "pandas", "scikit-learn"]);
  if (value.length > 5 || value.some((dependency) => !allowed.has(dependency))) throw new OpenLeekDomainError({ code: "INVALID_ARGUMENT", message: "unsupported world generator dependency", violations: [{ field: "dependencies", message: "must use the runner allow-list" }] });
  return [...new Set(value)].sort();
}

function mergeGeneratorConfig(version: WorldGeneratorVersion, config: Record<string, unknown>): Record<string, unknown> {
  return { ...structuredClone(version.defaultConfig), ...structuredClone(config) };
}

function assetRecordId(value: object, target: AssetDeleteTarget): string {
  const record = value as Record<string, unknown>;
  if (target === "version" && typeof record.versionRef === "string") return record.versionRef;
  for (const key of ["populationId", "blueprintId", "promptId"]) {
    if (typeof record[key] === "string") return record[key];
  }
  throw new Error("asset record has no stable identity");
}

/** Small, deterministic JSON-Schema subset shared by runner-published plugin configs. */
function validateGeneratorConfig(schema: Record<string, unknown>, config: Record<string, unknown>, field: string): void {
  if (Object.keys(schema).length === 0) return;
  if (schema.type !== undefined && schema.type !== "object") throw new OpenLeekDomainError({ code: "INVALID_ARGUMENT", message: "generator CONFIG_SCHEMA must describe an object", violations: [{ field, message: "top-level type must be object" }] });
  const properties = schema.properties;
  if (properties !== undefined && (properties === null || typeof properties !== "object" || Array.isArray(properties))) throw new OpenLeekDomainError({ code: "INVALID_ARGUMENT", message: "generator CONFIG_SCHEMA properties are invalid", violations: [{ field, message: "properties must be an object" }] });
  const required = Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : [];
  for (const key of required) if (!(key in config)) throw new OpenLeekDomainError({ code: "INVALID_ARGUMENT", message: "generator config is missing a required value", violations: [{ field: `${field}.${key}`, message: "is required" }] });
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return;
  for (const [key, value] of Object.entries(config)) {
    const property = (properties as Record<string, unknown>)[key];
    if (!property || typeof property !== "object" || Array.isArray(property)) continue;
    const descriptor = property as Record<string, unknown>;
    const type = descriptor.type;
    const valid = type === undefined || type === "string" && typeof value === "string" || type === "boolean" && typeof value === "boolean" || type === "number" && typeof value === "number" && Number.isFinite(value) || type === "integer" && typeof value === "number" && Number.isSafeInteger(value) || type === "object" && value !== null && typeof value === "object" && !Array.isArray(value) || type === "array" && Array.isArray(value);
    if (!valid) throw new OpenLeekDomainError({ code: "INVALID_ARGUMENT", message: "generator config has an invalid value", violations: [{ field: `${field}.${key}`, message: `must match ${String(type)}` }] });
    if (Array.isArray(descriptor.enum) && !descriptor.enum.some((candidate) => Object.is(candidate, value))) throw new OpenLeekDomainError({ code: "INVALID_ARGUMENT", message: "generator config has an invalid enum value", violations: [{ field: `${field}.${key}`, message: "must be one of the published enum values" }] });
  }
}

function simulationUtcDate(specification: PluginSpecification, roundId: number): string {
  const instant = specification.clock.startUnixSeconds + (roundId - 1) * specification.clock.stepSeconds;
  return new Date(instant * 1_000).toISOString().slice(0, 10);
}

function failureFrom(error: unknown): JobFailure {
  const message = error instanceof Error ? error.message : String(error);
  const data = error instanceof OpenLeekDomainError && "data" in error ? error.data : undefined;
  const code = data && typeof data === "object" && "code" in data ? (data as { code?: unknown }).code : "provider_error";
  return { category: String(code).toLowerCase(), message, occurredAt: new Date().toISOString() };
}

function roundAdvanceFailureFrom(error: unknown): JobFailure {
  const base = failureFrom(error);
  const category = base.message.includes("total size of jsonb object elements")
    ? "round_advance_context_persistence"
    : `round_advance_${base.category.replace(/[^a-z0-9_]+/g, "_").slice(0, 90) || "unknown"}`;
  return { ...base, category };
}

function algorithmExecutionFailureCategory(error: unknown): "feed_algorithm_execution" | "market_maker_execution" | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("market maker execution failed")) return "market_maker_execution";
  if (message.includes("feed algorithm execution failed")) return "feed_algorithm_execution";
  return undefined;
}

function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
