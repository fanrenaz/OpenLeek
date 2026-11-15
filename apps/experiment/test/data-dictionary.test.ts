import assert from "node:assert/strict";
import test from "node:test";
import { experimentDataDictionary } from "../src/server/data-dictionary.js";

test("Experiment publishes assets and Run domain contracts with generic management bindings", () => {
  assert.equal(experimentDataDictionary.schemaVersion, "1");
  assert.equal(experimentDataDictionary.revision, "experiment-domain:2026-08-05-context-v3");
  assert.deepEqual(experimentDataDictionary.entries.map(({ id }) => id), [
    "population", "agent-blueprint", "turn-prompt", "research-template", "experiment-specification",
    "run", "round-progress", "committed-rounds", "committed-manifest",
  ]);
  assert.equal(experimentDataDictionary.entries.find(({ id }) => id === "run")?.management.surface, "run");
  assert.ok(experimentDataDictionary.entries.find(({ id }) => id === "experiment-specification")?.management.capabilities.includes("create"));
});
