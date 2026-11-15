import assert from "node:assert/strict";
import test from "node:test";
import type { ConsolePorts } from "../src/server/ports.js";
import { observerRunHead, observerRunRounds } from "../src/server/observer-runs.js";

const manifest = (roundId: number) => ({
  schemaVersion: "3" as const,
  ref: `manifest:run:observer:round:${roundId}`,
  runId: "run:observer",
  roundId,
  state: "committed",
  agentExecution: {
    ref: `revision:agent_execution:run:observer:${roundId}`,
    context: "agent_execution",
    runId: "run:observer",
    roundId,
    digest: "a".repeat(64),
  },
  contexts: { social: {
    ref: `revision:social_environment:run:observer:candidate:${roundId}:abcdef0123456789`,
    context: "social_environment",
    runId: "run:observer",
    roundId,
    digest: "b".repeat(64),
  }, financial: {
    ref: `revision:financial_market:run:observer:${"c".repeat(64)}`,
    context: "financial_market",
    runId: "run:observer",
    roundId,
    digest: "c".repeat(64),
  } },
  digest: "e".repeat(64),
});

test("observer HEAD unwraps the Run record and its timeline sorts numeric rounds", async () => {
  const current = manifest(10);
  const ports = {
    getRun: async () => ({
      status: {
        runId: "run:observer",
        lifecycle: "running",
        committedRound: 10,
        configuredRounds: 100,
        conditionDigest: "d".repeat(64),
        committedManifestRef: current.ref,
      },
    }),
    committedManifest: async () => current,
    committedRounds: async () => ({
      items: [manifest(1), manifest(10), manifest(2)],
    }),
  } as unknown as ConsolePorts;

  const head = await observerRunHead("run:observer", ports);
  assert.equal(head.lifecycle, "running");
  assert.equal(head.manifest?.roundId, 10);
  const rounds = await observerRunRounds("run:observer", { limit: 100 }, ports);
  assert.deepEqual(rounds.items.map(({ roundId }) => roundId), [1, 2, 10]);
});
