import { createContextClient } from "@openleek/trpc";
import type { AnyRouter } from "@trpc/server";
import { llmConfigurationDataDictionary } from "./llm-configuration-projection";

type RpcProcedure = { query(input: unknown): Promise<unknown>; mutate(input: unknown): Promise<unknown> };
type ContextClient = {
  experiment: Record<"validateSpecification" | "create" | "list" | "get" | "roundProgress" | "cancel" | "retry" | "resume" | "fork" | "committedRounds" | "committedManifest" | "agentRegistrations", RpcProcedure> & { dataDictionary: { catalog: RpcProcedure }; contexts: Record<"catalog" | "assetRead" | "assetCommand", RpcProcedure>; populations: Record<"list" | "draft" | "version" | "saveDraft" | "publish" | "deleteDraft" | "deleteVersion", RpcProcedure>; agentBlueprints: Record<"list" | "draft" | "version" | "saveDraft" | "publish" | "deleteDraft" | "deleteVersion", RpcProcedure>; turnPrompts: Record<"list" | "draft" | "version" | "saveDraft" | "validate" | "preview" | "publish" | "deleteDraft" | "deleteVersion", RpcProcedure> };
  agentExecution: Record<"queryCommittedFacts" | "runtimeEvidence" | "runtimeCapability" | "executionProviders" | "tokenUsage" | "transcripts", RpcProcedure> & { dataDictionary: { catalog: RpcProcedure }; chatGptAuth: Record<"status" | "rateLimits" | "startDeviceAuthorization" | "cancelDeviceAuthorization" | "logout", RpcProcedure>; hookPolicy: Record<"get" | "update", RpcProcedure>; agentsMd: Record<"list" | "draft" | "version" | "saveDraft" | "publish" | "deleteDraft" | "deleteVersion", RpcProcedure>; mcpPolicies: Record<"list" | "draft" | "version" | "saveDraft" | "publish" | "deleteDraft" | "deleteVersion", RpcProcedure>; skills: Record<"list" | "draft" | "version" | "saveDraft" | "validate" | "publish" | "deleteDraft" | "deleteVersion", RpcProcedure> };
  socialEnvironment: Record<"observer" | "queryCommittedRevisionFacts" | "socialNetworks" | "socialNetworkDraft" | "socialNetworkVersion" | "saveSocialNetworkDraft" | "validateSocialNetwork" | "publishSocialNetwork" | "deleteSocialNetworkDraft" | "deleteSocialNetworkVersion" | "feedAlgorithms" | "feedAlgorithmDraft" | "feedAlgorithmVersion" | "saveFeedAlgorithmDraft" | "validateFeedAlgorithm" | "publishFeedAlgorithm" | "deleteFeedAlgorithmDraft" | "deleteFeedAlgorithmVersion" | "previewFeedAlgorithm", RpcProcedure> & { dataDictionary: { catalog: RpcProcedure } };
  financialMarket: Record<"observer" | "queryCommittedRevisionFacts" | "financialInitialStatePresets" | "financialInitialStatePresetDraft" | "financialInitialStatePresetVersion" | "saveFinancialInitialStatePresetDraft" | "publishFinancialInitialStatePreset" | "deleteFinancialInitialStatePresetDraft" | "deleteFinancialInitialStatePresetVersion" | "marketMakers" | "marketMakerDraft" | "marketMakerVersion" | "saveMarketMakerDraft" | "validateMarketMaker" | "publishMarketMaker" | "deleteMarketMakerDraft" | "deleteMarketMakerVersion" | "previewMarketMaker", RpcProcedure> & { dataDictionary: { catalog: RpcProcedure } };
};
const rpc = (url: string) => createContextClient<AnyRouter>(url) as unknown as ContextClient;

/**
 * LLM Configuration exposes its graph over HTTP rather than tRPC. It is
 * deliberately kept behind this server-side port so the browser never learns
 * a management bearer token.
 */
export type ConfigurationHttpMethod = "GET" | "POST" | "PATCH" | "DELETE";
export type ConfigurationRequest = {
  method: ConfigurationHttpMethod;
  path: string;
  body?: unknown;
  /** Config graph validation and revision conflicts are normal product states. */
  acceptStatuses?: number[];
};

export interface ConsolePorts {
  dataDictionaryCatalog?(): Promise<unknown>;
  contextCatalog(): Promise<unknown>;
  contextAssetRead(input: unknown): Promise<unknown>;
  contextAssetCommand(input: unknown): Promise<unknown>;
  listContextInstallations?(): Promise<unknown>;
  contextInstallationAction?(input: { installationRef: string; action: "activate" | "drain" | "disable" }): Promise<unknown>;
  listRuns(input: unknown): Promise<unknown>;
  validateSpecification(input: unknown): Promise<unknown>;
  createRun(input: unknown): Promise<unknown>;
  command(name: "cancel" | "retry" | "resume", input: unknown): Promise<unknown>;
  fork(input: unknown): Promise<unknown>;
  getRun(input: unknown): Promise<unknown>;
  roundProgress(input: unknown): Promise<unknown>;
  committedRounds(input: unknown): Promise<unknown>;
  committedManifest(input: unknown): Promise<unknown>;
  agentRegistrations(input: unknown): Promise<unknown>;
  committedFacts(name: "agentExecution" | "socialEnvironment" | "financialMarket", input: unknown): Promise<unknown>;
  financialObserver(input: unknown): Promise<unknown>;
  socialObserver(input: unknown): Promise<unknown>;
  agentRuntimeEvidence(input: unknown): Promise<unknown>;
  agentRuntimeCapability(input: unknown): Promise<unknown>;
  agentExecutionProviders?(input: unknown): Promise<unknown>;
  chatGptAuthStatus?(input: unknown): Promise<unknown>;
  chatGptRateLimits?(input: unknown): Promise<unknown>;
  startChatGptDeviceAuthorization?(input: unknown): Promise<unknown>;
  cancelChatGptDeviceAuthorization?(input: unknown): Promise<unknown>;
  logoutChatGpt?(input: unknown): Promise<unknown>;
  agentTokenUsage(input: unknown): Promise<unknown>;
  agentTranscripts?(input: unknown): Promise<unknown>;
  agentHookPolicy(input: unknown): Promise<unknown>;
  updateAgentHookPolicy(input: unknown): Promise<unknown>;
  /** Agent Execution-owned raw AGENTS.md library. */
  agentsMd?(input?: unknown): Promise<unknown>;
  agentsMdDraft?(input: unknown): Promise<unknown>;
  agentsMdVersion?(input: unknown): Promise<unknown>;
  saveAgentsMdDraft?(input: unknown): Promise<unknown>;
  publishAgentsMd?(input: unknown): Promise<unknown>;
  deleteAgentsMdDraft?(input: unknown): Promise<unknown>; deleteAgentsMdVersion?(input: unknown): Promise<unknown>;
  turnPrompts?(input?: unknown): Promise<unknown>; turnPromptDraft?(input: unknown): Promise<unknown>; turnPromptVersion?(input: unknown): Promise<unknown>; saveTurnPromptDraft?(input: unknown): Promise<unknown>; validateTurnPrompt?(input: unknown): Promise<unknown>; previewTurnPrompt?(input: unknown): Promise<unknown>; publishTurnPrompt?(input: unknown): Promise<unknown>;
  deleteTurnPromptDraft?(input: unknown): Promise<unknown>; deleteTurnPromptVersion?(input: unknown): Promise<unknown>;
  mcpPolicies?(input?: unknown): Promise<unknown>; mcpPolicyDraft?(input: unknown): Promise<unknown>; mcpPolicyVersion?(input: unknown): Promise<unknown>; saveMcpPolicyDraft?(input: unknown): Promise<unknown>; publishMcpPolicy?(input: unknown): Promise<unknown>;
  deleteMcpPolicyDraft?(input: unknown): Promise<unknown>; deleteMcpPolicyVersion?(input: unknown): Promise<unknown>;
  skills?(input?: unknown): Promise<unknown>; skillDraft?(input: unknown): Promise<unknown>; skillVersion?(input: unknown): Promise<unknown>; saveSkillDraft?(input: unknown): Promise<unknown>; validateSkill?(input: unknown): Promise<unknown>; publishSkill?(input: unknown): Promise<unknown>;
  deleteSkillDraft?(input: unknown): Promise<unknown>; deleteSkillVersion?(input: unknown): Promise<unknown>;
  populations?(input?: unknown): Promise<unknown>; populationDraft?(input: unknown): Promise<unknown>; populationVersion?(input: unknown): Promise<unknown>; savePopulationDraft?(input: unknown): Promise<unknown>; publishPopulation?(input: unknown): Promise<unknown>;
  deletePopulationDraft?(input: unknown): Promise<unknown>; deletePopulationVersion?(input: unknown): Promise<unknown>;
  agentBlueprints?(input?: unknown): Promise<unknown>; agentBlueprintDraft?(input: unknown): Promise<unknown>; agentBlueprintVersion?(input: unknown): Promise<unknown>; saveAgentBlueprintDraft?(input: unknown): Promise<unknown>; publishAgentBlueprint?(input: unknown): Promise<unknown>;
  deleteAgentBlueprintDraft?(input: unknown): Promise<unknown>; deleteAgentBlueprintVersion?(input: unknown): Promise<unknown>;
  socialNetworks?(input?: unknown): Promise<unknown>; socialNetworkDraft?(input: unknown): Promise<unknown>; socialNetworkVersion?(input: unknown): Promise<unknown>; saveSocialNetworkDraft?(input: unknown): Promise<unknown>; validateSocialNetwork?(input: unknown): Promise<unknown>; publishSocialNetwork?(input: unknown): Promise<unknown>;
  deleteSocialNetworkDraft?(input: unknown): Promise<unknown>; deleteSocialNetworkVersion?(input: unknown): Promise<unknown>;
  financialInitialStatePresets?(input?: unknown): Promise<unknown>; financialInitialStatePresetDraft?(input: unknown): Promise<unknown>; financialInitialStatePresetVersion?(input: unknown): Promise<unknown>; saveFinancialInitialStatePresetDraft?(input: unknown): Promise<unknown>; publishFinancialInitialStatePreset?(input: unknown): Promise<unknown>;
  deleteFinancialInitialStatePresetDraft?(input: unknown): Promise<unknown>; deleteFinancialInitialStatePresetVersion?(input: unknown): Promise<unknown>;
  /** Social-owned algorithm library, exposed through Console only. */
  feedAlgorithms?(input?: unknown): Promise<unknown>;
  feedAlgorithmDraft?(input: unknown): Promise<unknown>;
  feedAlgorithmVersion?(input: unknown): Promise<unknown>;
  saveFeedAlgorithmDraft?(input: unknown): Promise<unknown>;
  validateFeedAlgorithm?(input: unknown): Promise<unknown>;
  publishFeedAlgorithm?(input: unknown): Promise<unknown>;
  deleteFeedAlgorithmDraft?(input: unknown): Promise<unknown>; deleteFeedAlgorithmVersion?(input: unknown): Promise<unknown>;
  previewFeedAlgorithm?(input: unknown): Promise<unknown>;
  /** Financial-owned market-maker library, exposed through Console only. */
  marketMakers?(input?: unknown): Promise<unknown>;
  marketMakerDraft?(input: unknown): Promise<unknown>;
  marketMakerVersion?(input: unknown): Promise<unknown>;
  saveMarketMakerDraft?(input: unknown): Promise<unknown>;
  validateMarketMaker?(input: unknown): Promise<unknown>;
  publishMarketMaker?(input: unknown): Promise<unknown>;
  deleteMarketMakerDraft?(input: unknown): Promise<unknown>; deleteMarketMakerVersion?(input: unknown): Promise<unknown>;
  previewMarketMaker?(input: unknown): Promise<unknown>;
  llmConfigGraph(): Promise<unknown>;
  llmConfigValidate(input: unknown): Promise<unknown>;
  llmConfigPatch(input: unknown): Promise<unknown>;
  llmConfigCreateResource(kind: string, input: unknown): Promise<unknown>;
  llmConfigDeleteResource(kind: string, id: string, baseRevision: string): Promise<unknown>;
}

function requiredUrl(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function llmConfigurationUrl(path: string) {
  const base = requiredUrl("OPENLEEK_LLM_CONFIGURATION_URL");
  return new URL(path.replace(/^\//, ""), `${base.replace(/\/$/, "")}/`).toString();
}

function safeConfigurationError(status: number, value: unknown) {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const message = typeof record.message === "string" ? record.message : `LLM Configuration request failed (${status})`;
  return new Error(message.slice(0, 1_000));
}

async function contextRegistryRequest(path: string, init: RequestInit = {}) {
  const response = await fetch(new URL(path, requiredUrl("OPENLEEK_CONTEXT_REGISTRY_URL")), { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${requiredUrl("OPENLEEK_CONTEXT_REGISTRY_MANAGEMENT_TOKEN")}`, ...init.headers }, cache: "no-store" });
  const value = await response.json().catch(() => ({ error: `Context Registry returned HTTP ${response.status}` })) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof value.error === "string" ? value.error : `Context Registry returned HTTP ${response.status}`);
  return value;
}

async function llmConfigurationRequest(request: ConfigurationRequest): Promise<unknown> {
  const headers = new Headers({ Accept: "application/json" });
  if (request.body !== undefined) headers.set("Content-Type", "application/json");
  const token = process.env.OPENLEEK_LLM_CONFIGURATION_MANAGEMENT_TOKEN;
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const init: RequestInit = {
    method: request.method,
    headers,
    cache: "no-store",
  };
  if (request.body !== undefined) init.body = JSON.stringify(request.body);
  const response = await fetch(llmConfigurationUrl(request.path), init);
  const text = await response.text();
  let value: unknown = undefined;
  if (text) {
    try { value = JSON.parse(text); } catch { value = { message: `LLM Configuration returned invalid JSON (${response.status})` }; }
  }
  if (response.ok || request.acceptStatuses?.includes(response.status)) return value;
  throw safeConfigurationError(response.status, value);
}


/** Network-only BFF ports. Console never sees a database credential. */
export function networkConsolePorts(): ConsolePorts {
  const experiment = rpc(requiredUrl("OPENLEEK_EXPERIMENT_URL")).experiment;
  const agentExecution = rpc(requiredUrl("OPENLEEK_AGENT_EXECUTION_URL")).agentExecution;
  const socialEnvironment = rpc(requiredUrl("OPENLEEK_SOCIAL_ENVIRONMENT_URL")).socialEnvironment;
  const financialMarket = rpc(requiredUrl("OPENLEEK_FINANCIAL_MARKET_URL")).financialMarket;
  return {
    dataDictionaryCatalog: async () => {
      const sources = [
        { ownerId: "experiment", owner: { default: "Experiment", translations: { en: "Experiment", zh: "实验" } }, query: () => experiment.dataDictionary.catalog.query({}) },
        { ownerId: "agent-execution", owner: { default: "Agent Execution", translations: { en: "Agent Execution", zh: "智能体执行" } }, query: () => agentExecution.dataDictionary.catalog.query({}) },
        { ownerId: "social", owner: { default: "Social Environment", translations: { en: "Social Environment", zh: "社交环境" } }, query: () => socialEnvironment.dataDictionary.catalog.query({}) },
        { ownerId: "financial", owner: { default: "Financial Market", translations: { en: "Financial Market", zh: "金融市场" } }, query: () => financialMarket.dataDictionary.catalog.query({}) },
        { ownerId: "llm-configuration", owner: { default: "LLM Configuration", translations: { en: "LLM Configuration", zh: "LLM 配置" } }, query: async () => llmConfigurationDataDictionary(await llmConfigurationRequest({ method: "GET", path: "/api/v1/config/graph" })) },
      ];
      const settled = await Promise.allSettled(sources.map((source) => source.query()));
      return {
        schemaVersion: "1",
        sources: settled.map((result, index) => {
          const fallback = sources[index]!;
          if (result.status === "rejected") {
            return {
              ownerId: fallback.ownerId,
              owner: fallback.owner,
              available: false,
              entries: [],
              error: result.reason instanceof Error ? result.reason.message : "Data dictionary source is unavailable",
            };
          }
          const source = result.value as {
            ownerId: string;
            owner: unknown;
            revision: string;
            entries: unknown[];
          };
          return {
            ownerId: source.ownerId,
            owner: source.owner,
            available: true,
            revision: source.revision,
            entries: source.entries,
          };
        }),
      };
    },
    contextCatalog: () => experiment.contexts.catalog.query({}),
    contextAssetRead: (input) => experiment.contexts.assetRead.query(input),
    contextAssetCommand: (input) => experiment.contexts.assetCommand.mutate(input),
    listContextInstallations: () => contextRegistryRequest("/internal/installations"),
    contextInstallationAction: ({ installationRef, action }) => contextRegistryRequest(`/internal/installations/${encodeURIComponent(installationRef)}`, { method: "PATCH", body: JSON.stringify(action === "activate" ? { action: "activate" } : { action: "transition", state: action === "drain" ? "draining" : "disabled" }) }),
    listRuns: (input) => experiment.list.query(input),
    validateSpecification: (input) => experiment.validateSpecification.query(input),
    createRun: (input) => experiment.create.mutate(input),
    command: (name, input) => experiment[name].mutate(input),
    fork: (input) => experiment.fork.mutate(input),
    getRun: (input) => experiment.get.query(input),
    roundProgress: (input) => experiment.roundProgress.query(input),
    committedRounds: (input) => experiment.committedRounds.query(input),
    committedManifest: (input) => experiment.committedManifest.query(input),
    agentRegistrations: (input) => experiment.agentRegistrations.query(input),
    committedFacts: (name, input) => {
      if (name === "agentExecution") return agentExecution.queryCommittedFacts.query(input);
      return ({ socialEnvironment, financialMarket }[name].queryCommittedRevisionFacts.query(input));
    },
    financialObserver: (input) => financialMarket.observer.query(input),
    socialObserver: (input) => socialEnvironment.observer.query(input),
    agentRuntimeEvidence: (input) => agentExecution.runtimeEvidence.query(input),
    agentRuntimeCapability: (input) => agentExecution.runtimeCapability.query(input),
    agentExecutionProviders: (input) => agentExecution.executionProviders.query(input),
    chatGptAuthStatus: (input) => agentExecution.chatGptAuth.status.query(input),
    chatGptRateLimits: (input) => agentExecution.chatGptAuth.rateLimits.query(input),
    startChatGptDeviceAuthorization: (input) => agentExecution.chatGptAuth.startDeviceAuthorization.mutate(input),
    cancelChatGptDeviceAuthorization: (input) => agentExecution.chatGptAuth.cancelDeviceAuthorization.mutate(input),
    logoutChatGpt: (input) => agentExecution.chatGptAuth.logout.mutate(input),
    agentTokenUsage: (input) => agentExecution.tokenUsage.query(input),
    agentTranscripts: (input) => agentExecution.transcripts.query(input),
    agentHookPolicy: (input) => agentExecution.hookPolicy.get.query(input),
    updateAgentHookPolicy: (input) => agentExecution.hookPolicy.update.mutate(input),
    agentsMd: (input = {}) => agentExecution.agentsMd.list.query(input),
    agentsMdDraft: (input) => agentExecution.agentsMd.draft.query(input),
    agentsMdVersion: (input) => agentExecution.agentsMd.version.query(input),
    saveAgentsMdDraft: (input) => agentExecution.agentsMd.saveDraft.mutate(input),
    publishAgentsMd: (input) => agentExecution.agentsMd.publish.mutate(input),
    deleteAgentsMdDraft: (input) => agentExecution.agentsMd.deleteDraft.mutate(input),
    deleteAgentsMdVersion: (input) => agentExecution.agentsMd.deleteVersion.mutate(input),
    turnPrompts: (input = {}) => experiment.turnPrompts.list.query(input), turnPromptDraft: (input) => experiment.turnPrompts.draft.query(input), turnPromptVersion: (input) => experiment.turnPrompts.version.query(input), saveTurnPromptDraft: (input) => experiment.turnPrompts.saveDraft.mutate(input), validateTurnPrompt: (input) => experiment.turnPrompts.validate.mutate(input), previewTurnPrompt: (input) => experiment.turnPrompts.preview.mutate(input), publishTurnPrompt: (input) => experiment.turnPrompts.publish.mutate(input),
    deleteTurnPromptDraft: (input) => experiment.turnPrompts.deleteDraft.mutate(input), deleteTurnPromptVersion: (input) => experiment.turnPrompts.deleteVersion.mutate(input),
    mcpPolicies: (input = {}) => agentExecution.mcpPolicies.list.query(input), mcpPolicyDraft: (input) => agentExecution.mcpPolicies.draft.query(input), mcpPolicyVersion: (input) => agentExecution.mcpPolicies.version.query(input), saveMcpPolicyDraft: (input) => agentExecution.mcpPolicies.saveDraft.mutate(input), publishMcpPolicy: (input) => agentExecution.mcpPolicies.publish.mutate(input),
    deleteMcpPolicyDraft: (input) => agentExecution.mcpPolicies.deleteDraft.mutate(input), deleteMcpPolicyVersion: (input) => agentExecution.mcpPolicies.deleteVersion.mutate(input),
    skills: (input = {}) => agentExecution.skills.list.query(input), skillDraft: (input) => agentExecution.skills.draft.query(input), skillVersion: (input) => agentExecution.skills.version.query(input), saveSkillDraft: (input) => agentExecution.skills.saveDraft.mutate(input), validateSkill: (input) => agentExecution.skills.validate.mutate(input), publishSkill: (input) => agentExecution.skills.publish.mutate(input),
    deleteSkillDraft: (input) => agentExecution.skills.deleteDraft.mutate(input), deleteSkillVersion: (input) => agentExecution.skills.deleteVersion.mutate(input),
    populations: (input = {}) => experiment.populations.list.query(input), populationDraft: (input) => experiment.populations.draft.query(input), populationVersion: (input) => experiment.populations.version.query(input), savePopulationDraft: (input) => experiment.populations.saveDraft.mutate(input), publishPopulation: (input) => experiment.populations.publish.mutate(input),
    deletePopulationDraft: (input) => experiment.populations.deleteDraft.mutate(input), deletePopulationVersion: (input) => experiment.populations.deleteVersion.mutate(input),
    agentBlueprints: (input = {}) => experiment.agentBlueprints.list.query(input), agentBlueprintDraft: (input) => experiment.agentBlueprints.draft.query(input), agentBlueprintVersion: (input) => experiment.agentBlueprints.version.query(input), saveAgentBlueprintDraft: (input) => experiment.agentBlueprints.saveDraft.mutate(input), publishAgentBlueprint: (input) => experiment.agentBlueprints.publish.mutate(input),
    deleteAgentBlueprintDraft: (input) => experiment.agentBlueprints.deleteDraft.mutate(input), deleteAgentBlueprintVersion: (input) => experiment.agentBlueprints.deleteVersion.mutate(input),
    socialNetworks: (input = {}) => socialEnvironment.socialNetworks.query(input), socialNetworkDraft: (input) => socialEnvironment.socialNetworkDraft.query(input), socialNetworkVersion: (input) => socialEnvironment.socialNetworkVersion.query(input), saveSocialNetworkDraft: (input) => socialEnvironment.saveSocialNetworkDraft.mutate(input), validateSocialNetwork: (input) => socialEnvironment.validateSocialNetwork.mutate(input), publishSocialNetwork: (input) => socialEnvironment.publishSocialNetwork.mutate(input),
    deleteSocialNetworkDraft: (input) => socialEnvironment.deleteSocialNetworkDraft.mutate(input), deleteSocialNetworkVersion: (input) => socialEnvironment.deleteSocialNetworkVersion.mutate(input),
    financialInitialStatePresets: (input = {}) => financialMarket.financialInitialStatePresets.query(input), financialInitialStatePresetDraft: (input) => financialMarket.financialInitialStatePresetDraft.query(input), financialInitialStatePresetVersion: (input) => financialMarket.financialInitialStatePresetVersion.query(input), saveFinancialInitialStatePresetDraft: (input) => financialMarket.saveFinancialInitialStatePresetDraft.mutate(input), publishFinancialInitialStatePreset: (input) => financialMarket.publishFinancialInitialStatePreset.mutate(input),
    deleteFinancialInitialStatePresetDraft: (input) => financialMarket.deleteFinancialInitialStatePresetDraft.mutate(input), deleteFinancialInitialStatePresetVersion: (input) => financialMarket.deleteFinancialInitialStatePresetVersion.mutate(input),
    feedAlgorithms: (input = {}) => socialEnvironment.feedAlgorithms.query(input),
    feedAlgorithmDraft: (input) => socialEnvironment.feedAlgorithmDraft.query(input),
    feedAlgorithmVersion: (input) => socialEnvironment.feedAlgorithmVersion.query(input),
    saveFeedAlgorithmDraft: (input) => socialEnvironment.saveFeedAlgorithmDraft.mutate(input),
    validateFeedAlgorithm: (input) => socialEnvironment.validateFeedAlgorithm.mutate(input),
    publishFeedAlgorithm: (input) => socialEnvironment.publishFeedAlgorithm.mutate(input),
    deleteFeedAlgorithmDraft: (input) => socialEnvironment.deleteFeedAlgorithmDraft.mutate(input),
    deleteFeedAlgorithmVersion: (input) => socialEnvironment.deleteFeedAlgorithmVersion.mutate(input),
    previewFeedAlgorithm: (input) => socialEnvironment.previewFeedAlgorithm.mutate(input),
    marketMakers: (input = {}) => financialMarket.marketMakers.query(input),
    marketMakerDraft: (input) => financialMarket.marketMakerDraft.query(input),
    marketMakerVersion: (input) => financialMarket.marketMakerVersion.query(input),
    saveMarketMakerDraft: (input) => financialMarket.saveMarketMakerDraft.mutate(input),
    validateMarketMaker: (input) => financialMarket.validateMarketMaker.mutate(input),
    publishMarketMaker: (input) => financialMarket.publishMarketMaker.mutate(input),
    deleteMarketMakerDraft: (input) => financialMarket.deleteMarketMakerDraft.mutate(input),
    deleteMarketMakerVersion: (input) => financialMarket.deleteMarketMakerVersion.mutate(input),
    previewMarketMaker: (input) => financialMarket.previewMarketMaker.mutate(input),
    llmConfigGraph: () => llmConfigurationRequest({ method: "GET", path: "/api/v1/config/graph" }),
    llmConfigValidate: (input) => llmConfigurationRequest({ method: "POST", path: "/api/v1/config/graph/validate", body: input, acceptStatuses: [400, 409] }),
    llmConfigPatch: (input) => llmConfigurationRequest({ method: "PATCH", path: "/api/v1/config/graph", body: input, acceptStatuses: [400, 409] }),
    llmConfigCreateResource: (kind, input) => llmConfigurationRequest({ method: "POST", path: `/api/v1/config/resources/${encodeURIComponent(kind)}`, body: input, acceptStatuses: [400, 409] }),
    llmConfigDeleteResource: (kind, id, baseRevision) => llmConfigurationRequest({
      method: "DELETE",
      path: `/api/v1/config/resources/${encodeURIComponent(kind)}/${encodeURIComponent(id)}?baseRevision=${encodeURIComponent(baseRevision)}`,
      acceptStatuses: [400, 409],
    }),
  };
}
