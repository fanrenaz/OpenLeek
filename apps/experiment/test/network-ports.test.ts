import assert from "node:assert/strict";
import test from "node:test";

import { dynamicRevision, uniqueVersionRefs } from "../src/server/network-ports.js";

test("AGENTS.md validation deduplicates immutable version references", () => {
  assert.deepEqual(
    uniqueVersionRefs(["agents-md:retail:v1", "agents-md:retail:v1", "agents-md:media:v1"]),
    ["agents-md:retail:v1", "agents-md:media:v1"],
  );
});

test("News owner-specific revision metadata is not persisted by Experiment", () => {
  assert.deepEqual(dynamicRevision({
    ref: "news-revision:run:1:0:abc",
    context: "news",
    runId: "run:1",
    roundId: 0,
    digest: "a".repeat(64),
    scenarioVersionRef: "news-scenario:reference:v:abc",
    releasedThroughRound: 0,
    committed: false,
  }), {
    ref: "news-revision:run:1:0:abc",
    context: "news",
    runId: "run:1",
    roundId: 0,
    digest: "a".repeat(64),
  });
});
