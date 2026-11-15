import assert from "node:assert/strict";
import test from "node:test";

import { ToolCallBudgetRegistry, normalizeToolName } from "../src/tool-call-budget";

test("normalizes MCP and built-in aliases", () => {
  assert.equal(normalizeToolName("mcp__financial__get_account"), "financial.get_account");
  assert.equal(normalizeToolName("Bash"), "exec_command");
  assert.equal(normalizeToolName("Write"), "apply_patch");
});

test("allows the configured calls, denies the next call, deduplicates, and resets per Turn", async () => {
  const registry = new ToolCallBudgetRegistry();
  registry.registerSession("thread", { runId: "run", agentId: "agent", workspacePath: "/run/agent", policy: { maxCallsPerToolPerTurn: 2 } });
  let interrupts = 0;
  registry.beginTurn("thread", "turn-1", async () => { interrupts += 1; });
  const input = { sessionId: "thread", turnId: "turn-1", cwd: "/run/agent", toolName: "mcp__social__get_feed" };
  assert.equal(registry.authorize({ ...input, toolUseId: "call-1" }).allowed, true);
  assert.equal(registry.authorize({ ...input, toolUseId: "call-2" }).allowed, true);
  const denied = registry.authorize({ ...input, toolUseId: "call-3" });
  assert.deepEqual(denied, { allowed: false, toolName: "social.get_feed", calls: 3, limit: 2, exhausted: true });
  assert.deepEqual(registry.authorize({ ...input, toolUseId: "call-3" }), denied);
  await Promise.resolve();
  assert.equal(interrupts, 1);
  assert.deepEqual(registry.finishTurn("thread", "turn-1")?.counts, [{ toolName: "social.get_feed", calls: 3 }]);
  registry.beginTurn("thread", "turn-2", async () => { interrupts += 1; });
  assert.equal(registry.authorize({ ...input, turnId: "turn-2", toolUseId: "call-4" }).calls, 1);
});

test("legacy sessions without a policy remain unlimited and produce no evidence", () => {
  const registry = new ToolCallBudgetRegistry();
  registry.registerSession("thread", { runId: "run", agentId: "agent", workspacePath: "/run/agent" });
  assert.equal(registry.observe({ sessionId: "thread", turnId: "turn", cwd: "/run/agent", toolName: "write_stdin", toolUseId: "call" }), undefined);
  assert.equal(registry.finishTurn("thread", "turn"), undefined);
});
