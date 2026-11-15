import { type PluginSpecification } from "@openleek/contracts/experiment";
import { type TurnPromptVariableDefinition, type TurnPromptVariableValue } from "@openleek/contracts/turn-prompt";
import { type NameTheme } from "@openleek/contracts/world";

export type RecordValue = Record<string, unknown>;
export type GeneratorKind = "population" | "network";
export type SocialMode = "ranking" | "feedAlgorithm";
export type MarketMakerTiming = "opening" | "settlement";
export type MatchingPolicy = "batch" | "incremental";
export type RequotePolicy = "none" | "after_each_trade";

export type RuntimeModel = { id: string; displayName: string; defaultReasoningEffort: string; supportedReasoningEfforts: string[] };
export type RuntimeProvider = { provider: "deepseek" | "openai"; available: boolean; models: RuntimeModel[] };
export type RuntimeCapability = { model: string; revision: string; memoryRoute: string; providers: RuntimeProvider[] };
export type GeneratorVersion = {
  versionRef: string;
  name: string;
  kind: GeneratorKind;
  defaultConfig: RecordValue;
  configSchema: RecordValue;
};
export type AlgorithmVersion = { versionRef: string; name: string; defaultConfig: RecordValue };
export type AssetVersion = { versionRef: string; name: string; defaultConfig: RecordValue };
export type TurnPromptVersion = { versionRef: string; name: string; variables: TurnPromptVariableDefinition[] };
export type Instrument = { symbol: string; referencePrice: number; tickSize: number };

export type RunFormState = {
  seed: number;
  roundCount: number;
  startUnixSeconds: number;
  stepSeconds: number;
  retryMaxAttempts: number;
  retryBackoffMs: number;
  roundAdvancement: "manual" | "automatic";
  worldName: string;
  scenarioVersion: string;
  nameTheme: NameTheme;
  population: { versionRef: string };
  socialNetwork: { versionRef: string; config: RecordValue };
  maxConcurrentAgents: number;
  maxCallsPerToolPerTurn: number;
  runtime: { provider: "deepseek" | "openai"; model: string; reasoningEffort: string };
  turnPrompt: { versionRef: string; variables: Record<string, TurnPromptVariableValue> };
  exposurePolicy: "recommendation_only" | "public_browse";
  socialMode: SocialMode;
  ranking: { recencyWeight: number; engagementWeight: number };
  feedAlgorithm: { versionRef: string; config: RecordValue };
  feedSize: number;
  audienceReception: { engagementProbability: number; repostProbability: number };
  instruments: Instrument[];
  marketMakerEnabled: boolean;
  marketMaker: { versionRef: string; initialStatePresetVersionRef: string; timing: MarketMakerTiming; matchingPolicy: MatchingPolicy; requotePolicy: RequotePolicy; maxRequotesPerIntent: number; config: RecordValue };
  newsScenarioVersionRef: string;
};

export type JsonSchemaField = {
  name: string;
  title: string;
  type: "string" | "number" | "integer" | "boolean" | "object" | "array" | "unknown";
  enum?: Array<string | number | boolean>;
  required: boolean;
};

const object = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const text = (value: unknown, fallback = ""): string => typeof value === "string" ? value : fallback;
const number = (value: unknown, fallback: number): number => typeof value === "number" && Number.isFinite(value) ? value : fallback;
const integer = (value: unknown, fallback: number): number => Number.isSafeInteger(value) ? value as number : fallback;
const clone = (value: RecordValue): RecordValue => structuredClone(value);

export function defaultRunForm(): RunFormState {
  return {
    seed: 42, roundCount: 2, startUnixSeconds: 0, stepSeconds: 86_400, retryMaxAttempts: 3, retryBackoffMs: 1000, roundAdvancement: "manual",
    worldName: "OpenLeek sample", scenarioVersion: "1", nameTheme: "research-codes-v1",
    population: { versionRef: "" }, socialNetwork: { versionRef: "", config: {} },
    maxConcurrentAgents: 10, maxCallsPerToolPerTurn: 6, runtime: { provider: "deepseek", model: "deepseek-v4-flash", reasoningEffort: "high" }, turnPrompt: { versionRef: "", variables: {} }, exposurePolicy: "recommendation_only", socialMode: "ranking",
    ranking: { recencyWeight: 1, engagementWeight: 1 }, feedAlgorithm: { versionRef: "", config: {} },
    feedSize: 100, audienceReception: { engagementProbability: 0.1, repostProbability: 0.02 },
    instruments: [{ symbol: "LEEK", referencePrice: 100, tickSize: 0.01 }], marketMakerEnabled: false,
    marketMaker: { versionRef: "", initialStatePresetVersionRef: "", timing: "opening", matchingPolicy: "batch", requotePolicy: "none", maxRequotesPerIntent: 1000, config: {} },
    newsScenarioVersionRef: "news-scenario:reference:v:acebaea778d02a4f",
  };
}

export function generatorVersions(value: unknown): GeneratorVersion[] {
  const versions = object(value).versions;
  if (!Array.isArray(versions)) return [];
  return versions.flatMap((item) => {
    const version = object(item);
    const kind = text(version.kind);
    if ((kind !== "population" && kind !== "network") || !text(version.versionRef) || !text(version.name)) return [];
    return [{ versionRef: text(version.versionRef), name: text(version.name), kind, defaultConfig: clone(object(version.defaultConfig)), configSchema: clone(object(version.configSchema)) }];
  });
}

export function algorithmVersions(value: unknown): AlgorithmVersion[] {
  const versions = object(value).versions;
  if (!Array.isArray(versions)) return [];
  return versions.flatMap((item) => {
    const version = object(item);
    if (!text(version.versionRef) || !text(version.name)) return [];
    return [{ versionRef: text(version.versionRef), name: text(version.name), defaultConfig: clone(object(version.defaultConfig)) }];
  });
}

export function assetVersions(value: unknown): AssetVersion[] {
  const versions = object(value).versions;
  if (!Array.isArray(versions)) return [];
  return versions.flatMap((item) => {
    const version = object(item);
    if (!text(version.versionRef) || !text(version.name)) return [];
    return [{ versionRef: text(version.versionRef), name: text(version.name), defaultConfig: clone(object(version.defaultConfig)) }];
  });
}

export function turnPromptVersions(value: unknown): TurnPromptVersion[] {
  const versions = object(value).versions;
  if (!Array.isArray(versions)) return [];
  return versions.flatMap((item) => {
    const version = object(item);
    if (!text(version.versionRef) || !text(version.name) || !Array.isArray(version.variables)) return [];
    return [{ versionRef: text(version.versionRef), name: text(version.name), variables: structuredClone(version.variables) as TurnPromptVariableDefinition[] }];
  });
}

export function generatorSchemaFields(schema: RecordValue): JsonSchemaField[] {
  const properties = object(schema.properties);
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((value): value is string => typeof value === "string") : []);
  return Object.entries(properties).map(([name, raw]) => {
    const property = object(raw);
    const rawType = text(property.type);
    const type = rawType === "string" || rawType === "number" || rawType === "integer" || rawType === "boolean" || rawType === "object" || rawType === "array" ? rawType : "unknown";
    const values = Array.isArray(property.enum) && property.enum.every((value) => typeof value === "string" || typeof value === "number" || typeof value === "boolean")
      ? property.enum as Array<string | number | boolean> : undefined;
    return { name, title: text(property.title, name), type, ...(values ? { enum: values } : {}), required: required.has(name) };
  });
}

export function updateGeneratorSelection(state: RunFormState, kind: GeneratorKind, version?: GeneratorVersion): RunFormState {
  const selection = { versionRef: version?.versionRef ?? "", config: clone(version?.defaultConfig ?? {}) };
  return kind === "population" ? { ...state, population: { versionRef: selection.versionRef } } : { ...state, socialNetwork: selection };
}

export function updateConfig(config: RecordValue, key: string, value: unknown): RecordValue { return { ...config, [key]: value }; }

export function toSpecification(state: RunFormState, runtime: RuntimeCapability): PluginSpecification {
  const socialEnvironment = {
    exposurePolicy: state.exposurePolicy,
    ...(state.socialMode === "ranking" ? { ranking: { ...state.ranking } } : { feedAlgorithm: { versionRef: state.feedAlgorithm.versionRef, config: clone(state.feedAlgorithm.config) } }),
    feedSize: state.feedSize,
    audienceReception: { ...state.audienceReception },
  };
  return {
    schemaVersion: "3", seed: state.seed, roundCount: state.roundCount,
    clock: { startUnixSeconds: state.startUnixSeconds, stepSeconds: state.stepSeconds },
    executionPolicy: { automaticRetryMaxAttempts: state.retryMaxAttempts, automaticRetryBackoffMs: state.retryBackoffMs, roundAdvancement: state.roundAdvancement },
    initialWorld: {
      worldName: state.worldName, scenarioVersion: state.scenarioVersion,
      population: { versionRef: state.population.versionRef },
      nameTheme: state.nameTheme,
    },
    turnPrompt: { versionRef: state.turnPrompt.versionRef, variables: structuredClone(state.turnPrompt.variables) },
    agentExecution: {
      runtime: state.runtime.provider === "deepseek"
        ? { provider: "deepseek", model: "deepseek-v4-flash", reasoningEffort: state.runtime.reasoningEffort as "high" | "xhigh" }
        : { provider: "openai", model: state.runtime.model, reasoningEffort: state.runtime.reasoningEffort },
      maxConcurrentAgents: state.maxConcurrentAgents,
      toolCallBudget: { maxCallsPerToolPerTurn: state.maxCallsPerToolPerTurn },
      memoryProfile: { routeId: runtime.memoryRoute, llmConfigRevision: runtime.revision },
    },
    researchTemplate: { versionRef: "research-template:tri-context:v1" },
    contexts: {
      social: { installationRef: "context-installation:social:builtin", descriptorRevision: "social-context:v3", configuration: { ...socialEnvironment, ...(state.socialNetwork.versionRef ? { socialNetwork: { versionRef: state.socialNetwork.versionRef, config: clone(state.socialNetwork.config) } } : {}) } },
      financial: { installationRef: "context-installation:financial:builtin", descriptorRevision: "financial-context:v3", configuration: {
        instruments: state.instruments.map((instrument) => ({ ...instrument })),
        ...(state.marketMakerEnabled ? { marketMaker: { versionRef: state.marketMaker.versionRef, initialStatePresetVersionRef: state.marketMaker.initialStatePresetVersionRef, timing: state.marketMaker.timing, matchingPolicy: state.marketMaker.matchingPolicy, requotePolicy: state.marketMaker.requotePolicy, maxRequotesPerIntent: state.marketMaker.maxRequotesPerIntent, config: clone(state.marketMaker.config) } } : {}),
      } },
      news: { installationRef: "context-installation:news:builtin", descriptorRevision: "news-context:v4", configuration: { scenarioVersionRef: state.newsScenarioVersionRef } },
    },
  };
}

/** Parses an advanced JSON draft without modifying caller state on error. */
export function formFromAdvancedJson(value: string): RunFormState {
  const parsed = JSON.parse(value) as unknown;
  const specification = object(parsed);
  if (specification.schemaVersion !== "3") throw new Error("Advanced JSON must be a v3 Specification.");
  const current = defaultRunForm();
  const clock = object(specification.clock);
  const retries = object(specification.executionPolicy);
  const world = object(specification.initialWorld);
  const population = object(world.population);
  const execution = object(specification.agentExecution);
  const turnPrompt = object(specification.turnPrompt);
  const contexts = object(specification.contexts);
  const social = object(object(contexts.social).configuration);
  const ranking = object(social.ranking);
  const feed = object(social.feedAlgorithm);
  const audience = object(social.audienceReception);
  const financial = object(object(contexts.financial).configuration);
  const maker = object(financial.marketMaker);
  const instruments = Array.isArray(financial.instruments) ? financial.instruments.flatMap((item) => {
    const instrument = object(item);
    const symbol = text(instrument.symbol);
    const referencePrice = number(instrument.referencePrice, Number.NaN);
    const tickSize = number(instrument.tickSize, 1);
    return symbol && Number.isFinite(referencePrice) && tickSize > 0 ? [{ symbol, referencePrice, tickSize }] : [];
  }) : current.instruments;
  const feedEnabled = Object.keys(feed).length > 0;
  const makerEnabled = Object.keys(maker).length > 0;
  return {
    seed: integer(specification.seed, current.seed), roundCount: integer(specification.roundCount, current.roundCount),
    startUnixSeconds: integer(clock.startUnixSeconds, current.startUnixSeconds), stepSeconds: integer(clock.stepSeconds, current.stepSeconds),
    retryMaxAttempts: integer(retries.automaticRetryMaxAttempts, current.retryMaxAttempts), retryBackoffMs: integer(retries.automaticRetryBackoffMs, current.retryBackoffMs),
    roundAdvancement: retries.roundAdvancement === "automatic" ? "automatic" : "manual",
    worldName: text(world.worldName, current.worldName), scenarioVersion: text(world.scenarioVersion, current.scenarioVersion),
    nameTheme: text(world.nameTheme, current.nameTheme) as NameTheme,
    population: { versionRef: text(population.versionRef) },
    socialNetwork: { versionRef: text(object(social.socialNetwork).versionRef), config: clone(object(object(social.socialNetwork).config)) },
    maxConcurrentAgents: integer(execution.maxConcurrentAgents, current.maxConcurrentAgents),
    runtime: parseRuntime(execution.runtime, current.runtime),
    maxCallsPerToolPerTurn: integer(object(execution.toolCallBudget).maxCallsPerToolPerTurn, current.maxCallsPerToolPerTurn),
    turnPrompt: { versionRef: text(turnPrompt.versionRef), variables: structuredClone(object(turnPrompt.variables)) as Record<string, TurnPromptVariableValue> },
    exposurePolicy: social.exposurePolicy === "public_browse" ? "public_browse" : "recommendation_only",
    socialMode: feedEnabled ? "feedAlgorithm" : "ranking",
    ranking: { recencyWeight: number(ranking.recencyWeight, 1), engagementWeight: number(ranking.engagementWeight, 1) },
    feedAlgorithm: { versionRef: text(feed.versionRef), config: clone(object(feed.config)) },
    feedSize: integer(social.feedSize, current.feedSize),
    audienceReception: { engagementProbability: number(audience.engagementProbability, 0.1), repostProbability: number(audience.repostProbability, 0.02) },
    instruments, marketMakerEnabled: makerEnabled,
    marketMaker: {
      versionRef: text(maker.versionRef),
      initialStatePresetVersionRef: text(maker.initialStatePresetVersionRef),
      timing: maker.timing === "settlement" ? "settlement" : "opening",
      matchingPolicy: maker.matchingPolicy === "incremental" ? "incremental" : "batch",
      requotePolicy: maker.requotePolicy === "after_each_trade" ? "after_each_trade" : "none",
      maxRequotesPerIntent: integer(maker.maxRequotesPerIntent, 1000),
      config: clone(object(maker.config)),
    },
    newsScenarioVersionRef: text(object(object(contexts.news).configuration).scenarioVersionRef, current.newsScenarioVersionRef),
  };
}

function parseRuntime(value: unknown, fallback: RunFormState["runtime"]): RunFormState["runtime"] {
  const runtime = object(value);
  const provider = runtime.provider === "openai" ? "openai" : runtime.provider === "deepseek" ? "deepseek" : fallback.provider;
  return { provider, model: text(runtime.model, fallback.model), reasoningEffort: text(runtime.reasoningEffort, fallback.reasoningEffort) };
}
