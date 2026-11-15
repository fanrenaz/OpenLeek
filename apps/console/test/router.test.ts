import assert from "node:assert/strict";
import test from "node:test";
import { sha256Digest } from "@openleek/contracts/canonical";
import { createConsoleRouter } from "../src/server/router.js";
import type { ConsolePorts } from "../src/server/ports.js";
import { llmConfigurationDataDictionary } from "../src/server/llm-configuration-projection.js";

const specification = {
  schemaVersion: "3" as const, seed: 1, roundCount: 1,
  clock: { startUnixSeconds: 0, stepSeconds: 60 },
  executionPolicy: { automaticRetryMaxAttempts: 1, automaticRetryBackoffMs: 1 },
  initialWorld: { worldName: "test", scenarioVersion: "1", nameTheme: "research-codes-v1" as const, population: { versionRef: "population:v1" } },
  turnPrompt: { versionRef: "turn-prompt:test:v1", variables: {} },
  agentExecution: { maxConcurrentAgents: 1 },
  researchTemplate: { versionRef: "research-template:tri-context:v1" },
  contexts: {
    social: { installationRef: "context-installation:social:builtin", descriptorRevision: "social-context:v3", configuration: { exposurePolicy: "recommendation_only" } },
    financial: { installationRef: "context-installation:financial:builtin", descriptorRevision: "financial-context:v3", configuration: { instruments: [{ symbol: "LEEK", referencePrice: 1 }] } },
    news: { installationRef: "context-installation:news:builtin", descriptorRevision: "news-context:v4", configuration: { scenarioVersionRef: "news-scenario:reference:v:acebaea778d02a4f" } },
  },
};
const digest = "a".repeat(64);
const committedManifest = {
  schemaVersion: "3" as const, ref: "manifest:committed", runId: "run:1", roundId: 1, state: "committed" as const, digest,
  agentExecution: { ref: "agent:1", runId: "run:1", roundId: 1, digest },
  contexts: { social: { ref: "social:1", context: "social", runId: "run:1", roundId: 1, digest }, financial: { ref: "market:1", context: "financial", runId: "run:1", roundId: 1, digest } },
};
const llmGraph = {
  revision: "revision:llm:1",
  resources: [
    { kind: "defaults", id: "main", label: "Defaults", value: { model: "memory-model", max_tokens: 8192 }, schema: { fields: [] } },
    { kind: "provider", id: "upstream", label: "upstream", value: { base_url: "https://provider.example/v1", api_key: "super-secret-api-key" }, schema: { fields: [{ path: "api_key", secret: true }] } },
  ],
};
function llmPorts(overrides: Partial<Pick<ConsolePorts, "llmConfigGraph" | "llmConfigValidate" | "llmConfigPatch" | "llmConfigCreateResource" | "llmConfigDeleteResource">> = {}) {
  return {
    async llmConfigGraph() { return llmGraph; },
    async llmConfigValidate() { return { result: "committed", revision: "revision:llm:1", graph: llmGraph }; },
    async llmConfigPatch() { return { result: "committed", revision: "revision:llm:2", graph: llmGraph }; },
    async llmConfigCreateResource() { return { result: "committed", revision: "revision:llm:2", graph: llmGraph }; },
    async llmConfigDeleteResource() { return { result: "committed", revision: "revision:llm:2", graph: llmGraph }; },
    ...overrides,
  };
}

function dictionaryCatalog(exampleValue: unknown = { name: "cohort-a" }) {
  return {
    schemaVersion: "1" as const,
    sources: [{
      ownerId: "experiment",
      owner: { default: "Experiment", translations: { zh: "实验" } },
      available: true,
      revision: "dictionary-v1",
      entries: [{
        schemaVersion: "1" as const,
        id: "population",
        ownerId: "experiment",
        categoryId: "experiment",
        entryKind: "asset" as const,
        management: {
          surface: "asset-library" as const,
          key: "population",
          idField: "populationId",
          capabilities: ["list", "read", "save-draft", "publish", "delete-draft", "delete-version"] as const,
        },
        label: { default: "Population", translations: { zh: "人群" } },
        description: { default: "A published population.", translations: {} },
        definitionSchema: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string" } },
          additionalProperties: false,
        },
        references: [],
        examples: [{
          title: { default: "Minimal", translations: {} },
          value: exampleValue,
        }],
      }],
    }],
  };
}

test("Console publishes the owner-provided data dictionary after validating its examples", async () => {
  const ports = {
    async dataDictionaryCatalog() { return dictionaryCatalog(); },
  } as unknown as ConsolePorts;
  const catalog = await createConsoleRouter(ports).createCaller({}).console.dataDictionary.catalog({});
  assert.equal(catalog.sources[0]?.entries[0]?.id, "population");
  assert.equal(catalog.sources[0]?.available, true);
  assert.deepEqual(catalog.sources[0]?.entries[0]?.management.capabilities, ["list", "read", "save-draft", "publish", "delete-draft", "delete-version"]);
});

test("Console composes a redacted LLM Configuration dictionary source at the live revision", () => {
  const source = llmConfigurationDataDictionary(llmGraph);
  assert.equal(source.revision, "revision:llm:1");
  assert.deepEqual(source.entries.map(({ id }) => id), ["llm-configuration-config-graph", "llm-configuration-model-capability"]);
  assert.doesNotMatch(JSON.stringify(source), /super-secret-api-key/);
  assert.ok(source.entries[0]?.management.capabilities.includes("delete-resource"));
});

test("Console rejects a data dictionary example that violates its published schema", async () => {
  const ports = {
    async dataDictionaryCatalog() { return dictionaryCatalog({ name: 42 }); },
  } as unknown as ConsolePorts;
  await assert.rejects(
    createConsoleRouter(ports).createCaller({}).console.dataDictionary.catalog({}),
    /Data dictionary example is invalid for population/,
  );
});

test("Console creates an Experiment mutation with a canonical payload digest", async () => {
  let createInput: Record<string, unknown> | undefined;
  const ports: ConsolePorts = {
    async listRuns() { return { runs: [] }; }, async validateSpecification() { return {}; },
    async createRun(input) { createInput = input as Record<string, unknown>; return { runId: "run:create" }; },
    async command() { return {}; }, async fork() { return {}; }, async getRun() { return {}; }, async roundProgress() { return undefined; }, async committedRounds() { return { items: [] }; }, async committedManifest() { return { ref: "manifest:1" }; }, async agentRegistrations() { return { registrations: [] }; },
    async committedFacts() { return { facts: [] }; }, async agentRuntimeEvidence() { return {}; }, async agentRuntimeCapability() { return { model: "seed-model" }; },
    ...llmPorts(),
  };
  const caller = createConsoleRouter(ports).createCaller({});
  await caller.console.createRun({ idempotencyKey: "create", specification });
  const mutation = createInput?.mutation as Record<string, unknown>;
  const createdSpecification = createInput?.specification as Record<string, unknown>;
  const createdAgentExecution = createdSpecification.agentExecution as Record<string, unknown>;
  assert.equal(mutation.expectedCheckpointRef, "");
  assert.equal(createdAgentExecution.model, undefined);
  assert.equal(mutation.payloadDigest, sha256Digest(createdSpecification));
  assert.deepEqual(await caller.console.runtimeCapability({}), {
    model: "seed-model",
    revision: "revision:llm:1",
    memoryRoute: "memory",
  });
});

test("Console combines only committed Context facts selected by a committed manifest", async () => {
  const calls: string[] = [];
  const ports: ConsolePorts = {
    async listRuns() { return {}; }, async validateSpecification() { return {}; }, async createRun() { return {}; }, async command() { return {}; }, async fork() { return {}; }, async getRun() { return {}; }, async roundProgress() { return undefined; }, async committedRounds() { return {}; }, async agentRegistrations() { return { registrations: [] }; },
    async committedManifest() { return committedManifest; },
    async committedFacts(name, input) { calls.push(`${name}:${JSON.stringify(input)}`); return { facts: [] }; }, async agentRuntimeEvidence() { return {}; }, async agentRuntimeCapability() { return { model: "seed-model" }; },
    ...llmPorts(),
  };
  const caller = createConsoleRouter(ports).createCaller({});
  const facts = await caller.console.facts({ runId: "run:1", limit: 10 });
  assert.equal((facts as { manifest: { ref: string } }).manifest.ref, "manifest:committed");
  assert.deepEqual(calls, ["agentExecution:{\"runId\":\"run:1\",\"limit\":10}"]);
  assert.deepEqual((facts as { contexts: unknown }).contexts, committedManifest.contexts);
});

test("Console forwards the work-pool progress view without reading Context facts", async () => {
  const progress = { snapshotDigest: digest, state: "running", queued: 1, running: 1, succeeded: 0, failed: 0 };
  const ports: ConsolePorts = {
    async listRuns() { return {}; }, async validateSpecification() { return {}; }, async createRun() { return {}; }, async command() { return {}; }, async fork() { return {}; }, async getRun() { return {}; }, async agentRegistrations() { return { registrations: [] }; },
    async roundProgress(input) { assert.deepEqual(input, { runId: "run:1" }); return progress; }, async committedRounds() { return {}; }, async committedManifest() { return committedManifest; },
    async committedFacts() { return {}; }, async agentRuntimeEvidence() { return {}; }, async agentRuntimeCapability() { return { model: "seed-model" }; },
    ...llmPorts(),
  };
  const caller = createConsoleRouter(ports).createCaller({});
  assert.deepEqual(await caller.console.roundProgress({ runId: "run:1" }), progress);
});

test("Console forwards Run Codex Hook policy reads and revision-checked updates", async () => {
  const calls: unknown[] = [];
  const ports = {
    async agentHookPolicy(input: unknown) {
      calls.push(["get", input]);
      return { strategyInjectionEnabled: true, revision: 1, updatedAt: "2026-07-31T00:00:00.000Z" };
    },
    async updateAgentHookPolicy(input: unknown) {
      calls.push(["update", input]);
      return { policy: { strategyInjectionEnabled: false, revision: 2, updatedAt: "2026-07-31T01:00:00.000Z" }, replayed: false };
    },
  } as unknown as ConsolePorts;
  const caller = createConsoleRouter(ports).createCaller({});
  assert.equal((await caller.console.hookPolicy({ runId: "run:hook" })).revision, 1);
  const updated = await caller.console.updateHookPolicy({
    runId: "run:hook",
    strategyInjectionEnabled: false,
    expectedRevision: 1,
    idempotencyKey: "hook-policy-update",
  });
  assert.equal((updated as { policy: { revision: number } }).policy.revision, 2);
  assert.deepEqual(calls, [
    ["get", { runId: "run:hook" }],
    ["update", {
      runId: "run:hook",
      strategyInjectionEnabled: false,
      expectedRevision: 1,
      idempotencyKey: "hook-policy-update",
    }],
  ]);
});

test("Console audit exposes registrations and only the no-secret sandbox lifecycle summary", async () => {
  const registrations = {
    registrations: [{
      principalId: "principal:run:1:a",
      runId: "run:1",
      agentId: "a",
      credentialVersion: 1,
      status: "active",
      registeredAt: "2026-07-19T00:00:00.000Z",
    }],
  };
  const ports: ConsolePorts = {
    async listRuns() { return {}; }, async validateSpecification() { return {}; }, async createRun() { return {}; }, async command() { return {}; }, async fork() { return {}; },
    async getRun() { return { status: "running" }; }, async roundProgress() { return undefined; }, async committedRounds() { return {}; }, async committedManifest() { return {}; },
    async committedFacts() { return {}; },
    async agentRuntimeEvidence() {
      return {
        conditionDigest: digest,
        modelConfiguration: { model: "deepseek-v4-flash", configDigest: "b".repeat(64) },
        instructionPolicy: { version: "openleek-codex-runtime/v1", baseInstructionsDigest: "c".repeat(64), environmentContextDigest: "d".repeat(64), nativeEnvironmentContext: false, hostCurrentDateExposed: false },
        contextCompaction: {
          policy: {
            mode: "auto",
            tokenLimit: 128_000,
            scope: "body_after_prefix",
            prompt: "codex-default",
          },
          events: [{
            runId: "run:1",
            roundId: 2,
            agentId: "agent:1",
            threadId: "thread:1",
            turnId: "turn:2",
            itemId: "compaction:1",
            trigger: "auto",
            completedAt: "2026-07-19T00:01:00.000Z",
          }],
        },
        instructionPolicyMigrations: [],
        sandbox: {
          state: "active",
          restartCount: 2,
          createdAt: "2026-07-19T00:00:00.000Z",
          containerId: "container-secret",
          containerName: "agent-secret",
          endpoint: "ws://internal-secret",
          network: "sandbox-mesh",
          image: "private/image",
          hostRunRoot: "/private/run",
          workspacePath: "/private/workspace",
          capabilityToken: "do-not-expose",
        },
      };
    },
    async agentRuntimeCapability() { return { model: "seed-model" }; },
    async agentRegistrations(input) { assert.deepEqual(input, { runId: "run:1" }); return registrations; },
    ...llmPorts(),
  };
  const caller = createConsoleRouter(ports).createCaller({});
  const audit = await caller.console.audit({ runId: "run:1" }) as { registrations: typeof registrations; agentExecution: { sandbox?: unknown; modelConfiguration?: unknown; instructionPolicy?: unknown; contextCompaction?: unknown } };
  assert.deepEqual(audit.registrations, registrations);
  assert.deepEqual(audit.agentExecution.modelConfiguration, { model: "deepseek-v4-flash", configDigest: "b".repeat(64) });
  assert.deepEqual(audit.agentExecution.instructionPolicy, { version: "openleek-codex-runtime/v1", baseInstructionsDigest: "c".repeat(64), environmentContextDigest: "d".repeat(64), nativeEnvironmentContext: false, hostCurrentDateExposed: false });
  assert.deepEqual(audit.agentExecution.contextCompaction, {
    policy: { mode: "auto", tokenLimit: 128_000, scope: "body_after_prefix", prompt: "codex-default" },
    events: [{
      runId: "run:1",
      roundId: 2,
      agentId: "agent:1",
      threadId: "thread:1",
      turnId: "turn:2",
      itemId: "compaction:1",
      trigger: "auto",
      completedAt: "2026-07-19T00:01:00.000Z",
    }],
  });
  assert.deepEqual(audit.agentExecution.sandbox, { state: "active", restartCount: 2, createdAt: "2026-07-19T00:00:00.000Z" });
  assert.doesNotMatch(JSON.stringify(audit), /credential"\s*:/i);
  assert.doesNotMatch(JSON.stringify(audit), /container-secret|agent-secret|internal-secret|sandbox-mesh|private\/image|private\/run|private\/workspace|do-not-expose/);
});

test("Console returns a schema graph with secrets redacted and forwards graph mutations only through its BFF port", async () => {
  const received: unknown[] = [];
  const ports: ConsolePorts = {
    async listRuns() { return {}; }, async validateSpecification() { return {}; }, async createRun() { return {}; }, async command() { return {}; }, async fork() { return {}; }, async getRun() { return {}; }, async roundProgress() { return {}; }, async committedRounds() { return {}; }, async committedManifest() { return {}; }, async agentRegistrations() { return {}; }, async committedFacts() { return {}; }, async agentRuntimeEvidence() { return {}; }, async agentRuntimeCapability() { return {}; },
    ...llmPorts({
      async llmConfigValidate(input) { received.push(input); return { result: "committed", revision: "revision:llm:1", graph: llmGraph }; },
      async llmConfigPatch(input) { received.push(input); return { result: "committed", revision: "revision:llm:2", graph: llmGraph }; },
    }),
  };
  const caller = createConsoleRouter(ports).createCaller({});
  const graph = await caller.console.llmConfiguration.graph({});
  assert.doesNotMatch(JSON.stringify(graph), /super-secret-api-key/);
  assert.match(JSON.stringify(graph), /\*\*\*\*\*\*/);
  const update = { baseRevision: "revision:llm:1", changes: [{ kind: "provider", id: "upstream", field: "api_key", value: "replacement-secret" }] };
  const validation = await caller.console.llmConfiguration.validate(update);
  const saved = await caller.console.llmConfiguration.patch(update);
  assert.equal((validation as { result: string }).result, "committed");
  assert.equal((saved as { result: string }).result, "committed");
  assert.equal(received.length, 2);
  assert.doesNotMatch(JSON.stringify(saved), /super-secret-api-key|replacement-secret/);
});

test("Console projects revision conflicts without exposing an LLM provider secret", async () => {
  const ports: ConsolePorts = {
    async listRuns() { return {}; }, async validateSpecification() { return {}; }, async createRun() { return {}; }, async command() { return {}; }, async fork() { return {}; }, async getRun() { return {}; }, async roundProgress() { return {}; }, async committedRounds() { return {}; }, async committedManifest() { return {}; }, async agentRegistrations() { return {}; }, async committedFacts() { return {}; }, async agentRuntimeEvidence() { return {}; }, async agentRuntimeCapability() { return {}; },
    ...llmPorts({
      async llmConfigPatch() { return { result: "revisionConflict", revision: "revision:llm:2", errors: [{ field: "api_key", message: "provider changed" }], api_key: "never-return-this" }; },
    }),
  };
  const caller = createConsoleRouter(ports).createCaller({});
  const result = await caller.console.llmConfiguration.patch({ baseRevision: "revision:llm:1", changes: [{ kind: "provider", id: "upstream", field: "base_url", value: "https://next.example/v1" }] });
  assert.deepEqual(result, { result: "revisionConflict", revision: "revision:llm:2", errors: [{ field: "api_key", message: "provider changed" }], api_key: "******" });
  assert.doesNotMatch(JSON.stringify(result), /never-return-this/);
});

test("Console keeps the Financial-owned market-maker library while fork overrides are Context-generic", async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  let forkInput: Record<string, unknown> | undefined;
  const ports: ConsolePorts = {
    async listRuns() { return {}; }, async validateSpecification() { return {}; }, async createRun() { return {}; },
    async command() { return {}; }, async getRun() { return {}; }, async roundProgress() { return {}; }, async committedRounds() { return {}; }, async committedManifest() { return {}; }, async agentRegistrations() { return {}; }, async committedFacts() { return {}; }, async agentRuntimeEvidence() { return {}; }, async agentRuntimeCapability() { return {}; },
    async fork(input) { forkInput = input as Record<string, unknown>; return { runId: "run:fork" }; },
    async marketMakers() { calls.push({ name: "list", input: undefined }); return { drafts: [], versions: [] }; },
    async marketMakerDraft(input) { calls.push({ name: "draft", input }); return {}; },
    async marketMakerVersion(input) { calls.push({ name: "version", input }); return {}; },
    async saveMarketMakerDraft(input) { calls.push({ name: "save", input }); return { algorithmId: "maker:1" }; },
    async validateMarketMaker(input) { calls.push({ name: "validate", input }); return { valid: true }; },
    async publishMarketMaker(input) { calls.push({ name: "publish", input }); return {}; },
    async previewMarketMaker(input) { calls.push({ name: "preview", input }); return { quotes: [] }; },
    ...llmPorts(),
  };
  const caller = createConsoleRouter(ports).createCaller({});
  assert.deepEqual(await caller.console.marketMakers.list({}), { drafts: [], versions: [] });
  await caller.console.marketMakers.saveDraft({ name: "maker", source: "class MarketMaker: pass", defaultConfig: {}, dependencies: [], limits: { maxRuntimeMs: 1_000, maxMemoryMb: 64 } });
  const contextConfigurations = { financial: { marketMaker: null }, weather: { station: "north" } };
  await caller.console.fork({ runId: "run:1", expectedManifestRef: "manifest:1", sourceManifestRef: "manifest:1", idempotencyKey: "fork-contexts", contextConfigurations });
  assert.equal(calls[0]?.name, "list");
  assert.equal(calls[1]?.name, "save");
  assert.deepEqual(forkInput?.contextConfigurations, contextConfigurations);
  assert.equal((forkInput?.mutation as { payloadDigest?: string }).payloadDigest, sha256Digest({ sourceRunId: "run:1", sourceManifestRef: "manifest:1", contextConfigurations }));
});

test("Console composes MCP Policy and Skill assets into an Agent Blueprint", async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const ports: ConsolePorts = {
    async listRuns() { return {}; }, async validateSpecification() { return {}; }, async createRun() { return {}; },
    async command() { return {}; }, async fork() { return {}; }, async getRun() { return {}; }, async roundProgress() { return {}; },
    async committedRounds() { return {}; }, async committedManifest() { return {}; }, async agentRegistrations() { return {}; },
    async committedFacts() { return {}; }, async agentRuntimeEvidence() { return {}; }, async agentRuntimeCapability() { return {}; },
    async mcpPolicies() { calls.push({ name: "list", input: undefined }); return { drafts: [], versions: [] }; },
    async saveMcpPolicyDraft(input) { calls.push({ name: "savePolicy", input }); return { policyId: "policy:1", revision: 1 }; },
    async skills() { calls.push({ name: "listSkills", input: undefined }); return { drafts: [], versions: [] }; },
    async saveSkillDraft(input) { calls.push({ name: "saveSkill", input }); return { skillId: "skill:1", revision: 1 }; },
    async saveAgentBlueprintDraft(input) { calls.push({ name: "saveBlueprint", input }); return { blueprintId: "blueprint:1", revision: 1 }; },
    ...llmPorts(),
  };
  const caller = createConsoleRouter(ports).createCaller({});
  assert.deepEqual(await caller.console.mcpPolicies.list({}), { drafts: [], versions: [] });
  await caller.console.mcpPolicies.saveDraft({
    name: "Social reader",
    tools: ["social.engage"],
    resources: ["social.feed", "social.profile"],
  });
  assert.deepEqual(await caller.console.skills.list({}), { drafts: [], versions: [] });
  await caller.console.skills.saveDraft({
    name: "Social research",
    files: [{ path: "SKILL.md", encoding: "utf8", content: "---\nname: social-research\ndescription: Research social state.\n---\n", executable: false }],
    requirements: { tools: [], resources: ["social.feed"] },
  });
  await caller.console.agentBlueprints.saveDraft({
    name: "Reader",
    definition: {
      agentsMdVersionRef: "agents-md:reader:v1",
      mcpPolicyVersionRef: "mcp-policy:reader:v1",
      skillVersionRefs: ["skill:social-research:v1"],
    },
  });
  await assert.rejects(
    caller.console.agentBlueprints.saveDraft({
      name: "Legacy reader",
      definition: { agentsMdVersionRef: "agents-md:reader:v1" },
    } as never),
  );
  assert.deepEqual(calls.map(({ name }) => name), ["list", "savePolicy", "listSkills", "saveSkill", "saveBlueprint"]);
});
