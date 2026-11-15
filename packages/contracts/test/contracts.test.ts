import assert from "node:assert/strict";
import test from "node:test";
import { agentBlueprintDefinitionSchema, agentExecutionSectionSchema, mcpPolicyDefinitionSchema, skillDefinitionSchema } from "../src/agent.js";
import { contextDescriptorSchema, contextInstallationSchema, contextRuntimeDescriptorSchema } from "../src/context.js";
import { parseMutationHeader } from "../src/core.js";
import { dataDictionaryCatalogSchema, dataDictionarySourceSchema } from "../src/data-dictionary.js";
import { committedPluginManifestSchema, committedPluginRoundListSchema, createRunInputSchema, dynamicSpecificationSchema, forkRunInputSchema, specificationSchema } from "../src/experiment.js";
import { actionTokenAttributionSchema } from "../src/observability.js";
import { TURN_PROMPT_SYSTEM_VARIABLES, turnPromptPlaceholderNames } from "../src/turn-prompt.js";
import { canonicalize, sha256Digest } from "../src/canonical.js";

const digest = "a".repeat(64);

test("committed Run reads use only the Context-indexed v3 Manifest", () => {
  const manifest = { schemaVersion: "3", ref: "manifest:3", runId: "run:3", roundId: 1, state: "committed", agentExecution: { ref: "agent:3", runId: "run:3", roundId: 1, digest }, contexts: { weather: { ref: "weather:3", context: "weather", runId: "run:3", roundId: 1, digest } }, digest };
  assert.equal(committedPluginManifestSchema.parse(manifest).contexts.weather?.context, "weather");
  assert.equal(committedPluginRoundListSchema.parse({ items: [manifest] }).items.length, 1);
});

test("domain subpaths are public and the aggregate root is not", async () => {
  for (const entry of ["core", "context", "agent", "turn-prompt", "world", "experiment", "observability", "canonical", "data-dictionary"]) {
    assert.ok(Object.keys(await import(`@openleek/contracts/${entry}`)).length > 0);
  }
  const removedRoot = ["@openleek", "contracts"].join("/");
  await assert.rejects(import(removedRoot), (error: unknown) =>
    error instanceof Error && "code" in error && error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED");
});

function dictionaryEntry(id: string, ownerId = "experiment") {
  return {
    schemaVersion: "1" as const,
    id,
    ownerId,
    categoryId: "experiment",
    entryKind: "asset" as const,
    management: {
      surface: "asset-library" as const,
      key: id,
      idField: `${id}Id`,
      capabilities: ["list", "read", "save-draft", "publish", "delete-draft", "delete-version"] as const,
    },
    label: { default: id, translations: {} },
    description: { default: `${id} definition`, translations: {} },
    definitionSchema: { type: "object" },
    references: [],
    examples: [],
  };
}

test("data dictionary sources preserve owner authority and unique entry IDs", () => {
  const source = {
    schemaVersion: "1" as const,
    ownerId: "experiment",
    owner: { default: "Experiment", translations: {} },
    revision: "dictionary-v1",
    entries: [dictionaryEntry("population")],
  };
  assert.equal(dataDictionarySourceSchema.parse(source).entries[0]?.id, "population");
  assert.equal(dataDictionarySourceSchema.parse(source).entries[0]?.management.surface, "asset-library");
  assert.throws(() => dataDictionarySourceSchema.parse({
    ...source,
    entries: [dictionaryEntry("population", "social")],
  }));
  assert.throws(() => dataDictionarySourceSchema.parse({
    ...source,
    entries: [dictionaryEntry("population"), dictionaryEntry("population")],
  }));
});

test("the aggregated data dictionary rejects duplicate owners and globally duplicate entry IDs", () => {
  const source = {
    ownerId: "experiment",
    owner: { default: "Experiment", translations: {} },
    available: true,
    revision: "dictionary-v1",
    entries: [dictionaryEntry("population")],
  };
  assert.throws(() => dataDictionaryCatalogSchema.parse({
    schemaVersion: "1",
    sources: [source, source],
  }));
  assert.throws(() => dataDictionaryCatalogSchema.parse({
    schemaVersion: "1",
    sources: [
      source,
      {
        ...source,
        ownerId: "social",
        owner: { default: "Social", translations: {} },
        entries: [dictionaryEntry("population", "social")],
      },
    ],
  }));
});

test("Turn Prompt system variables and placeholders share one contract", () => {
  assert.deepEqual(TURN_PROMPT_SYSTEM_VARIABLES, [
    { name: "utcDate", type: "string" },
    { name: "roundId", type: "number" },
  ]);
  assert.deepEqual(
    turnPromptPlaceholderNames("{{utcDate}} / {{custom}} / {{utcDate}}"),
    ["utcDate", "custom"],
  );
});

test("canonicalization is key-order invariant", () => {
  assert.equal(canonicalize({ b: [2, 1], a: "x" }), '{"a":"x","b":[2,1]}');
  assert.equal(sha256Digest({ a: 1, b: 2 }), sha256Digest({ b: 2, a: 1 }));
});

test("token attribution preserves an unavailable upstream response ID", () => {
  const attribution = actionTokenAttributionSchema.parse({
    responseId: "",
    sequence: 1,
    classification: "final_response",
    toolCalls: [],
    usage: null,
  });
  assert.equal(attribution.responseId, "");
});

test("mutations require a predecessor checkpoint except initialization", () => {
  assert.throws(() => parseMutationHeader({ transitionId: "t", stepId: "s", payloadDigest: digest, expectedCheckpointRef: "" }));
  assert.equal(parseMutationHeader({ transitionId: "t", stepId: "s", payloadDigest: digest, expectedCheckpointRef: "" }, { initialization: true }).stepId, "s");
});

test("Agent Environments accept namespaced capability IDs from registered Contexts", () => {
  assert.deepEqual(mcpPolicyDefinitionSchema.parse({
    tools: ["social.engage", "financial.place_order"],
    resources: ["social.feed", "financial.market"],
  }), {
    tools: ["social.engage", "financial.place_order"],
    resources: ["social.feed", "financial.market"],
  });
  assert.deepEqual(mcpPolicyDefinitionSchema.parse({ tools: ["custom_context.perform"], resources: ["custom_context.state"] }), {
    tools: ["custom_context.perform"],
    resources: ["custom_context.state"],
  });
  assert.throws(() => mcpPolicyDefinitionSchema.parse({ tools: ["missing_namespace"], resources: [] }));
  assert.throws(() => mcpPolicyDefinitionSchema.parse({ tools: [], resources: ["invalid uri"] }));
});

test("Skill definitions carry a bounded file tree and declared MCP requirements", () => {
  assert.deepEqual(skillDefinitionSchema.parse({
    files: [{ path: "SKILL.md", encoding: "utf8", content: "---\nname: example\n---\n", executable: false }],
  }).requirements, { tools: [], resources: [] });
  assert.throws(() => skillDefinitionSchema.parse({ files: [], requirements: { tools: [], resources: [] } }));
  assert.throws(() => skillDefinitionSchema.parse({
    files: [{ path: "SKILL.md", encoding: "unknown", content: "", executable: false }],
    requirements: { tools: [], resources: [] },
  }));
});

test("Agent Blueprints compose execution artifacts while Context access belongs to MCP Policy", () => {
  assert.deepEqual(agentBlueprintDefinitionSchema.parse({
    agentsMdVersionRef: "agents-md:research:v1",
    mcpPolicyVersionRef: "mcp-policy:observer:v1",
  }), {
    agentsMdVersionRef: "agents-md:research:v1",
    mcpPolicyVersionRef: "mcp-policy:observer:v1",
    skillVersionRefs: [],
  });
  assert.throws(() => agentBlueprintDefinitionSchema.parse({ agentsMdVersionRef: "agents-md:research:v1" }));
});

test("Context descriptors drive unknown Contexts without a frontend enum", () => {
  const descriptor = contextDescriptorSchema.parse({
    schemaVersion: "1",
    contextId: "custom_context",
    revision: "custom:v1",
    label: { default: "Custom", translations: { zh: "自定义" } },
    description: { default: "Custom simulation environment.", translations: {} },
    agentEnvironment: {
      accountPolicySchema: { type: "object" },
      capabilities: [{ id: "custom_context.perform", kind: "tool", label: { default: "Perform", translations: {} } }],
    },
    worldEnvironment: {
      collections: [{ id: "rules", label: { default: "Rules", translations: {} }, actions: ["list", "draft", "save", "publish", "delete"] }],
    },
    experimentConfigurationSchema: { type: "object" },
  });
  assert.equal(descriptor.contextId, "custom_context");
  assert.equal(descriptor.worldEnvironment.collections[0]?.id, "rules");
  assert.equal(descriptor.worldEnvironment.collections[0]?.actions.includes("delete"), true);
});

function validSpecification() {
  return {
    schemaVersion: "1", seed: 1, roundCount: 2,
    clock: { startUnixSeconds: 0, stepSeconds: 60 },
    executionPolicy: { automaticRetryMaxAttempts: 1, automaticRetryBackoffMs: 1 },
    initialWorld: {
      worldName: "test", scenarioVersion: "1",
      population: { versionRef: "population:test:v1" },
    },
    turnPrompt: { versionRef: "turn-prompt:test:v1", variables: {} },
    agentExecution: { maxConcurrentAgents: 2 },
    socialEnvironment: { exposurePolicy: "recommendation_only" },
    financialMarket: { instruments: [{ symbol: "LEEK", referencePrice: 1 }] },
  };
}

test("new Agent Execution sections default the per-tool per-Turn budget", () => {
  assert.deepEqual(agentExecutionSectionSchema.parse({ maxConcurrentAgents: 2 }).toolCallBudget, { maxCallsPerToolPerTurn: 6 });
  assert.throws(() => agentExecutionSectionSchema.parse({ maxConcurrentAgents: 2, toolCallBudget: { maxCallsPerToolPerTurn: 101 } }));
});

test("v2 specifications carry a contextId-indexed configuration map", () => {
  const { socialEnvironment: _social, financialMarket: _financial, ...base } = validSpecification();
  const parsed = dynamicSpecificationSchema.parse({
    ...base,
    schemaVersion: "2",
    researchTemplate: { versionRef: "research-template:default:v1" },
    contexts: {
      custom_context: { installationRef: "context-installation:custom", descriptorRevision: "custom:v1", configuration: { mode: "test" } },
    },
  });
  assert.deepEqual(Object.keys(parsed.contexts), ["custom_context"]);
});

test("v2 Context installations freeze endpoint identity without exposing credentials", () => {
  const descriptor = contextRuntimeDescriptorSchema.parse({
    schemaVersion: "2",
    runtimeProtocol: "openleek-context-runtime/v1",
    contextId: "news",
    revision: "news-context:v1",
    label: { default: "News", translations: {} },
    description: { default: "Round-released news.", translations: {} },
    infrastructure: { postgres: true },
    agentAccess: "read-only",
    agentEnvironment: { capabilities: [] },
    worldEnvironment: { collections: [] },
  });
  assert.equal(descriptor.infrastructure.redis, false);
  assert.equal(descriptor.agentAccess, "read-only");
  assert.equal(contextInstallationSchema.parse({
    installationRef: "context-installation:news",
    contextId: "news",
    endpoint: "http://news-context:3000",
    descriptorRevision: descriptor.revision,
    state: "active",
    management: "platform",
    infrastructure: descriptor.infrastructure,
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
  }).contextId, "news");
});

test("the internal owner adapter accepts a published Population selection and keeps AGENTS bindings out of specifications", () => {
  const parsed = { specification: specificationSchema.parse(validSpecification()) };
  assert.equal(parsed.specification.initialWorld.population.versionRef, "population:test:v1");
  assert.deepEqual(parsed.specification.turnPrompt, { versionRef: "turn-prompt:test:v1", variables: {} });
  assert.equal("agents" in parsed.specification.agentExecution, false);
});

test("specification rejects caller-selected Agent models", () => {
  const specification = validSpecification();
  (specification.agentExecution as Record<string, unknown>).model = "caller-selected";
  assert.throws(() => specificationSchema.parse(specification));
});

test("the Social adapter requires an explicit exposure policy and rejects legacy ordering", () => {
  const missingPolicy = validSpecification();
  delete (missingPolicy.socialEnvironment as Record<string, unknown>).exposurePolicy;
  assert.throws(() => specificationSchema.parse(missingPolicy));
  const legacyOrder = validSpecification();
  (legacyOrder.executionPolicy as Record<string, unknown>).seededActionOrder = true;
  assert.throws(() => specificationSchema.parse(legacyOrder));
});

test("a run stores either legacy ranking or a published feed algorithm reference, never both", () => {
  const specification = validSpecification();
  (specification.socialEnvironment as Record<string, unknown>).ranking = { recencyWeight: 1, engagementWeight: 1 };
  (specification.socialEnvironment as Record<string, unknown>).feedAlgorithm = { versionRef: "feed-algorithm:research:123", config: { boost: 2 } };
  assert.throws(() => specificationSchema.parse(specification));
  delete (specification.socialEnvironment as Record<string, unknown>).ranking;
  const parsed = specificationSchema.parse(specification);
  assert.equal(parsed.socialEnvironment.feedAlgorithm?.versionRef, "feed-algorithm:research:123");
});

test("Financial selects a published Market Maker and rejects the retired liquidity policy", () => {
  const specification = validSpecification();
  (specification.financialMarket as Record<string, unknown>).marketMaker = {
    versionRef: "market-maker:baseline:1",
    initialStatePresetVersionRef: "financial-preset:maker:1",
    timing: "opening",
    config: { spreadBps: 20 },
  };
  const parsed = specificationSchema.parse(specification);
  assert.deepEqual(parsed.financialMarket.marketMaker, {
    versionRef: "market-maker:baseline:1",
    initialStatePresetVersionRef: "financial-preset:maker:1",
    timing: "opening",
    config: { spreadBps: 20 },
  });
  const incremental = validSpecification();
  (incremental.financialMarket as Record<string, unknown>).marketMaker = {
    versionRef: "market-maker:inventory-ladder:1",
    initialStatePresetVersionRef: "financial-preset:maker:1",
    timing: "opening",
    matchingPolicy: "incremental",
    requotePolicy: "after_each_trade",
    maxRequotesPerIntent: 100,
    config: {},
  };
  assert.equal(specificationSchema.parse(incremental).financialMarket.marketMaker?.requotePolicy, "after_each_trade");
  ((incremental.financialMarket as Record<string, unknown>).marketMaker as Record<string, unknown>).matchingPolicy = "batch";
  assert.throws(() => specificationSchema.parse(incremental), /after_each_trade requires incremental matching/);

  const retired = validSpecification();
  (retired.financialMarket as Record<string, unknown>).liquidityPolicy = { enabled: false };
  assert.throws(() => specificationSchema.parse(retired));

});

test("Financial instruments accept decimal ticks and reject off-tick references", () => {
  const specification = validSpecification();
  (specification.financialMarket as Record<string, unknown>).instruments = [{ symbol: "LEEK", referencePrice: 100.05, tickSize: 0.05 }];
  assert.equal(specificationSchema.parse(specification).financialMarket.instruments[0]?.tickSize, 0.05);
  (specification.financialMarket as Record<string, unknown>).instruments = [{ symbol: "LEEK", referencePrice: 100.06, tickSize: 0.05 }];
  assert.throws(() => specificationSchema.parse(specification), /tickSize 0.05/);
});

test("a fork can override arbitrary Context configurations without a fixed adapter", () => {
  const base = {
    mutation: { transitionId: "fork", stepId: "fork", payloadDigest: digest, expectedCheckpointRef: "manifest:source" },
    sourceRunId: "run:source",
    sourceManifestRef: "manifest:source",
  };
  assert.deepEqual(forkRunInputSchema.parse(base).contextConfigurations, {});
  assert.deepEqual(forkRunInputSchema.parse({
    ...base,
    contextConfigurations: { weather: { climate: "dry" } },
  }).contextConfigurations, { weather: { climate: "dry" } });
});

test("v5 rejects a caller-supplied principal because Experiment owns run identity", () => {
  const withPrincipal = validSpecification();
  (withPrincipal.agentExecution as Record<string, unknown>).principalId = "principal:caller-supplied";
  assert.throws(() => createRunInputSchema.parse({
    mutation: { transitionId: "t", stepId: "create", payloadDigest: digest, expectedCheckpointRef: "" },
    specification: withPrincipal,
  }));
});

test("public specifications reject legacy prompts, OpenAI backend, and market-maker agents", () => {
  const legacyPrompt = validSpecification();
  (legacyPrompt.agentExecution as Record<string, unknown>).agents = [{ systemPrompt: "legacy" }];
  assert.throws(() => createRunInputSchema.parse({ mutation: { transitionId: "t", stepId: "create", payloadDigest: digest, expectedCheckpointRef: "" }, specification: legacyPrompt }));
  const openai = validSpecification();
  (openai.agentExecution as Record<string, unknown>).backend = "openai";
  assert.throws(() => createRunInputSchema.parse({ mutation: { transitionId: "t", stepId: "create", payloadDigest: digest, expectedCheckpointRef: "" }, specification: openai }));
  const maker = validSpecification();
  (maker.agentExecution as Record<string, unknown>).agents = [{ type: "market_maker" }];
  assert.throws(() => createRunInputSchema.parse({ mutation: { transitionId: "t", stepId: "create", payloadDigest: digest, expectedCheckpointRef: "" }, specification: maker }));
});
