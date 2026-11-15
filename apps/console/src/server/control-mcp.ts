import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { pluginSpecificationSchema, pluginManifestSchema, runLifecycleSchema } from "@openleek/contracts/experiment";
import { emitObservabilityLog, SeverityNumber } from "@openleek/observability";
import type { ConsolePorts } from "./ports";
import { auditRuntimeEvidence, header } from "./router";
import { llmConfigurationCapability, sanitizeLlmConfigurationForBrowser } from "./llm-configuration-projection";
import { observerRunHead, observerRunRounds } from "./observer-runs";

const identifier = z.string().min(1).max(500);
const page = { cursor: z.string().optional(), limit: z.number().int().positive().max(200).optional() };
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const destructive = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const;

type AssetDefinition = {
  slug: string;
  kind: string;
  idKey: string;
  list: keyof ConsolePorts;
  draft: keyof ConsolePorts;
  version: keyof ConsolePorts;
  save: keyof ConsolePorts;
  publish: keyof ConsolePorts;
  deleteDraft: keyof ConsolePorts;
  deleteVersion: keyof ConsolePorts;
};

const assets: readonly AssetDefinition[] = [
  { slug: "agents_md", kind: "agents-md", idKey: "templateId", list: "agentsMd", draft: "agentsMdDraft", version: "agentsMdVersion", save: "saveAgentsMdDraft", publish: "publishAgentsMd", deleteDraft: "deleteAgentsMdDraft", deleteVersion: "deleteAgentsMdVersion" },
  { slug: "turn_prompt", kind: "turn-prompt", idKey: "promptId", list: "turnPrompts", draft: "turnPromptDraft", version: "turnPromptVersion", save: "saveTurnPromptDraft", publish: "publishTurnPrompt", deleteDraft: "deleteTurnPromptDraft", deleteVersion: "deleteTurnPromptVersion" },
  { slug: "mcp_policy", kind: "mcp-policy", idKey: "policyId", list: "mcpPolicies", draft: "mcpPolicyDraft", version: "mcpPolicyVersion", save: "saveMcpPolicyDraft", publish: "publishMcpPolicy", deleteDraft: "deleteMcpPolicyDraft", deleteVersion: "deleteMcpPolicyVersion" },
  { slug: "skill", kind: "skill", idKey: "skillId", list: "skills", draft: "skillDraft", version: "skillVersion", save: "saveSkillDraft", publish: "publishSkill", deleteDraft: "deleteSkillDraft", deleteVersion: "deleteSkillVersion" },
  { slug: "population", kind: "population", idKey: "populationId", list: "populations", draft: "populationDraft", version: "populationVersion", save: "savePopulationDraft", publish: "publishPopulation", deleteDraft: "deletePopulationDraft", deleteVersion: "deletePopulationVersion" },
  { slug: "agent_blueprint", kind: "agent-blueprint", idKey: "blueprintId", list: "agentBlueprints", draft: "agentBlueprintDraft", version: "agentBlueprintVersion", save: "saveAgentBlueprintDraft", publish: "publishAgentBlueprint", deleteDraft: "deleteAgentBlueprintDraft", deleteVersion: "deleteAgentBlueprintVersion" },
  { slug: "social_network", kind: "social-network", idKey: "networkId", list: "socialNetworks", draft: "socialNetworkDraft", version: "socialNetworkVersion", save: "saveSocialNetworkDraft", publish: "publishSocialNetwork", deleteDraft: "deleteSocialNetworkDraft", deleteVersion: "deleteSocialNetworkVersion" },
  { slug: "financial_preset", kind: "financial-preset", idKey: "presetId", list: "financialInitialStatePresets", draft: "financialInitialStatePresetDraft", version: "financialInitialStatePresetVersion", save: "saveFinancialInitialStatePresetDraft", publish: "publishFinancialInitialStatePreset", deleteDraft: "deleteFinancialInitialStatePresetDraft", deleteVersion: "deleteFinancialInitialStatePresetVersion" },
  { slug: "feed_algorithm", kind: "feed-algorithm", idKey: "algorithmId", list: "feedAlgorithms", draft: "feedAlgorithmDraft", version: "feedAlgorithmVersion", save: "saveFeedAlgorithmDraft", publish: "publishFeedAlgorithm", deleteDraft: "deleteFeedAlgorithmDraft", deleteVersion: "deleteFeedAlgorithmVersion" },
  { slug: "market_maker", kind: "market-maker", idKey: "algorithmId", list: "marketMakers", draft: "marketMakerDraft", version: "marketMakerVersion", save: "saveMarketMakerDraft", publish: "publishMarketMaker", deleteDraft: "deleteMarketMakerDraft", deleteVersion: "deleteMarketMakerVersion" },
] as const;

export function createControlMcpServer(ports: ConsolePorts): McpServer {
  const server = new McpServer(
    { name: "openleek-console-control", version: "0.1.0" },
    { instructions: "Tools read and manage OpenLeek owner state. Mutations persist through the authoritative owner named by each tool." },
  );

  server.registerTool("read_data_dictionary", {
    description: "Returns the browser-safe schema catalog published by OpenLeek owners.",
    annotations: readOnly,
  }, () => audited("read_data_dictionary", undefined, undefined, async () => result(await required(ports.dataDictionaryCatalog, "data dictionary")())));

  server.registerTool("read_context_catalog", {
    description: "Returns Context capabilities, asset collections, and configuration schemas.",
    annotations: readOnly,
  }, () => audited("read_context_catalog", undefined, undefined, async () => result(await ports.contextCatalog())));

  server.registerTool("read_context_installations", {
    description: "Returns public Context installation metadata and lifecycle state. Bootstrap bundles and bearer credentials are never exposed.",
    annotations: readOnly,
  }, () => audited("read_context_installations", "context-installation", undefined, async () => result(await required(ports.listContextInstallations, "Context installations")())));

  server.registerTool("transition_context_installation", {
    description: "Verifies and activates, drains, or disables an existing Context installation. Creation and provisioning stay in Console because their one-time bootstrap bundles must never enter MCP output.",
    inputSchema: { installationRef: identifier, action: z.enum(["activate", "drain", "disable"]) },
    annotations: write,
  }, (input) => audited("transition_context_installation", "context-installation", input.installationRef, async () => result(await required(ports.contextInstallationAction, "Context installation transition")(input))));

  server.registerTool("read_context_assets", {
    description: "Lists a Context asset collection or returns one draft or immutable version. Deleted records are included only when requested.",
    inputSchema: {
      contextId: identifier,
      collectionId: identifier,
      operation: z.enum(["list", "draft", "version"]),
      id: identifier.optional(),
      includeDeleted: z.boolean().optional(),
    },
    annotations: readOnly,
  }, (input) => audited("read_context_assets", "context-asset", input.id, async () => result(await ports.contextAssetRead(input))));

  server.registerTool("read_asset_library", {
    description: "Lists or reads a first-class asset library. Deleted records are included only when requested.",
    inputSchema: {
      kind: z.enum(assets.map((asset) => asset.kind) as [string, ...string[]]),
      operation: z.enum(["list", "draft", "version"]),
      id: identifier.optional(),
      includeDeleted: z.boolean().optional(),
    },
    annotations: readOnly,
  }, (input) => audited("read_asset_library", input.kind, input.id, async () => result(await readAsset(ports, input))));

  server.registerTool("read_runs", {
    description: "Returns Experiment Runs, optionally filtered by lifecycle.",
    inputSchema: { ...page, lifecycle: runLifecycleSchema.optional() },
    annotations: readOnly,
  }, (input) => audited("read_runs", "run", undefined, async () => result(await ports.listRuns(input))));

  server.registerTool("read_run", {
    description: "Returns Run status, progress, manifest, token usage, permanent Agent transcripts, runtime evidence, or committed facts.",
    inputSchema: {
      runId: identifier,
      view: z.enum(["summary", "progress", "rounds", "manifest", "usage", "transcript", "evidence", "facts"]),
      manifestRef: identifier.optional(),
      agentId: identifier.optional(),
      roundId: z.number().int().nonnegative().optional(),
      attemptId: identifier.optional(),
      turnId: identifier.optional(),
      ...page,
    },
    annotations: readOnly,
  }, (input) => audited("read_run", "run", input.runId, async () => result(await readRun(ports, input))));

  server.registerTool("get_run_hook_policy", {
    description: "Returns the current Run-level Codex automatic Strategy injection policy.",
    inputSchema: { runId: identifier },
    annotations: readOnly,
  }, (input) => audited("get_run_hook_policy", "run", input.runId, async () => result(
    await ports.agentHookPolicy({ runId: input.runId }),
  ), undefined, input.runId));

  server.registerTool("update_run_hook_policy", {
    description: "Updates the Run-level Codex automatic Strategy injection policy. The change applies from the next Turn.",
    inputSchema: {
      runId: identifier,
      strategyInjectionEnabled: z.boolean(),
      expectedRevision: z.number().int().positive(),
      idempotencyKey: identifier,
    },
    annotations: write,
  }, (input) => audited("update_run_hook_policy", "run", input.runId, async () => result(
    await ports.updateAgentHookPolicy(input),
  ), input.idempotencyKey, input.runId));

  server.registerTool("read_run_observer", {
    description: "Returns the current committed Run head or a numerically ordered page of committed rounds for observer clients.",
    inputSchema: {
      runId: identifier,
      view: z.enum(["head", "rounds"]),
      cursor: z.string().optional(),
      limit: z.number().int().positive().max(200).optional(),
    },
    annotations: readOnly,
  }, (input) => audited("read_run_observer", "run", input.runId, async () => result(
    input.view === "head"
      ? await observerRunHead(input.runId, ports)
      : await observerRunRounds(input.runId, { ...(input.cursor ? { cursor: input.cursor } : {}), limit: input.limit ?? 50 }, ports),
  ), undefined, input.runId));

  server.registerTool("read_context_revision", {
    description: "Returns the immutable committed revision reference for any Context in a Run manifest.",
    inputSchema: { runId: identifier, manifestRef: identifier.optional(), contextId: identifier },
    annotations: readOnly,
  }, (input) => audited("read_context_revision", "run", input.runId, async () => {
    const manifest = await observerManifest(ports, input.runId, input.manifestRef);
    const revision = manifest.contexts[input.contextId];
    if (!revision) throw new Error(`Context '${input.contextId}' is not present in the committed manifest`);
    return result(revision);
  }, undefined, input.runId));

  server.registerTool("read_llm_config", {
    description: "Returns the redacted shared LLM graph or its current route capability.",
    inputSchema: { view: z.enum(["graph", "capability"]) },
    annotations: readOnly,
  }, (input) => audited("read_llm_config", "llm-configuration", input.view, async () => {
    const graph = await ports.llmConfigGraph();
    return result(input.view === "capability" ? llmConfigurationCapability(graph) : sanitizeLlmConfigurationForBrowser(graph));
  }));

  server.registerTool("validate_candidate", {
    description: "Validates an experiment specification, Context asset, first-class asset, or LLM configuration patch without persisting it.",
    inputSchema: {
      kind: z.enum(["experiment-spec", "context-asset", "turn-prompt", "skill", "social-network", "feed-algorithm", "market-maker", "llm-config-patch"]),
      candidate: z.unknown(),
    },
    annotations: readOnly,
  }, (input) => audited("validate_candidate", input.kind, undefined, async () => result(await validateCandidate(ports, input.kind, input.candidate))));

  server.registerTool("preview_candidate", {
    description: "Runs an owner preview for a Context asset, Turn Prompt, Feed Algorithm, or Market Maker without publishing it.",
    inputSchema: { kind: z.enum(["context-asset", "turn-prompt", "feed-algorithm", "market-maker"]), input: z.unknown() },
    annotations: readOnly,
  }, (input) => audited("preview_candidate", input.kind, undefined, async () => result(await previewCandidate(ports, input.kind, input.input))));

  server.registerTool("create_run", {
    description: "Creates a Run from a complete specification and binds the current Hindsight memory route and revision.",
    inputSchema: { specification: z.unknown(), idempotencyKey: identifier },
    annotations: write,
  }, (input) => audited("create_run", "run", undefined, async () => {
    const capability = llmConfigurationCapability(await ports.llmConfigGraph());
    const original = asRecord(input.specification);
    const specification = pluginSpecificationSchema.parse({
      ...original,
      agentExecution: {
        ...asRecord(original.agentExecution),
        memoryProfile: { routeId: capability.memoryRoute, llmConfigRevision: capability.revision },
      },
    });
    return result(await ports.createRun({ specification, mutation: header(input.idempotencyKey, "create", "", specification) }));
  }, input.idempotencyKey));

  server.registerTool("read_execution_providers", {
    description: "Returns Agent Execution providers, authorized ChatGPT account status, available account models, reasoning levels, and rate limits. Credentials are never returned.",
    annotations: readOnly,
  }, () => audited("read_execution_providers", "execution-provider", undefined, async () => {
    const catalog = asRecord(await required(ports.agentExecutionProviders, "execution providers")({}));
    return result({ ...catalog, rateLimits: await required(ports.chatGptRateLimits, "ChatGPT rate limits")({}).catch(() => null) });
  }));

  server.registerTool("start_chatgpt_device_authorization", {
    description: "Starts global ChatGPT device-code authorization and returns the verification URL and user code. A pending authorization is not duplicated.",
    annotations: write,
  }, () => audited("start_chatgpt_device_authorization", "execution-provider", "openai", async () => result(await required(ports.startChatGptDeviceAuthorization, "ChatGPT authorization")({}))));

  server.registerTool("cancel_chatgpt_device_authorization", {
    description: "Cancels the currently pending global ChatGPT device-code authorization, if any.",
    annotations: destructive,
  }, () => audited("cancel_chatgpt_device_authorization", "execution-provider", "openai", async () => result(await required(ports.cancelChatGptDeviceAuthorization, "ChatGPT authorization")({}))));

  server.registerTool("logout_chatgpt_account", {
    description: "Logs out the global ChatGPT account. Existing OpenAI Runs will require a newly authorized global account before their next Turn.",
    annotations: destructive,
  }, () => audited("logout_chatgpt_account", "execution-provider", "openai", async () => result(await required(ports.logoutChatGpt, "ChatGPT authorization")({}))));

  for (const operation of ["resume", "retry", "cancel"] as const) {
    server.registerTool(`${operation}_run`, {
      description: `${operation[0]!.toUpperCase()}${operation.slice(1)}s a Run through the Experiment owner using the expected manifest reference.`,
      inputSchema: { runId: identifier, expectedManifestRef: z.string(), idempotencyKey: identifier },
      annotations: operation === "cancel" ? destructive : write,
    }, (input) => audited(`${operation}_run`, "run", input.runId, async () => result(await ports.command(operation, {
      runId: input.runId,
      mutation: header(input.idempotencyKey, operation, input.expectedManifestRef, { runId: input.runId, expectedManifestRef: input.expectedManifestRef }),
    })), input.idempotencyKey, input.runId));
  }

  server.registerTool("fork_run", {
    description: "Creates a Run from a committed source manifest and optional supported rebindings.",
    inputSchema: {
      sourceRunId: identifier,
      sourceManifestRef: identifier,
      idempotencyKey: identifier,
      agentsMdByAgentId: z.record(z.string(), identifier).optional(),
      contextConfigurations: z.record(identifier, z.record(z.string(), z.unknown())).optional(),
      turnPrompt: z.unknown().optional(),
    },
    annotations: write,
  }, (input) => audited("fork_run", "run", input.sourceRunId, async () => {
    const { idempotencyKey, ...forkInput } = input;
    return result(await ports.fork({
      ...forkInput,
      mutation: header(idempotencyKey, "fork", input.sourceManifestRef, forkInput),
    }));
  }, input.idempotencyKey, input.sourceRunId));

  registerAssetTools(server, ports);
  registerContextAssetTools(server, ports);
  registerLlmConfigurationTools(server, ports);
  return server;
}

function registerAssetTools(server: McpServer, ports: ConsolePorts) {
  for (const asset of assets) {
    server.registerTool(`save_${asset.slug}_draft`, {
      description: `Validates and persists a ${asset.kind} draft through its owner. Existing drafts require the owner's expected revision field.`,
      inputSchema: { candidate: z.record(z.string(), z.unknown()) },
      annotations: write,
    }, (input) => audited(`save_${asset.slug}_draft`, asset.kind, stringValue(input.candidate[asset.idKey]), async () => result(await method(ports, asset.save)(input.candidate))));

    server.registerTool(`publish_${asset.slug}`, {
      description: `Publishes an immutable ${asset.kind} version from the selected draft and expected revision.`,
      inputSchema: { assetId: identifier, expectedRevision: z.number().int().positive() },
      annotations: write,
    }, (input) => audited(`publish_${asset.slug}`, asset.kind, input.assetId, async () => result(await method(ports, asset.publish)({ [asset.idKey]: input.assetId, expectedRevision: input.expectedRevision }))));

    server.registerTool(`delete_${asset.slug}_draft`, {
      description: `Creates an irreversible draft tombstone. The retained draft is hidden from default reads and its ID cannot be reused.`,
      inputSchema: { assetId: identifier, expectedRevision: z.number().int().positive(), idempotencyKey: identifier },
      annotations: destructive,
    }, (input) => audited(`delete_${asset.slug}_draft`, asset.kind, input.assetId, async () => result(await method(ports, asset.deleteDraft)({ [asset.idKey]: input.assetId, expectedRevision: input.expectedRevision, idempotencyKey: input.idempotencyKey })), input.idempotencyKey));

    server.registerTool(`delete_${asset.slug}_version`, {
      description: `Creates an irreversible version tombstone. Default selection reads hide the version while includeDeleted audit reads retain it.`,
      inputSchema: { versionRef: identifier, idempotencyKey: identifier },
      annotations: destructive,
    }, (input) => audited(`delete_${asset.slug}_version`, asset.kind, input.versionRef, async () => result(await method(ports, asset.deleteVersion)(input)), input.idempotencyKey));
  }
}

function registerContextAssetTools(server: McpServer, ports: ConsolePorts) {
  server.registerTool("save_context_asset", {
    description: "Validates and persists a draft in a dynamic Context asset collection.",
    inputSchema: { contextId: identifier, collectionId: identifier, candidate: z.record(z.string(), z.unknown()) },
    annotations: write,
  }, (input) => audited("save_context_asset", "context-asset", input.collectionId, async () => result(await ports.contextAssetCommand({ contextId: input.contextId, collectionId: input.collectionId, operation: "save", input: input.candidate }))));
  server.registerTool("publish_context_asset", {
    description: "Publishes a version from a dynamic Context asset draft.",
    inputSchema: { contextId: identifier, collectionId: identifier, candidate: z.record(z.string(), z.unknown()) },
    annotations: write,
  }, (input) => audited("publish_context_asset", "context-asset", input.collectionId, async () => result(await ports.contextAssetCommand({ contextId: input.contextId, collectionId: input.collectionId, operation: "publish", input: input.candidate }))));
  for (const target of ["draft", "version"] as const) {
    server.registerTool(`delete_context_asset_${target}`, {
      description: `Creates an irreversible ${target} tombstone through the dynamic Context asset owner.`,
      inputSchema: {
        contextId: identifier,
        collectionId: identifier,
        assetId: identifier,
        expectedRevision: target === "draft" ? z.number().int().positive() : z.number().int().positive().optional(),
        idempotencyKey: identifier,
      },
      annotations: destructive,
    }, (input) => audited(`delete_context_asset_${target}`, "context-asset", input.assetId, async () => result(await ports.contextAssetCommand({
      contextId: input.contextId,
      collectionId: input.collectionId,
      operation: "delete",
      input: { target, ...(target === "draft" ? { expectedRevision: input.expectedRevision } : {}), [target === "draft" ? contextAssetIdKey(input.collectionId) : "versionRef"]: input.assetId, idempotencyKey: input.idempotencyKey },
    })), input.idempotencyKey));
  }
}

function registerLlmConfigurationTools(server: McpServer, ports: ConsolePorts) {
  server.registerTool("patch_llm_config", {
    description: "Validates and persists a shared LLM configuration patch against its base revision; the response is redacted.",
    inputSchema: { patch: z.record(z.string(), z.unknown()) },
    annotations: write,
  }, (input) => audited("patch_llm_config", "llm-configuration", undefined, async () => result(sanitizeLlmConfigurationForBrowser(await ports.llmConfigPatch(input.patch)))));
  server.registerTool("create_llm_resource", {
    description: "Creates a provider, model, offer, or route through the LLM Configuration owner; the response is redacted.",
    inputSchema: { kind: identifier, candidate: z.record(z.string(), z.unknown()) },
    annotations: write,
  }, (input) => audited("create_llm_resource", "llm-configuration", input.kind, async () => result(sanitizeLlmConfigurationForBrowser(await ports.llmConfigCreateResource(input.kind, input.candidate)))));
  server.registerTool("delete_llm_resource", {
    description: "Physically deletes one shared LLM resource using its base revision; the response is redacted.",
    inputSchema: { kind: identifier, id: identifier, baseRevision: identifier },
    annotations: destructive,
  }, (input) => audited("delete_llm_resource", "llm-configuration", input.id, async () => result(sanitizeLlmConfigurationForBrowser(await ports.llmConfigDeleteResource(input.kind, input.id, input.baseRevision)))));
}

async function readAsset(ports: ConsolePorts, input: { kind: string; operation: "list" | "draft" | "version"; id?: string | undefined; includeDeleted?: boolean | undefined }) {
  const asset = assets.find((item) => item.kind === input.kind);
  if (!asset) throw new Error(`unsupported asset kind ${input.kind}`);
  if (input.operation === "list") return method(ports, asset.list)({ includeDeleted: input.includeDeleted });
  if (!input.id) throw new Error(`id is required for ${input.operation}`);
  return method(ports, input.operation === "draft" ? asset.draft : asset.version)({
    [input.operation === "draft" ? asset.idKey : "versionRef"]: input.id,
    includeDeleted: input.includeDeleted,
  });
}

async function readRun(ports: ConsolePorts, input: { runId: string; view: string; manifestRef?: string | undefined; agentId?: string | undefined; roundId?: number | undefined; attemptId?: string | undefined; turnId?: string | undefined; cursor?: string | undefined; limit?: number | undefined }) {
  const paging = { ...(input.cursor ? { cursor: input.cursor } : {}), ...(input.limit ? { limit: input.limit } : {}) };
  if (input.view === "summary") return ports.getRun({ runId: input.runId });
  if (input.view === "progress") return ports.roundProgress({ runId: input.runId });
  if (input.view === "rounds") return ports.committedRounds({ runId: input.runId, ...paging });
  if (input.view === "manifest") return ports.committedManifest({ runId: input.runId, ...(input.manifestRef ? { manifestRef: input.manifestRef } : {}) });
  if (input.view === "usage") return ports.agentTokenUsage({ runId: input.runId });
  if (input.view === "transcript") {
    if (!ports.agentTranscripts) throw new Error("Agent transcript port is unavailable");
    return ports.agentTranscripts({ runId: input.runId, ...paging, ...(input.agentId ? { agentId: input.agentId } : {}), ...(input.roundId === undefined ? {} : { roundId: input.roundId }), ...(input.attemptId ? { attemptId: input.attemptId } : {}), ...(input.turnId ? { turnId: input.turnId } : {}) });
  }
  if (input.view === "evidence") return auditRuntimeEvidence(await ports.agentRuntimeEvidence({ runId: input.runId }));
  const manifest = pluginManifestSchema.parse(await ports.committedManifest({ runId: input.runId, ...(input.manifestRef ? { manifestRef: input.manifestRef } : {}) }));
  const agentExecution = await ports.committedFacts("agentExecution", { runId: input.runId, ...paging });
  return { manifest, agentExecution, contexts: manifest.contexts };
}

async function observerManifest(ports: ConsolePorts, runId: string, manifestRef?: string) {
  return pluginManifestSchema.parse(await ports.committedManifest({
    runId,
    ...(manifestRef === undefined ? {} : { manifestRef }),
  }));
}

async function validateCandidate(ports: ConsolePorts, kind: string, candidate: unknown) {
  if (kind === "experiment-spec") return ports.validateSpecification({ specification: candidate });
  if (kind === "llm-config-patch") return sanitizeLlmConfigurationForBrowser(await ports.llmConfigValidate(candidate));
  if (kind === "context-asset") return ports.contextAssetCommand({ ...asRecord(candidate), operation: "validate" });
  if (kind === "turn-prompt") return required(ports.validateTurnPrompt, "Turn Prompt validation")(candidate);
  if (kind === "skill") return required(ports.validateSkill, "Skill validation")(candidate);
  if (kind === "social-network") return required(ports.validateSocialNetwork, "Social Network validation")(candidate);
  if (kind === "feed-algorithm") return required(ports.validateFeedAlgorithm, "Feed Algorithm validation")(candidate);
  return required(ports.validateMarketMaker, "Market Maker validation")(candidate);
}

async function previewCandidate(ports: ConsolePorts, kind: string, input: unknown) {
  if (kind === "context-asset") return ports.contextAssetCommand({ ...asRecord(input), operation: "preview" });
  if (kind === "turn-prompt") return required(ports.previewTurnPrompt, "Turn Prompt preview")(input);
  if (kind === "feed-algorithm") return required(ports.previewFeedAlgorithm, "Feed Algorithm preview")(input);
  return required(ports.previewMarketMaker, "Market Maker preview")(input);
}

async function audited<T>(
  tool: string,
  targetType: string | undefined,
  targetId: string | undefined,
  operation: () => Promise<T>,
  idempotencyKey?: string,
  runId?: string,
): Promise<T> {
  const started = performance.now();
  try {
    const value = await operation();
    emitObservabilityLog("control_mcp.tool", {
      "openleek.tool": tool,
      "openleek.target_type": targetType,
      "openleek.target_id": targetId,
      "openleek.idempotency_key": idempotencyKey,
      "openleek.run_id": runId,
      "openleek.duration_ms": Math.round(performance.now() - started),
      outcome: "ok",
    });
    return value;
  } catch (error) {
    emitObservabilityLog("control_mcp.tool", {
      "openleek.tool": tool,
      "openleek.target_type": targetType,
      "openleek.target_id": targetId,
      "openleek.idempotency_key": idempotencyKey,
      "openleek.run_id": runId,
      "openleek.duration_ms": Math.round(performance.now() - started),
      "openleek.error_category": error instanceof Error ? error.name : "unknown",
      outcome: "error",
    }, SeverityNumber.ERROR);
    throw error;
  }
}

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) ?? "null" }],
    structuredContent: isRecord(value) ? value : { value: value ?? null },
  };
}

function method(ports: ConsolePorts, name: keyof ConsolePorts): (input: unknown) => Promise<unknown> {
  const value = ports[name];
  if (typeof value !== "function") throw new Error(`${String(name)} owner port is unavailable`);
  return value.bind(ports) as (input: unknown) => Promise<unknown>;
}

function required<T extends (...args: never[]) => unknown>(value: T | undefined, label: string): T {
  if (!value) throw new Error(`${label} owner port is unavailable`);
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function stringValue(value: unknown) { return typeof value === "string" ? value : undefined; }
function contextAssetIdKey(collectionId: string) {
  if (collectionId === "social-networks") return "networkId";
  if (collectionId === "financial-presets") return "presetId";
  return "algorithmId";
}
