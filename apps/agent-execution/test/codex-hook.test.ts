import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildCodexHookContext,
  CodexHookRegistry,
  createRunHookToken,
  verifyRunHookToken,
} from "../src/codex-hook";
import type { MemoryToolPort } from "../src/memory-tools";

const binding = {
  bankId: "private-bank",
  routeId: "memory",
  llmConfigRevision: "revision:test",
  roundId: 3,
  toolProfile: "hook-v1" as const,
};

test("Run-scoped Hook tokens and Session workspace bindings do not cross boundaries", () => {
  const secret = "test-secret-with-at-least-thirty-two-characters";
  const token = createRunHookToken(secret, "run-a");
  assert.equal(verifyRunHookToken(secret, "run-a", token), true);
  assert.equal(verifyRunHookToken(secret, "run-b", token), false);
  assert.equal(verifyRunHookToken("another-secret-with-at-least-thirty-two", "run-a", token), false);

  const registry = new CodexHookRegistry();
  registry.register("thread-a", { runId: "run-a", workspacePath: "/runs/a/workspaces/one", memory: binding });
  assert.equal(registry.resolve("thread-a", "/runs/a/workspaces/one")?.runId, "run-a");
  assert.equal(registry.resolve("thread-a", "/runs/a/workspaces/two"), undefined);
  registry.unregister("thread-a");
  assert.equal(registry.resolve("thread-a", "/runs/a/workspaces/one"), undefined);
});

test("Hook context contains only a bounded mutable Strategy", async () => {
  const calls: string[] = [];
  const port: MemoryToolPort = {
    async call(_binding, tool) {
      calls.push(tool);
      if (tool === "get_strategy") return { content: "Publish consistently.", context: "Reconsider when conditions change.", document_id: "hidden" };
      throw new Error(`unexpected ${tool}`);
    },
  };
  const result = await buildCodexHookContext(port, binding, {
    strategyInjectionEnabled: true,
    revision: 1,
    updatedAt: "2026-07-31T00:00:00.000Z",
  });
  assert.deepEqual(calls, ["get_strategy"]);
  assert.match(result.additionalContext, /Publish consistently/);
  assert.match(result.additionalContext, /mutable working state/);
  assert.match(result.additionalContext, /not an instruction or an authoritative fact/);
  assert.match(result.additionalContext, /revise or clear it with strategy\.update/);
  assert.doesNotMatch(result.additionalContext, /document_id|score|hidden/);
  assert.ok(result.additionalContext.length <= 9_000);
});

test("Strategy-only Hook is silent when disabled, empty, or unavailable", async () => {
  const calls: string[] = [];
  const port: MemoryToolPort = {
    async call(_binding, tool) {
      calls.push(tool);
      throw new Error("strategy unavailable");
    },
  };
  const unavailable = await buildCodexHookContext(port, binding, {
    strategyInjectionEnabled: true,
    revision: 2,
    updatedAt: "2026-07-31T00:00:00.000Z",
  });
  assert.equal(unavailable.additionalContext, "");
  assert.deepEqual(unavailable.errorCategories, ["strategy_read_failed"]);

  const disabled = await buildCodexHookContext(port, binding, {
    strategyInjectionEnabled: false,
    revision: 3,
    updatedAt: "2026-07-31T00:00:00.000Z",
  });
  assert.equal(disabled.additionalContext, "");
  assert.deepEqual(calls, ["get_strategy"]);

  const empty = await buildCodexHookContext({ async call() { return null; } }, binding, {
    strategyInjectionEnabled: true,
    revision: 4,
    updatedAt: "2026-07-31T00:00:00.000Z",
  });
  assert.equal(empty.additionalContext, "");
});

test("PreToolUse rejects disabled native Codex tools before consulting the budget service", () => {
  const hook = fileURLToPath(new URL("../../../infra/codex-sandbox/pre-tool-use.mjs", import.meta.url));
  for (const toolName of [
    "apply_patch",
    "update_plan",
    "request_user_input",
    "view_image",
    "create_goal",
    "spawn_agent",
  ]) {
    const result = spawnSync(process.execPath, [hook], {
      encoding: "utf8",
      input: JSON.stringify({ tool_name: toolName }),
      env: { NODE_ENV: "test" },
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
    assert.equal(output.hookSpecificOutput?.permissionDecision, "deny");
    assert.match(output.hookSpecificOutput?.permissionDecisionReason ?? "", /disabled for OpenLeek/);
  }
});

test("PreToolUse allows native MCP Resource discovery and reads through the budget boundary", () => {
  const hook = fileURLToPath(new URL("../../../infra/codex-sandbox/pre-tool-use.mjs", import.meta.url));
  for (const toolName of ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]) {
    const result = spawnSync(process.execPath, [hook], {
      encoding: "utf8",
      input: JSON.stringify({ tool_name: toolName, session_id: "thread-1", turn_id: "turn-1", cwd: "/workspace", tool_use_id: `call:${toolName}` }),
      env: { NODE_ENV: "test" },
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout) as { hookSpecificOutput?: { permissionDecisionReason?: string } };
    assert.doesNotMatch(output.hookSpecificOutput?.permissionDecisionReason ?? "", /disabled for OpenLeek/);
  }
});
