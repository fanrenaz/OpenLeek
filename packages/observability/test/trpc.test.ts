import assert from "node:assert/strict";
import test from "node:test";

import { observeProcedure, safeBusinessIdentifiers } from "../src/trpc";

test("safeBusinessIdentifiers admits only opaque canonical-looking identifiers", () => {
  assert.deepEqual(safeBusinessIdentifiers({
    runId: "run-1",
    roundId: 4,
    agentId: "agent:alpha",
    prompt: "secret-sentinel",
  }), {
    "openleek.run_id": "run-1",
    "openleek.round_id": 4,
    "openleek.agent_id": "agent:alpha",
  });
  assert.deepEqual(safeBusinessIdentifiers({
    runId: "secret sentinel with spaces",
    roundId: -1,
    agentId: "https://example.test/?token=secret",
  }), {});
});

test("observeProcedure returns explicit tRPC v11 failures without requiring a throw", async () => {
  const failure = { ok: false as const, error: { code: "UNAUTHORIZED" } };
  const result = await observeProcedure({
    path: "experiment.get",
    type: "query",
    rawInput: { runId: "run-1" },
  }, async () => failure);
  assert.equal(result, failure);
});
