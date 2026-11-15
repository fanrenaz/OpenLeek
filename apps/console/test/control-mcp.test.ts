import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createControlMcpServer } from "../src/server/control-mcp.js";
import type { ConsolePorts } from "../src/server/ports.js";

async function toolsFor(factory: (ports: ConsolePorts) => ReturnType<typeof createControlMcpServer>, ports = {} as ConsolePorts) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = factory(ports);
  const client = new Client({ name: "control-mcp-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const listed = await client.listTools();
  return { client, server, names: listed.tools.map((tool) => tool.name).sort() };
}

test("Control publishes management and committed observer tools without page proposal tools", async () => {
  const control = await toolsFor(createControlMcpServer);
  try {
    assert.equal(control.names.includes("propose_page_change"), false);
    for (const slug of [
      "agents_md", "turn_prompt", "mcp_policy", "skill", "population",
      "agent_blueprint", "social_network", "financial_preset",
      "feed_algorithm", "market_maker",
    ]) {
      for (const prefix of ["save", "publish", "delete"]) {
        assert.equal(control.names.some((name) => name.startsWith(`${prefix}_${slug}`)), true);
      }
      assert.equal(control.names.includes(`save_${slug}_draft`), true);
      assert.equal(control.names.includes(`publish_${slug}`), true);
      assert.equal(control.names.includes(`delete_${slug}_draft`), true);
      assert.equal(control.names.includes(`delete_${slug}_version`), true);
    }
    for (const tool of ["create_run", "resume_run", "retry_run", "cancel_run", "fork_run"]) {
      assert.equal(control.names.includes(tool), true);
    }
    for (const tool of ["read_run_observer", "read_context_revision"]) {
      assert.equal(control.names.includes(tool), true);
    }
    assert.equal(control.names.includes("get_run_hook_policy"), true);
    assert.equal(control.names.includes("update_run_hook_policy"), true);
  } finally {
    await control.client.close();
  }
});

test("Control reads and updates Run Codex Hook policy through Agent Execution", async () => {
  let updateInput: unknown;
  const ports = {
    async agentHookPolicy() {
      return { strategyInjectionEnabled: true, revision: 4, updatedAt: "2026-07-31T00:00:00.000Z" };
    },
    async updateAgentHookPolicy(input: unknown) {
      updateInput = input;
      return { policy: { strategyInjectionEnabled: false, revision: 5, updatedAt: "2026-07-31T01:00:00.000Z" }, replayed: false };
    },
  } as unknown as ConsolePorts;
  const connected = await toolsFor(createControlMcpServer, ports);
  try {
    const read = await connected.client.callTool({ name: "get_run_hook_policy", arguments: { runId: "run:hook" } });
    assert.equal((read.structuredContent as { revision?: number }).revision, 4);
    const updated = await connected.client.callTool({
      name: "update_run_hook_policy",
      arguments: {
        runId: "run:hook",
        strategyInjectionEnabled: false,
        expectedRevision: 4,
        idempotencyKey: "hook-policy-1",
      },
    });
    assert.deepEqual(updateInput, {
      runId: "run:hook",
      strategyInjectionEnabled: false,
      expectedRevision: 4,
      idempotencyKey: "hook-policy-1",
    });
    assert.equal((updated.structuredContent as { policy?: { revision?: number } }).policy?.revision, 5);
  } finally {
    await connected.client.close();
  }
});

test("Control observer tools resolve current or historical generic Context revisions", async () => {
  const manifests = {
    current: observerManifest("manifest:current", 7, "financial:7", "social:7"),
    historical: observerManifest("manifest:historical", 2, "financial:2", "social:2"),
  };
  const manifestInputs: unknown[] = [];
  const ports = {
    async getRun() {
      return {
        status: {
          runId: "run:observer",
          lifecycle: "running",
          committedRound: 7,
          configuredRounds: 10,
          conditionDigest: "d".repeat(64),
          committedManifestRef: manifests.current.ref,
        },
      };
    },
    async committedManifest(input: { manifestRef?: string }) {
      manifestInputs.push(input);
      return input.manifestRef === manifests.historical.ref ? manifests.historical : manifests.current;
    },
  } as unknown as ConsolePorts;
  const connected = await toolsFor(createControlMcpServer, ports);
  try {
    const head = await connected.client.callTool({
      name: "read_run_observer",
      arguments: { runId: "run:observer", view: "head" },
    });
    assert.equal((head.structuredContent as { manifest?: { roundId?: number } }).manifest?.roundId, 7);

    const historical = await connected.client.callTool({ name: "read_context_revision", arguments: { runId: "run:observer", manifestRef: manifests.historical.ref, contextId: "financial" } });
    assert.equal((historical.structuredContent as { ref?: string }).ref, "financial:2");
    const current = await connected.client.callTool({ name: "read_context_revision", arguments: { runId: "run:observer", contextId: "social" } });
    assert.equal((current.structuredContent as { ref?: string }).ref, "social:7");
    assert.deepEqual(manifestInputs.at(-1), { runId: "run:observer" });
  } finally {
    await connected.client.close();
  }
});

test("Control forwards owner deletion inputs and returns the owner result", async () => {
  let received: unknown;
  const ports = {
    async deleteSkillDraft(input: unknown) {
      received = input;
      return { status: "deleted", target: "draft", id: "skill:test" };
    },
  } as unknown as ConsolePorts;
  const connected = await toolsFor(createControlMcpServer, ports);
  try {
    const response = await connected.client.callTool({
      name: "delete_skill_draft",
      arguments: { assetId: "skill:test", expectedRevision: 3, idempotencyKey: "delete-skill-1" },
    });
    assert.deepEqual(received, { skillId: "skill:test", expectedRevision: 3, idempotencyKey: "delete-skill-1" });
    assert.equal((response.structuredContent as { status?: string } | undefined)?.status, "deleted");
  } finally {
    await connected.client.close();
  }
});

test("Control redacts Hindsight LLM configuration secrets", async () => {
  const ports = {
    async llmConfigGraph() {
      return {
        revision: "revision:1",
        resources: [{
          kind: "provider",
          id: "main",
          value: { base_url: "https://example.test", api_key: "do-not-return" },
          schema: { fields: [{ path: "api_key", secret: true }] },
        }],
      };
    },
  } as unknown as ConsolePorts;
  const connected = await toolsFor(createControlMcpServer, ports);
  try {
    assert.equal(connected.names.includes("patch_llm_config"), true);
    const response = await connected.client.callTool({ name: "read_llm_config", arguments: { view: "graph" } });
    assert.doesNotMatch(JSON.stringify(response), /do-not-return/);
    assert.match(JSON.stringify(response), /\*\*\*\*\*\*/);
  } finally {
    await connected.client.close();
  }
});

test("Control returns a valid null MCP result before Run progress exists", async () => {
  const ports = {
    async roundProgress() { return undefined; },
  } as unknown as ConsolePorts;
  const connected = await toolsFor(createControlMcpServer, ports);
  try {
    const response = await connected.client.callTool({
      name: "read_run",
      arguments: { runId: "run:queued", view: "progress" },
    });
    assert.deepEqual(response.structuredContent, { value: null });
  } finally {
    await connected.client.close();
  }
});

test("Control exposes paginated Agent transcripts with filters intact", async () => {
  let received: unknown;
  const ports = {
    async agentTranscripts(input: unknown) {
      received = input;
      return { availability: "available", items: [{ transcriptRef: "transcript:test", prompt: "tick" }] };
    },
  } as unknown as ConsolePorts;
  const connected = await toolsFor(createControlMcpServer, ports);
  try {
    const response = await connected.client.callTool({ name: "read_run", arguments: { runId: "run:transcript", view: "transcript", agentId: "agent:1", roundId: 3, limit: 10 } });
    assert.deepEqual(received, { runId: "run:transcript", limit: 10, agentId: "agent:1", roundId: 3 });
    assert.equal((response.structuredContent as { availability?: string }).availability, "available");
  } finally {
    await connected.client.close();
  }
});

test("Control HTTP route uniformly rejects missing, incorrect, host, and origin credentials", async () => {
  const previous = { ...process.env };
  Object.assign(process.env, {
    OPENLEEK_CONSOLE_ACCESS_PASSWORD: "test-console-password",
    OPENLEEK_CONSOLE_PUBLIC_ORIGIN: "https://openleek.noesis-ai.com",
    OPENLEEK_EXPERIMENT_URL: "http://experiment.test",
    OPENLEEK_AGENT_EXECUTION_URL: "http://agent.test",
    OPENLEEK_SOCIAL_ENVIRONMENT_URL: "http://social.test",
    OPENLEEK_FINANCIAL_MARKET_URL: "http://financial.test",
  });
  try {
    const { POST } = await import("../src/app/api/control/mcp/route.js");
    const request = (url: string, authorization?: string, origin?: string) => new Request(url, {
      method: "POST",
      headers: {
        host: new URL(url).host,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(authorization ? { authorization } : {}),
        ...(origin ? { origin } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "route-test", version: "1.0.0" },
        },
      }),
    });

    for (const candidate of [
      request("https://openleek.noesis-ai.com/api/control/mcp"),
      request("https://openleek.noesis-ai.com/api/control/mcp", "Bearer wrong"),
      request("https://wrong.example/api/control/mcp", "Bearer test-console-password"),
      request("https://openleek.noesis-ai.com/api/control/mcp", "Bearer test-console-password", "https://wrong.example"),
    ]) {
      const response = await POST(candidate);
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: "invalid_token" });
    }

    const accepted = await POST(request(
      "https://openleek.noesis-ai.com/api/control/mcp",
      "Bearer test-console-password",
      "https://openleek.noesis-ai.com",
    ));
    assert.equal(accepted.status, 200);
    assert.doesNotMatch(await accepted.text(), /test-console-password/);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
  }
});

function observerManifest(ref: string, roundId: number, financialRef: string, socialRef: string) {
  return {
    schemaVersion: "3",
    ref,
    runId: "run:observer",
    roundId,
    state: "committed",
    agentExecution: {
      ref: `agent:${roundId}`,
      context: "agent_execution",
      runId: "run:observer",
      roundId,
      digest: "a".repeat(64),
    },
    contexts: { social: {
      ref: socialRef,
      context: "social_environment",
      runId: "run:observer",
      roundId,
      digest: "b".repeat(64),
    }, financial: {
      ref: financialRef,
      context: "financial_market",
      runId: "run:observer",
      roundId,
      digest: "c".repeat(64),
    } },
    digest: "e".repeat(64),
  };
}
