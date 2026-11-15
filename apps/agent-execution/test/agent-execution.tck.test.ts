import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { codexThreadInstructionParams, goalContinuationTurnIds, isCompletedTerminalTurn, isThreadMaterializingError, serverRequestResult, TurnTokenCollector } from "../src/backends/codex-app-server.js";
import { CodexAgentBackend, type CodexTurnClient } from "../src/backends/codex.js";
import { AgentExecutionError } from "../src/errors.js";
import { deepSeekCodexProfile, DEEPSEEK_MODEL } from "../src/deepseek-codex.js";
import type { AgentExecutionBackend, AgentExecutionSnapshot, AgentExecutionStateStore, BackendExecutionInput } from "../src/ports.js";
import { CODEX_SANDBOX_SECURITY_OPTIONS, DockerSandboxManager, InMemorySandboxManager, type DockerEngine, type SandboxEnsureInput } from "../src/sandbox.js";
import { createAgentExecutionRuntime } from "../src/server/runtime.js";
import { AgentExecutionService } from "../src/service.js";
import { InMemoryAgentExecutionStateStore } from "../src/state-store.js";
import { OPENLEEK_BASE_INSTRUCTIONS, OPENLEEK_CONTEXT_COMPACTION_POLICY, OPENLEEK_INSTRUCTION_POLICY_VERSION } from "../src/runtime-instructions.js";
import { createAgentExecutionRouter } from "../src/router.js";
import { agentDirectoryName, runDirectoryName } from "../src/workspace-artifacts.js";
import type { ContextMcpConnection } from "../src/types.js";
import { createAgentSessionTranscript } from "../src/transcript.js";

const digest = (letter: string) => letter.repeat(64);
const defaultTurnPrompt = { versionRef: "turn-prompt:system-default:v1", artifactDigest: digest("a"), source: "Today is {{utcDate}}.", variables: {} };
const condition = {
  identity: { displayName: "Retail One" }, initialMemory: "Prefer evidence before a trade.",
  phenotype: { riskTolerance: "moderate", holdingHorizon: "swing", evidenceStyle: "market data", executionStyle: "limit", beliefStyle: "probabilistic", socialStyle: "thoughtful", tradingPurpose: "capital preservation", socialPurpose: "share research", preferences: ["LEEK"] },
  permissions: { canTrade: true, canSocial: true, allowShort: false, allowLeverage: false, maxTradeActionsPerRound: 3, maxSocialActionsPerRound: 5 },
} as const;
const section = {
  marketNarrative: "LEEK is a public-network token.",
  agents: [{ agentId: "retail-1", actorId: "retail-1", accountId: "account-1", type: "retail_investor" as const, condition }],
};

test("opens without injecting selectable assets into an empty library", async () => {
  const store = new InMemoryAgentExecutionStateStore();
  const service = await AgentExecutionService.open(noopBackend(), store, {});
  assert.deepEqual(service.listAgentsMd(), { drafts: [], versions: [] });
  assert.deepEqual(service.listMcpPolicies(), { drafts: [], versions: [] });
  assert.deepEqual(service.listSkills(), { drafts: [], versions: [] });
  assert.equal(await store.load(), null);
});

test("AGENTS.md deletion is revision-checked, idempotent, hidden by default, and retained for audit", async () => {
  const service = await AgentExecutionService.open(noopBackend(), new InMemoryAgentExecutionStateStore(), {});
  const draft = await service.saveAgentsMdDraft({ templateId: "agents-md:delete-test", name: "Delete test", source: "# Retained\n" });
  await assert.rejects(
    service.deleteAgentsMdDraft({ templateId: draft.templateId, expectedRevision: draft.revision + 1, idempotencyKey: "delete-draft-wrong" }),
    code("PRECONDITION_FAILED"),
  );
  const deletedDraft = await service.deleteAgentsMdDraft({ templateId: draft.templateId, expectedRevision: draft.revision, idempotencyKey: "delete-draft" });
  assert.equal(deletedDraft.status, "deleted");
  assert.equal((await service.deleteAgentsMdDraft({ templateId: draft.templateId, expectedRevision: draft.revision, idempotencyKey: "delete-draft" })).replayed, true);
  assert.equal((await service.deleteAgentsMdDraft({ templateId: draft.templateId, expectedRevision: draft.revision, idempotencyKey: "delete-draft-again" })).replayed, false);
  assert.equal(service.listAgentsMd().drafts.length, 0);
  assert.equal(service.listAgentsMd(true).drafts[0]?.templateId, draft.templateId);
  assert.equal(service.getAgentsMdDraft(draft.templateId, true).source, draft.source);
  await assert.rejects(service.saveAgentsMdDraft({ templateId: draft.templateId, name: draft.name, source: draft.source }), code("PRECONDITION_FAILED"));

  const publishDraft = await service.saveAgentsMdDraft({ templateId: "agents-md:version-delete-test", name: "Version delete test", source: "# Immutable\n" });
  const version = await service.publishAgentsMd({ templateId: publishDraft.templateId, expectedRevision: publishDraft.revision });
  assert.equal((await service.deleteAgentsMdVersion({ versionRef: version.versionRef, idempotencyKey: "delete-version" })).status, "deleted");
  assert.throws(() => service.getAgentsMdVersion(version.versionRef), code("PRECONDITION_FAILED"));
  assert.equal(service.getAgentsMdVersion(version.versionRef, true).artifactDigest, version.artifactDigest);
  assert.equal(service.listAgentsMd().versions.length, 0);
  assert.equal(service.listAgentsMd(true).versions[0]?.versionRef, version.versionRef);
  await assert.rejects(service.publishAgentsMd({ templateId: publishDraft.templateId, expectedRevision: publishDraft.revision }), code("PRECONDITION_FAILED"));
});
const mutation = (stepId: string, expectedCheckpointRef: string) => ({ transitionId: `transition:${stepId}`, stepId, payloadDigest: digest("a"), expectedCheckpointRef });
const mcp = (credential = "experiment-issued-signed-run-credential-for-context-mcp") => [
  { context: "social" as const, agentId: "retail-1", principalId: "principal:run:retail-1", endpoint: "http://127.0.0.1:3106/internal/mcp", credential },
  { context: "financial" as const, agentId: "retail-1", principalId: "principal:run:retail-1", endpoint: "http://127.0.0.1:3107/internal/mcp", credential: `${credential}-financial` },
];
const publishedTemplates = new WeakMap<AgentExecutionService, Promise<string>>();
async function templateVersion(service: AgentExecutionService): Promise<string> {
  let version = publishedTemplates.get(service);
  if (!version) {
    version = (async () => {
      const draft = await service.saveAgentsMdDraft({ name: "Raw test AGENTS", source: "# Raw test AGENTS\n\nUse the MCP servers available in this workspace.\n" });
      return (await service.publishAgentsMd({ templateId: draft.templateId, expectedRevision: draft.revision })).versionRef;
    })();
    publishedTemplates.set(service, version);
  }
  return version;
}
async function initialize(
  service: AgentExecutionService,
  runId: string,
  legacy: { agents: readonly { agentId: string; actorId: string; accountId: string }[] },
  header: ReturnType<typeof mutation>,
  connections: readonly ContextMcpConnection[],
) {
  const agentsMdVersionRef = await templateVersion(service);
  return service.initialize(runId, {
    section: { maxConcurrentAgents: 10 },
    turnPrompt: defaultTurnPrompt,
    agents: legacy.agents.map((agent) => ({ ...agent, agentsMdVersionRef, mcpContexts: ["social", "financial"] as const })),
  }, header, connections);
}

test("workspace contains the published raw AGENTS.md artifact without core interpolation", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "openleek-workspace-"));
  try {
    const service = await AgentExecutionService.open(noopBackend(), new InMemoryAgentExecutionStateStore(), { workspaceRoot });
    await assert.rejects(service.saveSkillDraft({
      name: "Unsafe",
      files: [
        { path: "SKILL.md", encoding: "utf8", executable: false, content: "---\nname: unsafe\ndescription: Unsafe fixture.\n---\n" },
        { path: "../escape.sh", encoding: "utf8", executable: true, content: "exit 0\n" },
      ],
      requirements: { tools: [], resources: [] },
    }), code("INVALID_ARGUMENT"));
    await assert.rejects(service.saveSkillDraft({
      name: "External MCP",
      files: [
        { path: "SKILL.md", encoding: "utf8", executable: false, content: "---\nname: external\ndescription: External fixture.\n---\n" },
        { path: "agents/openai.yaml", encoding: "utf8", executable: false, content: "dependencies:\n  tools:\n    - type: mcp\n      value: github\n" },
      ],
      requirements: { tools: [], resources: [] },
    }), code("INVALID_ARGUMENT"));
    const credential = "experiment-issued-signed-run-credential-for-context-mcp";
    await initialize(service, "run-static", section, mutation("initialize", ""), mcp(credential));
    const evidence = await service.runtimeEvidence("run-static");
    const artifact = evidence.artifacts[0];
    assert.ok(artifact);
    const workspace = runWorkspace(workspaceRoot, "run-static", "retail-1");
    const agentsMd = await readFile(join(workspace, "AGENTS.md"), "utf8");
    const config = await readFile(join(workspace, ".codex", "config.toml"), "utf8");
    const catalogPath = join(workspaceRoot, runDirectoryName("run-static"), "codex-home", "models.json");
    const homeConfigPath = join(workspaceRoot, runDirectoryName("run-static"), "codex-home", "config.toml");
    await access(catalogPath);
    const homeConfig = await readFile(homeConfigPath, "utf8");
    assert.match(homeConfig, /\[model_providers\.deepseek\]/);
    assert.match(homeConfig, /^base_url = "https:\/\/api\.deepseek\.com\/"$/m);
    assert.match(homeConfig, /^wire_api = "responses"$/m);
    assert.match(homeConfig, /^env_key = "DEEPSEEK_API_KEY"$/m);
    assert.match(homeConfig, /^allow_login_shell = false$/m);
    assert.match(homeConfig, /^web_search = "disabled"$/m);
    assert.match(homeConfig, /\[agents\]\nenabled = false/);
    assert.match(homeConfig, /\[features\]\ngoals = false\nmulti_agent = false\nshell_snapshot = false/);
    assert.match(homeConfig, /\[tools\.experimental_request_user_input\]\nenabled = false/);
    assert.match(homeConfig, /\[tools\.update_plan\]\nenabled = false/);
    assert.match(homeConfig, /\[shell_environment_policy\]\nexclude = \["DEEPSEEK_API_KEY"\]/);
    assert.doesNotMatch(homeConfig, /deployment-deepseek-secret/);
    assert.equal(agentsMd, "# Raw test AGENTS\n\nUse the MCP servers available in this workspace.\n");
    assert.doesNotMatch(agentsMd, /Retail One|Prefer evidence|cash: 100|followerCount/);
    assert.match(config, /^model = "deepseek-v4-flash"$/m); assert.match(config, /\[model_providers\.deepseek\]/); assert.match(config, /model_catalog_json = "~\/\.codex\/models\.json"/m); assert.match(config, /\[mcp_servers\.social\]/); assert.match(config, /url = "http:\/\/127\.0\.0\.1:3106\/internal\/mcp"/);
    assert.match(config, /^include_environment_context = false$/m);
    assert.match(config, /^allow_login_shell = false$/m);
    assert.match(config, /^web_search = "disabled"$/m);
    assert.match(config, /\[agents\]\nenabled = false/);
    assert.match(config, /\[features\]\ngoals = false\nmulti_agent = false\nshell_snapshot = false/);
    assert.match(config, /\[tools\.experimental_request_user_input\]\nenabled = false/);
    assert.match(config, /\[tools\.update_plan\]\nenabled = false/);
    assert.match(config, /^model_auto_compact_token_limit = 64000$/m);
    assert.match(config, /^model_auto_compact_token_limit_scope = "total"$/m);
    assert.match(config, /\[shell_environment_policy\]\nexclude = \["DEEPSEEK_API_KEY"\]/);
    assert.ok(config.indexOf("include_environment_context") < config.indexOf("[model_providers.deepseek]"));
    assert.match(config, /\[mcp_servers\.financial\]/); assert.match(config, /url = "http:\/\/127\.0\.0\.1:3107\/internal\/mcp"/);
    assert.match(config, new RegExp(`Authorization.*Bearer ${credential}`)); assert.doesNotMatch(config, /x-openleek-capability/); assert.equal(evidence.staticArtifactDigest.length, 64);
    const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as { models: Array<Record<string, unknown>> };
    assert.deepEqual(catalog, JSON.parse(deepSeekCodexProfile().modelsJson));
    assert.equal(catalog.models[0]?.context_window, 1_000_000);
    assert.equal(catalog.models[0]?.max_output_tokens, 384_000);
    assert.equal(catalog.models[0]?.supports_parallel_tool_calls, true);
    assert.equal(catalog.models[0]?.apply_patch_tool_type, null);
    assert.deepEqual(evidence.modelConfiguration, { model: DEEPSEEK_MODEL, configDigest: deepSeekCodexProfile().configDigest });
    assert.equal(evidence.instructionPolicy.version, OPENLEEK_INSTRUCTION_POLICY_VERSION);
    assert.equal(evidence.instructionPolicy.nativeEnvironmentContext, false);
    assert.equal(evidence.instructionPolicy.hostCurrentDateExposed, false);
    assert.deepEqual(evidence.contextCompaction, {
      policy: OPENLEEK_CONTEXT_COMPACTION_POLICY,
      events: [],
    });
  } finally { await rm(workspaceRoot, { recursive: true, force: true }); }
});

test("runtime evidence canonicalizes an Agent without a financial account", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "openleek-accountless-evidence-"));
  try {
    const service = await AgentExecutionService.open(noopBackend(), new InMemoryAgentExecutionStateStore(), { workspaceRoot });
    const agentsMdVersionRef = await templateVersion(service);
    await service.initialize("run-accountless-evidence", {
      section: { maxConcurrentAgents: 1 },
      turnPrompt: defaultTurnPrompt,
      agents: [{
        agentId: "media-1",
        agentsMdVersionRef,
        mcpContexts: ["social"],
      }],
    }, mutation("initialize-accountless-evidence", ""), [{
      context: "social",
      agentId: "media-1",
      principalId: "principal:run:media-1",
      endpoint: "http://127.0.0.1:3106/internal/mcp",
      credential: "experiment-issued-accountless-social-credential",
    }]);
    const evidence = await service.runtimeEvidence("run-accountless-evidence");
    assert.equal(evidence.conditionDigest.length, 64);
    assert.equal(evidence.artifacts.length, 1);
  } finally { await rm(workspaceRoot, { recursive: true, force: true }); }
});

test("every Agent workspace requires both Context-owned MCP bindings", async () => {
  const service = await AgentExecutionService.open(noopBackend(), new InMemoryAgentExecutionStateStore(), {});
  await assert.rejects(
    initialize(service, "run-incomplete-mcp", section, mutation("initialize-incomplete", ""), [mcp()[0]!]),
    code("INVALID_ARGUMENT"),
  );
});

test("the system Turn Prompt renders its UTC date template while Contexts own MCP actions", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "openleek-mcp-"));
  try {
    const texts: string[] = [];
    const workspaces: string[] = [];
    const sandboxEndpoints: string[] = [];
    const baseInstructions: string[] = [];
    const developerInstructions: string[] = [];
    const modelProviders: string[] = [];
    const client: CodexTurnClient = {
      async startSession(input) {
        workspaces.push(input.sandboxWorkspacePath);
        sandboxEndpoints.push(input.sandbox.endpoint);
        baseInstructions.push(input.baseInstructions);
        developerInstructions.push(input.developerInstructions);
        modelProviders.push(input.modelProvider);
        return "thread-1";
      }, async resumeSession() {},
      async runTurn(input) {
        texts.push(input.text);
        return { evidence: "agent text is retained only as evidence", turn: completedTurn("turn-mcp", "agent text is now durable") };
      },
    };
    const service = await AgentExecutionService.open(new CodexAgentBackend(client), new InMemoryAgentExecutionStateStore(), {
      workspaceRoot,
      sandboxRunsRoot: "/var/lib/openleek/runs",
    });
    const initialized = await initialize(service, "run-mcp", section, mutation("initialize", ""), mcp());
    const result = await service.execute({ runId: "run-mcp", roundId: 1, agentId: "retail-1", utcDate: "2026-07-18", mutation: mutation("execute", initialized.value.ref) });
    assert.deepEqual(texts, ["Today is 2026-07-18."]);
    assert.equal(workspaces[0], `/var/lib/openleek/runs/${runDirectoryName("run-mcp")}/workspaces/${agentDirectoryName("retail-1")}`);
    assert.deepEqual(sandboxEndpoints, ["ws://in-memory.invalid"]);
    assert.deepEqual(baseInstructions, [OPENLEEK_BASE_INSTRUCTIONS]);
    assert.deepEqual(modelProviders, ["deepseek"]);
    assert.doesNotMatch(developerInstructions[0] ?? "", /current_date|2026-07-18/);
    assert.match(developerInstructions[0] ?? "", /<cwd>.+<\/cwd>/);
    assert.match(developerInstructions[0] ?? "", /<timezone>Etc\/UTC<\/timezone>/);
    assert.deepEqual(result.results[0]?.candidates, []);
  } finally { await rm(workspaceRoot, { recursive: true, force: true }); }
});

test("complete semantic transcripts survive release while secrets and private reasoning are excluded", async () => {
  const credential = "experiment-issued-transcript-secret-credential";
  const client: CodexTurnClient = {
    async startSession() { return "thread-transcript"; },
    async resumeSession() {},
    async runTurn() {
      return { events: [
        { method: "rawResponseItem/completed", payload: { threadId: "thread-transcript", turnId: "turn-transcript", item: { type: "function_call", name: "read_mcp_resource", call_id: "resource-1", arguments: JSON.stringify({ uri: "news://daily/2026-08-06", authorization: `Bearer ${credential}` }) } } },
        { method: "item/tool/call/completed", payload: { request: { threadId: "thread-transcript", turnId: "turn-transcript", type: "reasoning", content: "private event reasoning", summary: ["Auditable event summary"] }, result: { contentItems: [{ type: "inputText", text: "Headline" }], success: true } } },
      ], turn: {
        id: "turn-transcript",
        itemsView: "full",
        status: "completed",
        error: null,
        startedAt: 1_775_635_200,
        completedAt: 1_775_635_202,
        durationMs: 2_000,
        items: [
          { type: "userMessage", id: "user-1", clientId: null, content: [{ type: "text", text: "Read today's news" }] },
          { type: "reasoning", id: "reasoning-1", summary: ["News may affect the position"], content: ["private chain of thought"] },
          { type: "mcpToolCall", id: "tool-1", server: "news", tool: "read_resource", status: "completed", arguments: { authorization: `Bearer ${credential}`, uri: "news://daily/2026-08-06" }, result: { content: [{ type: "text", text: "Headline" }], structuredContent: { headline: "Headline" }, _meta: null }, error: null, durationMs: 12 },
          { type: "agentMessage", id: "answer-1", text: "Headline may matter.", phase: "final_answer", memoryCitation: null },
        ],
      } };
    },
  };
  const store = new InMemoryAgentExecutionStateStore();
  const service = await AgentExecutionService.open(new CodexAgentBackend(client), store, {});
  const initialized = await initialize(service, "run-transcript", section, mutation("initialize-transcript", ""), mcp(credential));
  const executed = await service.execute({ runId: "run-transcript", roundId: 1, agentId: "retail-1", attemptId: "attempt:transcript:1", orchestrationTurnId: "turn:logical:transcript", utcDate: "2026-08-06", mutation: mutation("execute-transcript", initialized.value.ref) });
  assert.match(executed.results[0]?.transcriptRef ?? "", /^transcript:/);
  await service.release("run-transcript");
  const page = await createAgentExecutionRouter(service).createCaller({}).agentExecution.transcripts({ runId: "run-transcript", limit: 20 });
  assert.equal(page.availability, "available");
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.prompt, "Today is 2026-08-06.");
  assert.deepEqual(page.items[0]?.items.find((item) => item.type === "reasoning")?.payload.summary, ["News may affect the position"]);
  assert.equal("content" in (page.items[0]?.items.find((item) => item.type === "reasoning")?.payload ?? {}), false);
  assert.equal(page.items[0]?.items.find((item) => item.type === "mcpToolCall")?.payload.result && typeof page.items[0]?.items.find((item) => item.type === "mcpToolCall")?.payload.result === "object", true);
  assert.equal(page.items[0]?.events?.[0]?.method, "rawResponseItem/completed");
  assert.equal(JSON.stringify(page.items[0]?.events).includes("read_mcp_resource"), true);
  assert.equal(JSON.stringify(page.items[0]?.events).includes("private event reasoning"), false);
  assert.equal(JSON.stringify(page.items[0]?.events).includes("Auditable event summary"), true);
  assert.doesNotMatch(JSON.stringify(page), new RegExp(credential));
  assert.match(JSON.stringify(page), /\[REDACTED\]/);
});

test("a transcript storage failure cannot commit an Agent execution", async () => {
  class FailingTranscriptStore extends InMemoryAgentExecutionStateStore {
    override async commitExecution(): Promise<void> { throw new Error("transcript write failed"); }
  }
  const store = new FailingTranscriptStore();
  const service = await AgentExecutionService.open(noopBackend(), store, {});
  const initialized = await initialize(service, "run-transcript-failure", section, mutation("initialize-transcript-failure", ""), mcp());
  await assert.rejects(service.execute({ runId: "run-transcript-failure", roundId: 1, agentId: "retail-1", utcDate: "2026-08-06", mutation: mutation("execute-transcript-failure", initialized.value.ref) }), code("RETRYABLE"));
  assert.equal((await store.load())?.runs[0]?.executions.length, 0);
});

test("failed terminal Codex Turns remain auditable without committing execution", async () => {
  const client: CodexTurnClient = {
    async startSession() { return "thread-failed-turn"; },
    async resumeSession() {},
    async runTurn() { return { turn: { ...completedTurn("turn-failed"), status: "failed", error: { message: "provider stopped" } } }; },
  };
  const store = new InMemoryAgentExecutionStateStore();
  const service = await AgentExecutionService.open(new CodexAgentBackend(client), store, {});
  const initialized = await initialize(service, "run-failed-turn", section, mutation("initialize-failed-turn", ""), mcp());
  await assert.rejects(service.execute({ runId: "run-failed-turn", roundId: 1, agentId: "retail-1", attemptId: "attempt:failed:1", orchestrationTurnId: "turn:logical:failed", utcDate: "2026-08-06", mutation: mutation("execute-failed-turn", initialized.value.ref) }), code("RETRYABLE"));
  const history = await service.transcripts("run-failed-turn", { limit: 20 });
  assert.equal(history.items[0]?.status, "failed");
  assert.deepEqual(history.items[0]?.error, { message: "provider stopped" });
  assert.equal((await store.load())?.runs[0]?.executions.length, 0);
});

test("Run memory and frozen context compaction reach every Agent turn", async () => {
  const starts: Parameters<CodexTurnClient["startSession"]>[0][] = [];
  const resumes: Parameters<CodexTurnClient["resumeSession"]>[0][] = [];
  let turnNumber = 0;
  const client: CodexTurnClient = {
    async startSession(input) { starts.push(input); return "thread-memory"; },
    async resumeSession(input) { resumes.push(input); },
    async runTurn() {
      turnNumber += 1;
      const emptyUsage = {
        totalTokens: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      };
      return {
        turn: completedTurn(`turn-${turnNumber}`),
        tokenUsage: {
          threadId: "thread-memory",
          turnId: `turn-${turnNumber}`,
          responses: [],
          totals: emptyUsage,
          turnCounter: emptyUsage,
          threadCounter: emptyUsage,
          modelContextWindow: 1_000_000,
          compactions: turnNumber === 1
            ? [{ itemId: "compact-memory-1", completedAt: "2026-07-30T12:00:00.000Z" }]
            : [],
          countersMatch: true,
          completeness: "complete" as const,
        },
      };
    },
  };
  const service = await AgentExecutionService.open(
    new CodexAgentBackend(client),
    new InMemoryAgentExecutionStateStore(),
    {},
  );
  const agentsMdVersionRef = await templateVersion(service);
  const initialized = await service.initialize("run-memory-forwarding", {
    section: {
      memoryProfile: { routeId: "memory", llmConfigRevision: "revision:llm:test" },
      maxConcurrentAgents: 1,
    },
    turnPrompt: defaultTurnPrompt,
    agents: [{ agentId: "retail-1", agentsMdVersionRef, mcpContexts: ["social", "financial"] }],
  }, mutation("initialize-memory-forwarding", ""), mcp());
  await service.execute({
    runId: "run-memory-forwarding",
    roundId: 1,
    agentId: "retail-1",
    utcDate: "2026-07-30",
    mutation: mutation("execute-memory-round-1", initialized.value.ref),
  });
  const sealed = await service.seal("run-memory-forwarding", 1, mutation("seal-memory-round-1", initialized.value.ref));
  await service.publish("run-memory-forwarding", 1, sealed.value.ref, mutation("publish-memory-round-1", initialized.value.ref));
  await service.execute({
    runId: "run-memory-forwarding",
    roundId: 2,
    agentId: "retail-1",
    utcDate: "2026-07-31",
    mutation: mutation("execute-memory-round-2", sealed.value.ref),
  });
  assert.match(starts[0]?.memory?.bankId ?? "", /^agent-[0-9a-f]{64}$/);
  assert.deepEqual(starts[0]?.memory && {
    routeId: starts[0].memory.routeId,
    llmConfigRevision: starts[0].memory.llmConfigRevision,
    roundId: starts[0].memory.roundId,
    toolProfile: starts[0].memory.toolProfile,
  }, {
    routeId: "memory",
    llmConfigRevision: "revision:llm:test",
    roundId: 1,
    toolProfile: "hook-v1",
  });
  assert.deepEqual(service.getHookPolicy("run-memory-forwarding"), {
    strategyInjectionEnabled: true,
    revision: 1,
    updatedAt: service.getHookPolicy("run-memory-forwarding").updatedAt,
  });
  const changedPolicy = await service.updateHookPolicy({
    runId: "run-memory-forwarding",
    strategyInjectionEnabled: false,
    expectedRevision: 1,
    idempotencyKey: "hook-policy-memory-off",
  });
  assert.equal(changedPolicy.policy.revision, 2);
  assert.equal((await service.updateHookPolicy({
    runId: "run-memory-forwarding",
    strategyInjectionEnabled: false,
    expectedRevision: 1,
    idempotencyKey: "hook-policy-memory-off",
  })).replayed, true);
  await assert.rejects(service.updateHookPolicy({
    runId: "run-memory-forwarding",
    strategyInjectionEnabled: true,
    expectedRevision: 1,
    idempotencyKey: "hook-policy-stale",
  }), code("PRECONDITION_FAILED"));
  assert.equal(resumes[0]?.memory?.roundId, 2);
  assert.deepEqual(starts[0]?.contextCompactionPolicy, OPENLEEK_CONTEXT_COMPACTION_POLICY);
  assert.deepEqual(resumes[0]?.contextCompactionPolicy, OPENLEEK_CONTEXT_COMPACTION_POLICY);
  assert.deepEqual((await service.runtimeEvidence("run-memory-forwarding")).contextCompaction.events, [{
    runId: "run-memory-forwarding",
    roundId: 1,
    agentId: "retail-1",
    threadId: "thread-memory",
    turnId: "turn-1",
    itemId: "compact-memory-1",
    trigger: "auto",
    completedAt: "2026-07-30T12:00:00.000Z",
  }]);

  const strategyDraft = await service.saveSkillDraft({
    name: "Long-term strategy",
    files: [{
      path: "SKILL.md",
      encoding: "utf8",
      executable: false,
      content: "---\nname: long-term-strategy\ndescription: Use when forming or revising a self-chosen course of action intended to guide multiple future Turns.\n---\n\nUpdate the active strategy when a longer-term intention would help future choices.\n",
    }],
    requirements: { tools: [], resources: [] },
  });
  const strategy = await service.publishSkill({
    skillId: strategyDraft.skillId,
    expectedRevision: strategyDraft.revision,
  });
  const split = await service.initialize("run-memory-split", {
    section: {
      memoryProfile: { routeId: "memory", llmConfigRevision: "revision:llm:test" },
      maxConcurrentAgents: 1,
    },
    turnPrompt: defaultTurnPrompt,
    agents: [{
      agentId: "retail-1",
      agentsMdVersionRef,
      skillVersionRefs: [strategy.versionRef],
      mcpContexts: ["social", "financial"],
    }],
  }, mutation("initialize-memory-split", ""), mcp());
  await service.execute({
    runId: "run-memory-split",
    roundId: 1,
    agentId: "retail-1",
    utcDate: "2026-08-01",
    mutation: mutation("execute-memory-split", split.value.ref),
  });
  assert.equal(starts[1]?.memory?.toolProfile, "hook-v1");
});

test("a persisted pre-64K compaction policy remains frozen when its Run resumes", async () => {
  const store = new InMemoryAgentExecutionStateStore();
  const sourceClient: CodexTurnClient = {
    async startSession() { return "thread-legacy-compaction"; },
    async resumeSession() {},
    async runTurn() { return { turn: completedTurn("turn-legacy-1") }; },
  };
  const source = await AgentExecutionService.open(new CodexAgentBackend(sourceClient), store, {});
  const initialized = await initialize(source, "run-legacy-compaction", section, mutation("initialize-legacy-compaction", ""), mcp());
  await source.execute({
    runId: "run-legacy-compaction",
    roundId: 1,
    agentId: "retail-1",
    utcDate: "2026-07-30",
    mutation: mutation("execute-legacy-compaction-round-1", initialized.value.ref),
  });

  const persisted = await store.load();
  assert.ok(persisted);
  const legacy = structuredClone(persisted) as unknown as {
    runs: Array<{ artifacts: Array<{ contextCompactionPolicy?: {
      mode: "auto";
      tokenLimit: number;
      scope: "body_after_prefix";
      prompt: "codex-default";
    } }> }>;
  };
  const legacyPolicy = {
    mode: "auto" as const,
    tokenLimit: 128_000,
    scope: "body_after_prefix" as const,
    prompt: "codex-default" as const,
  };
  for (const run of legacy.runs) {
    for (const artifact of run.artifacts) artifact.contextCompactionPolicy = legacyPolicy;
  }
  await store.save(legacy as unknown as AgentExecutionSnapshot);

  const resumes: Parameters<CodexTurnClient["resumeSession"]>[0][] = [];
  const resumedClient: CodexTurnClient = {
    async startSession() { throw new Error("persisted Run must resume its thread"); },
    async resumeSession(input) { resumes.push(input); },
    async runTurn() { return { turn: completedTurn("turn-legacy-2") }; },
  };
  const resumed = await AgentExecutionService.open(new CodexAgentBackend(resumedClient), store, {});
  await resumed.execute({
    runId: "run-legacy-compaction",
    roundId: 2,
    agentId: "retail-1",
    utcDate: "2026-07-31",
    mutation: mutation("execute-legacy-compaction-round-2", initialized.value.ref),
  });
  assert.deepEqual(resumes[0]?.contextCompactionPolicy, legacyPolicy);
  assert.deepEqual((await resumed.runtimeEvidence("run-legacy-compaction")).contextCompaction.policy, legacyPolicy);
});

test("MCP Policy assets normalize, publish immutably, and are exposed through RPC", async () => {
  const store = new InMemoryAgentExecutionStateStore();
  const service = await AgentExecutionService.open(noopBackend(), store, {});
  const caller = createAgentExecutionRouter(service).createCaller({});
  const draft = await caller.agentExecution.mcpPolicies.saveDraft({
    name: "Trader and publisher",
    tools: ["social.create_post", "financial.place_order", "social.create_post"],
    resources: ["financial.market", "social.feed", "financial.market"],
  });
  assert.deepEqual(draft.tools, ["financial.place_order", "social.create_post"]);
  assert.deepEqual(draft.resources, ["financial.market", "social.feed"]);
  assert.equal(draft.revision, 1);
  await assert.rejects(
    caller.agentExecution.mcpPolicies.saveDraft({
      policyId: draft.policyId,
      expectedRevision: 2,
      name: draft.name,
      tools: draft.tools,
      resources: draft.resources,
    }),
    (error: unknown) => error instanceof Error && /changed; reload/.test(error.message),
  );
  const version = await caller.agentExecution.mcpPolicies.publish({ policyId: draft.policyId, expectedRevision: draft.revision });
  assert.match(version.versionRef, /^mcp-policy:/);
  assert.equal(version.artifactDigest.length, 64);
  assert.deepEqual(await caller.agentExecution.mcpPolicies.version({ versionRef: version.versionRef }), version);
  const listing = await caller.agentExecution.mcpPolicies.list({});
  assert.equal(listing.drafts.length, 1);
  assert.equal(listing.versions.length, 1);

  const changed = await caller.agentExecution.mcpPolicies.saveDraft({
    policyId: draft.policyId,
    expectedRevision: draft.revision,
    name: draft.name,
    tools: [],
    resources: [],
  });
  const emptyVersion = await caller.agentExecution.mcpPolicies.publish({ policyId: changed.policyId, expectedRevision: changed.revision });
  assert.notEqual(emptyVersion.versionRef, version.versionRef);
  assert.deepEqual(emptyVersion.tools, []);
  assert.deepEqual(emptyVersion.resources, []);
  assert.deepEqual(await caller.agentExecution.mcpPolicies.version({ versionRef: version.versionRef }), version);
  assert.equal((await store.load())?.mcpPolicyVersions.length, 2);

  await assert.rejects(
    service.saveMcpPolicyDraft({ name: "Invalid", tools: ["missing_namespace"] as never, resources: [] }),
    code("INVALID_ARGUMENT"),
  );
});

test("Agent Execution RPC accepts a dynamically registered Context connection", async () => {
  const service = await AgentExecutionService.open(noopBackend(), new InMemoryAgentExecutionStateStore(), {});
  const agentsMdVersionRef = await templateVersion(service);
  const caller = createAgentExecutionRouter(service).createCaller({});
  const result = await caller.agentExecution.initialize({
    runId: "run:dynamic-context-rpc",
    section: { maxConcurrentAgents: 1 },
    turnPrompt: defaultTurnPrompt,
    agents: [{ agentId: "agent:dynamic", agentsMdVersionRef, mcpContexts: ["news"] }],
    mutation: mutation("initialize-dynamic-context-rpc", ""),
    mcp: [{ context: "news", agentId: "agent:dynamic", principalId: "principal:dynamic", endpoint: "http://news.test/mcp", credential: "x".repeat(32) }],
  });
  assert.equal(result.checkpoint.runId, "run:dynamic-context-rpc");
});

test("Skill bundles publish immutably, require compatible MCP Policy, and materialize in the Agent workspace", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "openleek-skill-"));
  try {
    const service = await AgentExecutionService.open(noopBackend(), new InMemoryAgentExecutionStateStore(), { workspaceRoot });
    const skillDraft = await service.saveSkillDraft({
      name: "Social research",
      files: [
        { path: "SKILL.md", encoding: "utf8", executable: false, content: "---\nname: social-research\ndescription: Use for a structured social research turn.\n---\n\nRead the feed.\n" },
        { path: "references/checklist.md", encoding: "utf8", executable: false, content: "# Checklist\n" },
        { path: "scripts/check.sh", encoding: "utf8", executable: true, content: "#!/bin/sh\nexit 0\n" },
      ],
      requirements: { tools: [], resources: ["social.feed"] },
    });
    const skill = await service.publishSkill({ skillId: skillDraft.skillId, expectedRevision: skillDraft.revision });
    assert.equal(skill.skillName, "social-research");
    assert.equal(service.getSkillVersion(skill.versionRef).artifactDigest, skill.artifactDigest);

    const agentsMdVersionRef = await templateVersion(service);
    const initialized = await service.initialize("run-skill", {
      section: { maxConcurrentAgents: 10 },
      turnPrompt: defaultTurnPrompt,
      agents: [{ agentId: "retail-1", agentsMdVersionRef, skillVersionRefs: [skill.versionRef], mcpContexts: ["social", "financial"] }],
    }, mutation("initialize-skill", ""), mcp());
    const workspace = runWorkspace(workspaceRoot, "run-skill", "retail-1");
    assert.match(await readFile(join(workspace, ".agents", "skills", "social-research", "SKILL.md"), "utf8"), /name: social-research/);
    assert.equal(await readFile(join(workspace, ".agents", "skills", "social-research", "references", "checklist.md"), "utf8"), "# Checklist\n");
    await writeFile(join(workspace, ".agents", "skills", "unexpected.txt"), "drift");
    await service.execute({ runId: "run-skill", roundId: 1, agentId: "retail-1", utcDate: "2026-07-23", mutation: mutation("execute-skill", initialized.value.ref) });
    await assert.rejects(access(join(workspace, ".agents", "skills", "unexpected.txt")));
  } finally { await rm(workspaceRoot, { recursive: true, force: true }); }
});

test("published Turn Prompt variables are frozen and rendered with UTC date and round", async () => {
  const texts: string[] = [];
  const client: CodexTurnClient = {
    async startSession() { return "thread-turn-prompt"; },
    async resumeSession() {},
    async runTurn(input) { texts.push(input.text); return { turn: completedTurn("turn-prompt") }; },
  };
  const service = await AgentExecutionService.open(new CodexAgentBackend(client), new InMemoryAgentExecutionStateStore(), {});
  const version = { versionRef: "turn-prompt:experiment:1", artifactDigest: digest("b") };
  const agentsMdVersionRef = await templateVersion(service);
  const initialized = await service.initialize("run-turn-prompt", {
    section: { maxConcurrentAgents: 10 },
    turnPrompt: { ...version, source: "Date={{utcDate}} round={{roundId}} thesis={{thesis}} enabled={{enabled}}", variables: { thesis: "liquidity", enabled: true } },
    agents: [{ agentId: "retail-1", agentsMdVersionRef, mcpContexts: ["social", "financial"] }],
  }, mutation("initialize-turn-prompt", ""), mcp());
  await service.execute({ runId: "run-turn-prompt", roundId: 3, agentId: "retail-1", utcDate: "2026-07-23", mutation: mutation("execute-turn-prompt", initialized.value.ref) });
  assert.deepEqual(texts, ["Date=2026-07-23 round=3 thesis=liquidity enabled=true"]);
  const evidence = await service.runtimeEvidence("run-turn-prompt");
  assert.equal(evidence.turnPrompt.versionRef, version.versionRef);
  assert.deepEqual(evidence.turnPrompt.variables, { thesis: "liquidity", enabled: true });
});

test("artifact/catalog drift is restored and a fork inherits the immutable configuration", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "openleek-drift-"));
  try {
    const service = await AgentExecutionService.open(noopBackend(), new InMemoryAgentExecutionStateStore(), { workspaceRoot });
    const initialized = await initialize(service, "run-parent", section, mutation("initialize", ""), mcp());
    const configPath = join(runWorkspace(workspaceRoot, "run-parent", "retail-1"), ".codex", "config.toml");
    const catalogPath = join(workspaceRoot, runDirectoryName("run-parent"), "codex-home", "models.json");
    const before = await readFile(configPath, "utf8");
    await writeFile(configPath, "tampered", "utf8");
    await writeFile(catalogPath, "{}", "utf8");
    await service.execute({ runId: "run-parent", roundId: 1, agentId: "retail-1", utcDate: "2026-07-18", mutation: mutation("execute", initialized.value.ref) });
    assert.equal(await readFile(configPath, "utf8"), before);
    assert.deepEqual(JSON.parse(await readFile(catalogPath, "utf8")), JSON.parse(deepSeekCodexProfile().modelsJson));
    assert.equal((await service.runtimeEvidence("run-parent")).driftEvents.length, 1);
    const sealed = await service.seal("run-parent", 1, mutation("seal", initialized.value.ref));
    await service.publish("run-parent", 1, sealed.value.ref, mutation("publish", initialized.value.ref));
    await service.fork("run-parent", "run-child", sealed.value.ref, mutation("fork", sealed.value.ref), mcp("experiment-issued-forked-run-credential-for-context-mcp"));
    const configs = await Promise.all([
      readFile(join(runWorkspace(workspaceRoot, "run-parent", "retail-1"), ".codex", "config.toml"), "utf8"),
      readFile(join(runWorkspace(workspaceRoot, "run-child", "retail-1"), ".codex", "config.toml"), "utf8"),
    ]);
    assert.equal(new Set(configs).size, 2);
    assert.deepEqual((await service.committedCheckpoint("run-child")).model, DEEPSEEK_MODEL);
    assert.deepEqual((await service.runtimeEvidence("run-child")).modelConfiguration.configDigest, deepSeekCodexProfile().configDigest);
  } finally { await rm(workspaceRoot, { recursive: true, force: true }); }
});

test("Agent workspaces share provider configuration but isolate Context MCP credentials", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "openleek-mcp-isolation-"));
  try {
    const second = { ...section.agents[0]!, agentId: "retail-2", actorId: "retail-2", accountId: "account-2" };
    const twoAgents = { ...section, agents: [section.agents[0]!, second] };
    const firstCredential = "experiment-issued-agent-one-social-context-mcp-credential";
    const secondCredential = "experiment-issued-agent-two-social-context-mcp-credential";
    const connections = [
      { context: "social" as const, agentId: "retail-1", principalId: "principal:run:retail-1", endpoint: "http://social/internal/mcp", credential: firstCredential },
      { context: "financial" as const, agentId: "retail-1", principalId: "principal:run:retail-1", endpoint: "http://financial/internal/mcp", credential: `${firstCredential}-financial` },
      { context: "social" as const, agentId: "retail-2", principalId: "principal:run:retail-2", endpoint: "http://social/internal/mcp", credential: secondCredential },
      { context: "financial" as const, agentId: "retail-2", principalId: "principal:run:retail-2", endpoint: "http://financial/internal/mcp", credential: `${secondCredential}-financial` },
    ];
    const service = await AgentExecutionService.open(noopBackend(), new InMemoryAgentExecutionStateStore(), { workspaceRoot });
    await initialize(service, "run-isolated-mcp", twoAgents, mutation("isolated-mcp", ""), connections);
    const [first, secondConfig] = await Promise.all([
      readFile(join(runWorkspace(workspaceRoot, "run-isolated-mcp", "retail-1"), ".codex", "config.toml"), "utf8"),
      readFile(join(runWorkspace(workspaceRoot, "run-isolated-mcp", "retail-2"), ".codex", "config.toml"), "utf8"),
    ]);
    assert.match(first, new RegExp(firstCredential));
    assert.doesNotMatch(first, new RegExp(secondCredential));
    assert.match(secondConfig, new RegExp(secondCredential));
    assert.doesNotMatch(secondConfig, new RegExp(firstCredential));
  } finally { await rm(workspaceRoot, { recursive: true, force: true }); }
});

test("pre-DeepSeek snapshots are rejected without a migration adapter", async () => {
  const legacy = {
    version: 1 as const,
    runs: [{
      runId: "legacy-run", backend: "openai", model: "old-model",
      agents: [{ agentId: "legacy-agent", accountId: "legacy-account", type: "retail_investor", systemPrompt: "old prompt" }],
      sessions: { "legacy-agent": null },
      executions: [{
        roundId: 1, agentId: "legacy-agent",
        result: { agentId: "legacy-agent", candidates: [{ kind: "social.post" as const, actionId: "legacy-action", actorId: "legacy-agent", postId: "legacy-post", headline: "Legacy", body: "Preserved audit fact" }], evidenceRef: "legacy:evidence" },
      }],
      sealed: [{ ref: "checkpoint:legacy", runId: "legacy-run", roundId: 1, digest: digest("b") }], publishedRound: 1,
    }], idempotency: [],
  };
  const store = { async load() { return legacy as unknown as import("../src/ports.js").AgentExecutionSnapshot; }, async save() {} };
  await assert.rejects(
    AgentExecutionService.open(noopBackend(), store, {}),
    /predates native DeepSeek configuration/,
  );
});

test("sandbox descriptor is persisted, release is idempotent, and runtime evidence exposes no topology", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "openleek-release-"));
  try {
    const store = new InMemoryAgentExecutionStateStore();
    const service = await AgentExecutionService.open(noopBackend(), store, {
      workspaceRoot,
      sandboxRunsRoot: "/var/lib/openleek/runs",
      sandboxManager: new InMemorySandboxManager(),
    });
    await initialize(service, "run-release", section, mutation("initialize-release", ""), mcp());
    assert.deepEqual((await service.runtimeEvidence("run-release")).sandbox.state, "active");
    const first = await service.release("run-release");
    const second = await service.release("run-release");
    assert.deepEqual(first, second);
    assert.equal(first.state, "released");
    assert.equal("containerId" in first, false);
    assert.equal((await service.runtimeEvidence("run-release")).sandbox.state, "released");
    const snapshot = await store.load();
    assert.equal(snapshot?.version, 16);
    assert.equal(snapshot?.runs[0]?.sandbox.lifecycle, "released");
  } finally { await rm(workspaceRoot, { recursive: true, force: true }); }
});

test("version 14 snapshots retain assets but discard non-native Runs", async () => {
  const sourceStore = new InMemoryAgentExecutionStateStore();
  const source = await AgentExecutionService.open(noopBackend(), sourceStore, {});
  const initialized = await initialize(source, "run-v9-policy", section, mutation("initialize-v9-policy", ""), mcp());
  await source.execute({ runId: "run-v9-policy", roundId: 1, agentId: "retail-1", utcDate: "2026-07-18", mutation: mutation("execute-v9-policy", initialized.value.ref) });
  const current = await sourceStore.load();
  assert.ok(current);
  const legacy = structuredClone(current) as unknown as { version: number; runs: Array<Record<string, unknown>> };
  legacy.version = 14;
  let migrated: AgentExecutionSnapshot | undefined;
  const store: AgentExecutionStateStore = {
    async load() { return legacy as unknown as AgentExecutionSnapshot; },
    async save(snapshot) { migrated = structuredClone(snapshot); },
  };
  const restored = await AgentExecutionService.open(noopBackend(), store, {});
  assert.equal(migrated?.version, 16);
  assert.deepEqual(migrated?.runs, []);
  assert.deepEqual(migrated?.idempotency, []);
  assert.equal(restored.listAgentsMd().versions.length, 1);
  assert.equal(migrated?.agentsMdVersions.length, 1);
});

test("sandbox restart restores the immutable workspace and Run catalog before Codex resumes", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "openleek-sandbox-restart-artifacts-"));
  try {
    const manager = new InMemorySandboxManager();
    const service = await AgentExecutionService.open(noopBackend(), new InMemoryAgentExecutionStateStore(), {
      workspaceRoot,
      sandboxRunsRoot: "/var/lib/openleek/runs",
      sandboxManager: manager,
    });
    const initialized = await initialize(service, "run-restart-artifacts", section, mutation("restart-artifacts-initialize", ""), mcp());
    const workspace = runWorkspace(workspaceRoot, "run-restart-artifacts", "retail-1");
    const configPath = join(workspace, ".codex", "config.toml");
    const catalogPath = join(workspaceRoot, runDirectoryName("run-restart-artifacts"), "codex-home", "models.json");
    const expectedConfig = await readFile(configPath, "utf8");
    await writeFile(configPath, "tampered-after-container-stop", "utf8");
    await rm(catalogPath);
    await service.release("run-restart-artifacts");
    await service.execute({ runId: "run-restart-artifacts", roundId: 1, agentId: "retail-1", utcDate: "2026-07-18", mutation: mutation("restart-artifacts-execute", initialized.value.ref) });
    assert.equal(await readFile(configPath, "utf8"), expectedConfig);
    assert.deepEqual(JSON.parse(await readFile(catalogPath, "utf8")), JSON.parse(deepSeekCodexProfile().modelsJson));
    const evidence = await service.runtimeEvidence("run-restart-artifacts");
    assert.equal(evidence.sandbox.restartCount, 1);
    assert.equal(evidence.driftEvents.length, 1);
  } finally { await rm(workspaceRoot, { recursive: true, force: true }); }
});

test("Docker sandbox lifecycle uses a deterministic name, wait probe, and exact run cleanup", async () => {
  assert.deepEqual(CODEX_SANDBOX_SECURITY_OPTIONS, ["apparmor=unconfined", "seccomp=unconfined"]);
  const runsHostPath = await mkdtemp(join(tmpdir(), "openleek-sandboxes-"));
  try {
    const engine = new FakeDockerEngine();
    const ready: string[] = [];
    const manager = new DockerSandboxManager({
      socketProxyUrl: "http://docker-socket-proxy:2375",
      image: "openleek-codex-sandbox:test",
      controlNetwork: "openleek-sandbox-control",
      contextNetwork: "openleek-sandbox-context-gateway",
      egressNetwork: "openleek-run-egress",
      deepSeekApiKey: "deepseek-test-key",
      runsHostPath,
      runsContainerPath: runsHostPath,
      appServerToken: "sandbox-token",
    }, engine, async (name) => { ready.push(name); });
    const runId = "run-sandbox";
    const hostRunRoot = join(runsHostPath, runDirectoryName(runId));
    const remoteRunRoot = hostRunRoot;
    await mkdir(join(hostRunRoot, "codex-home"), { recursive: true });
    const first = await manager.ensure({ runId, hostRunRoot, remoteRunRoot, contexts: ["financial"] });
    assert.equal(first.containerName, `openleek-agent-${runDirectoryName(runId).slice(0, 32)}`);
    assert.equal(first.restartCount, 0);
    assert.deepEqual(ready, [first.containerName]);
    assert.equal(engine.created[0]?.appServerToken, "sandbox-token");
    assert.deepEqual(engine.created[0]?.networks, ["openleek-run-egress", "openleek-sandbox-context-gateway", "openleek-sandbox-control"]);
    engine.running = false;
    const restarted = await manager.ensure({ runId, hostRunRoot, remoteRunRoot, contexts: ["financial"], existing: first });
    assert.equal(restarted.restartCount, 1);
    assert.equal(ready.length, 2);
    const migrated = await manager.ensure({ runId, hostRunRoot, remoteRunRoot, contexts: ["financial", "social"], existing: restarted });
    assert.equal(migrated.restartCount, 1);
    assert.deepEqual(engine.created.at(-1)?.networks, ["openleek-run-egress", "openleek-sandbox-context-gateway", "openleek-sandbox-control"]);
    const fourth = await manager.ensure({ runId, hostRunRoot, remoteRunRoot, contexts: ["weather"], existing: migrated });
    assert.equal(fourth.containerId, migrated.containerId);
    const released = await manager.release(migrated);
    assert.equal(released.lifecycle, "released");
    await assert.rejects(access(hostRunRoot));
    assert.deepEqual(await manager.release(released), released);
  } finally { await rm(runsHostPath, { recursive: true, force: true }); }
});

test("runtime exposes the fixed native DeepSeek capability", async () => {
  const runtime = await createAgentExecutionRuntime(
    {},
    {
      stateStore: new InMemoryAgentExecutionStateStore(),
      backend: noopBackend(),
      sandboxManager: new InMemorySandboxManager(),
      runtimeCapability: { model: DEEPSEEK_MODEL, configDigest: deepSeekCodexProfile().configDigest },
    },
  );
  assert.deepEqual(runtime.capability, { model: DEEPSEEK_MODEL, configDigest: deepSeekCodexProfile().configDigest });
  assert.deepEqual(await runtime.router.createCaller({}).agentExecution.runtimeCapability({}), { model: DEEPSEEK_MODEL, configDigest: deepSeekCodexProfile().configDigest });
  await initialize(runtime.service, "run-runtime-profile", section, mutation("runtime-profile", ""), mcp());
  await runtime.close();
});

test("runtime writes workspaces through its container mount while Docker receives the host bind root", async () => {
  const root = await mkdtemp(join(tmpdir(), "openleek-runtime-runs-"));
  try {
    const hostRunsRoot = join(root, "docker-host-runs");
    const containerRunsRoot = join(root, "agent-execution-mount");
    const sandboxManager = new RecordingSandboxManager();
    const runtime = await createAgentExecutionRuntime({
      OPENLEEK_SANDBOX_RUNS_HOST_PATH: hostRunsRoot,
      OPENLEEK_SANDBOX_RUNS_CONTAINER_PATH: containerRunsRoot,
    }, {
      stateStore: new InMemoryAgentExecutionStateStore(),
      backend: noopBackend(),
      sandboxManager,
    });
    await initialize(runtime.service, "run-mounted", section, mutation("initialize-mounted", ""), mcp());
    const workspace = runWorkspace(containerRunsRoot, "run-mounted", "retail-1");
    await access(join(workspace, "AGENTS.md"));
    assert.equal(sandboxManager.inputs[0]?.hostRunRoot, join(hostRunsRoot, runDirectoryName("run-mounted")));
    await runtime.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("app-server approval grants only requested private-mesh network access for this turn", () => {
  assert.deepEqual(codexThreadInstructionParams({
    baseInstructions: "OpenLeek base",
    developerInstructions: "<environment_context><timezone>Etc/UTC</timezone></environment_context>",
    contextCompactionPolicy: OPENLEEK_CONTEXT_COMPACTION_POLICY,
  }), {
    baseInstructions: "OpenLeek base",
    developerInstructions: "<environment_context><timezone>Etc/UTC</timezone></environment_context>",
    config: {
      include_environment_context: false,
      model_auto_compact_token_limit: 64000,
      model_auto_compact_token_limit_scope: "total",
    },
  });
  assert.deepEqual(serverRequestResult({
    id: "approval-1",
    method: "item/permissions/requestApproval",
    params: {
      permissions: {
        network: { enabled: true },
        fileSystem: { read: ["/unexpected-read"], write: ["/unexpected-write"] },
      },
    },
  }), {
    permissions: { network: { enabled: true } },
    scope: "turn",
  });
  assert.deepEqual(serverRequestResult({ id: 2, method: "item/commandExecution/requestApproval" }), { decision: "decline" });
  assert.deepEqual(serverRequestResult({ id: 3, method: "mcpServer/elicitation/request", params: { serverName: "social" } }), { action: "accept", content: {}, _meta: null });
  assert.deepEqual(serverRequestResult({ id: 4, method: "mcpServer/elicitation/request", params: { serverName: "weather" } }), { action: "accept", content: {}, _meta: null });
  assert.deepEqual(serverRequestResult({ id: 5, method: "mcpServer/elicitation/request", params: { serverName: "invalid/context" } }), { action: "decline", content: null, _meta: null });
  assert.equal(serverRequestResult({ id: 6, method: "unknown/request" }), undefined);
  assert.equal(isThreadMaterializingError(new Error("Codex app-server error -32600: thread abc is not materialized yet; includeTurns is unavailable before first user message")), true);
  assert.equal(isThreadMaterializingError(new Error("Codex app-server request timed out")), false);
});

test("app-server does not treat an unmaterialized interrupted placeholder as terminal", () => {
  assert.equal(isCompletedTerminalTurn({
    id: "turn-racing",
    status: "interrupted",
    completedAt: null,
    durationMs: null,
  }), false);
  assert.equal(isCompletedTerminalTurn({
    id: "turn-interrupted",
    status: "interrupted",
    completedAt: 1_785_122_540,
    durationMs: 25,
  }), true);
  assert.equal(isCompletedTerminalTurn({
    id: "turn-failed",
    status: "failed",
    completedAt: 1_785_122_541,
    durationMs: 30,
  }), true);
});

test("app-server isolates active goal continuations from the requested turn", () => {
  assert.deepEqual(goalContinuationTurnIds([
    { id: "requested", status: "completed" },
    { id: "goal-one", status: "inProgress" },
    { id: "goal-two", status: "waitingOnApproval" },
    { id: "older", status: "completed" },
    { id: 7, status: "inProgress" },
  ], "requested"), ["goal-one", "goal-two"]);
});

test("app-server attributes usage and native compaction without splitting batched actions", () => {
  const collector = new TurnTokenCollector(() => "2026-07-30T12:00:00.000Z");
  const usage = (totalTokens: number) => ({
    totalTokens,
    inputTokens: totalTokens - 3,
    cachedInputTokens: 1,
    cacheWriteInputTokens: 0,
    outputTokens: 3,
    reasoningOutputTokens: 1,
  });
  collector.begin("thread-a", "turn-1");
  collector.begin("thread-b", "turn-2");
  collector.accept("rawResponseItem/completed", { threadId: "thread-a", turnId: "turn-1", item: { type: "function_call", name: "mcp__social__read_feed", arguments: "{}", call_id: "call-1" } });
  collector.accept("rawResponseItem/completed", { threadId: "thread-b", turnId: "turn-2", item: { type: "function_call", name: "mcp__social__read_feed", arguments: "{}", call_id: "call-b" } });
  collector.accept("rawResponse/completed", { threadId: "thread-a", turnId: "turn-1", responseId: "response-1", usage: usage(10) });
  collector.accept("rawResponseItem/completed", { threadId: "thread-a", turnId: "turn-1", item: { type: "function_call", name: "mcp__social__create_post", arguments: "{}", call_id: "call-2" } });
  collector.accept("rawResponseItem/completed", { threadId: "thread-a", turnId: "turn-1", item: { type: "function_call", name: "mcp__financial__place_order", arguments: "{}", call_id: "call-3" } });
  collector.accept("rawResponse/completed", { threadId: "thread-a", turnId: "turn-1", responseId: "response-2", usage: usage(20) });
  collector.accept("rawResponseItem/completed", { threadId: "thread-a", turnId: "turn-1", item: { type: "message", role: "assistant", content: [] } });
  collector.accept("rawResponse/completed", { threadId: "thread-a", turnId: "turn-1", responseId: "response-3", usage: null });
  collector.accept("item/completed", { threadId: "thread-a", turnId: "turn-1", item: { type: "contextCompaction", id: "compact-1" } });
  collector.accept("item/completed", { threadId: "thread-a", turnId: "turn-1", item: { type: "contextCompaction", id: "compact-1" } });
  collector.accept("thread/tokenUsage/updated", { threadId: "thread-a", turnId: "turn-1", tokenUsage: { total: usage(100), last: {
    totalTokens: 30,
    inputTokens: 24,
    cachedInputTokens: 2,
    cacheWriteInputTokens: 0,
    outputTokens: 6,
    reasoningOutputTokens: 2,
  }, modelContextWindow: 1000 } });

  const capture = collector.finishCapture("thread-a", "turn-1");
  const result = capture.tokenUsage;
  assert.deepEqual(result.responses.map(({ classification, toolCalls, usage: responseUsage }) => ({
    classification,
    calls: toolCalls.map((call) => call.callId),
    total: responseUsage?.totalTokens ?? null,
  })), [
    { classification: "mcp_action", calls: ["call-1"], total: 10 },
    { classification: "batched_actions", calls: ["call-2", "call-3"], total: 20 },
    { classification: "final_response", calls: [], total: null },
  ]);
  assert.equal(result.totals.totalTokens, 30);
  assert.equal(result.threadCounter?.totalTokens, 100);
  assert.equal(result.modelContextWindow, 1000);
  assert.deepEqual(result.compactions, [{ itemId: "compact-1", completedAt: "2026-07-30T12:00:00.000Z" }]);
  assert.equal(result.countersMatch, true);
  assert.equal(result.completeness, "missing_usage_and_batched_actions");
  assert.deepEqual(capture.events.map((event) => event.method), [
    "rawResponseItem/completed",
    "rawResponse/completed",
    "rawResponseItem/completed",
    "rawResponseItem/completed",
    "rawResponse/completed",
    "rawResponseItem/completed",
    "rawResponse/completed",
    "item/completed",
    "item/completed",
    "thread/tokenUsage/updated",
  ]);

  const other = collector.finish("thread-b", "turn-2");
  assert.equal(other.responses.length, 0);
  assert.equal(other.completeness, "missing_usage");
});

function noopBackend(): AgentExecutionBackend {
  return {
    name: "codex",
    async execute(input: BackendExecutionInput) {
      const sessionId = input.sessionId ?? `thread:${input.runId}:${input.agent.agentId}`;
      return { sessionId, transcript: createAgentSessionTranscript({ execution: input, sessionId, turn: completedTurn(`turn:${input.runId}:${input.roundId}:${input.agent.agentId}`) }) };
    },
  };
}
function completedTurn(id: string, text = "done") {
  return { id, items: [{ type: "agentMessage", id: `${id}:message`, text, phase: "final_answer", memoryCitation: null }], itemsView: "full", status: "completed", error: null, startedAt: 1_775_635_200, completedAt: 1_775_635_201, durationMs: 1_000 };
}
function code(expected: string) { return (error: unknown) => error instanceof AgentExecutionError && error.code === expected; }

function runWorkspace(workspaceRoot: string, runId: string, agentId: string): string {
  return join(workspaceRoot, runDirectoryName(runId), "workspaces", agentDirectoryName(agentId));
}

class FakeDockerEngine implements DockerEngine {
  readonly created: Parameters<DockerEngine["create"]>[0][] = [];
  running = false;
  private id: string | undefined;

  async inspect(): Promise<{ id: string; running: boolean; networks: readonly string[] } | null> {
    return this.id === undefined ? null : { id: this.id, running: this.running, networks: this.created.at(-1)?.networks ?? [] };
  }
  async create(input: Parameters<DockerEngine["create"]>[0]): Promise<string> {
    this.created.push(input);
    this.id = "container-1";
    return this.id;
  }
  async start(): Promise<void> { this.running = true; }
  async restart(): Promise<void> { this.running = true; }
  async stop(): Promise<void> { this.running = false; }
  async remove(): Promise<void> { this.id = undefined; }
}

class RecordingSandboxManager extends InMemorySandboxManager {
  readonly inputs: SandboxEnsureInput[] = [];

  override async ensure(input: SandboxEnsureInput) {
    this.inputs.push(input);
    return super.ensure(input);
  }
}
