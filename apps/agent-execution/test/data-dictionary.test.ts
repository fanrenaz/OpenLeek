import assert from "node:assert/strict";
import test from "node:test";
import { agentExecutionDataDictionary } from "../src/data-dictionary.js";

test("Agent Execution publishes asset and evidence contracts", () => {
  assert.equal(agentExecutionDataDictionary.schemaVersion, "1");
  assert.deepEqual(agentExecutionDataDictionary.entries.map(({ id }) => id), [
    "agent-session-transcript",
    "agents-md", "agent-environment", "skill",
    "agent-token-usage", "agent-runtime-evidence", "agent-committed-facts",
  ]);
  const environment = agentExecutionDataDictionary.entries.find(({ id }) => id === "agent-environment");
  assert.equal(environment?.management.key, "mcp-policy");
  assert.equal(agentExecutionDataDictionary.entries.find(({ id }) => id === "agent-runtime-evidence")?.entryKind, "evidence");
});
