import assert from "node:assert/strict";
import test from "node:test";
import { socialMcpToolDefinitions } from "../src/app/internal/mcp/tool-definitions.js";

test("Social MCP descriptions are complete, objective, and implementation-neutral", () => {
  const forbidden = /\b(?:experiment|simulation|round|revision|snapshot|frozen|pinned|scope|worker|worktree|requote)\b/i;
  for (const [name, description, properties] of socialMcpToolDefinitions) {
    assert.ok(description.trim(), `${name} has a description`);
    assert.doesNotMatch(description, forbidden, `${name} does not expose implementation details`);
    for (const [property, schema] of Object.entries(properties)) {
      assert.equal(typeof schema.description, "string", `${name}.${property} has a description`);
      assert.ok(schema.description.trim(), `${name}.${property} has a non-empty description`);
      assert.doesNotMatch(schema.description, forbidden, `${name}.${property} does not expose implementation details`);
    }
  }
});
