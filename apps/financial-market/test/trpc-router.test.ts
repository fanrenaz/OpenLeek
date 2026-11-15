import assert from "node:assert/strict";
import test from "node:test";
import { sha256 } from "../src/application/canonical.js";
import { FinancialMarketService } from "../src/application/financial-market-service.js";
import { FinancialRevisionService } from "../src/application/revision-service.js";
import { InMemoryFinancialRevisionStore } from "../src/infrastructure/in-memory-revision-store.js";
import { actionsFromCandidates, createFinancialMarketRouter, sectionFromContract } from "../src/interfaces/trpc-router.js";

function mutation(stepId: string, expectedCheckpointRef = ""): {
  transitionId: string;
  stepId: string;
  payloadDigest: string;
  expectedCheckpointRef: string;
} {
  return {
    transitionId: "router-transition",
    stepId,
    payloadDigest: sha256({ stepId }),
    expectedCheckpointRef,
  };
}

test("tRPC router validates contracts and observes only the committed baseline", async () => {
  const service = await FinancialMarketService.create();
  const caller = createFinancialMarketRouter(service).createCaller({});
  const section = {
    accounts: [
      { accountId: "buyer", cash: 1_000, positions: { LEEK: 0 }, maximumActionsPerRound: 3 },
      { accountId: "seller", cash: 0, positions: { LEEK: 5 }, maximumActionsPerRound: 3 },
    ],
    instruments: [{ symbol: "LEEK", referencePrice: 100 }],
  };
  assert.deepEqual(await caller.validate(section), { valid: true });
  const initialized = await caller.initialize({ runId: "run-1", section, mutation: mutation("initialize") });

  // Opening a round may add pending state, but observe is intentionally pinned
  // to the previous committed checkpoint passed by Experiment.
  await caller.open({
    runId: "run-1",
    roundId: 1,
    mutation: mutation("open", initialized.checkpoint.ref),
    baseline: initialized.checkpoint,
  });
  assert.deepEqual(await caller.observe({ runId: "run-1", roundId: 1, baseline: initialized.checkpoint }), {
    accounts: [
      { accountId: "buyer", cash: 1_000, positions: { LEEK: 0 } },
      { accountId: "seller", cash: 0, positions: { LEEK: 5 } },
    ],
    quotes: [{ symbol: "LEEK", last: 100 }],
  });

  const applied = await caller.applyStep({
    runId: "run-1",
    roundId: 1,
    mutation: mutation("apply", initialized.checkpoint.ref),
    baseline: initialized.checkpoint,
    actions: [
      // The same Agent batch is sent to both Contexts; Financial ignores social actions.
      { kind: "social.follow", actionId: "social-action", followerId: "buyer", followeeId: "seller" },
      { kind: "financial.order", actionId: "buy-action", orderId: "buy-order", accountId: "buyer", symbol: "LEEK", side: "buy", quantity: 1, limitPrice: 100, timeInForce: "gtc" },
    ],
  });
  assert.equal(applied.trades.length, 0);
  const sealed = await caller.seal({ runId: "run-1", roundId: 1, mutation: mutation("seal", initialized.checkpoint.ref) });
  await caller.publish({ runId: "run-1", roundId: 1, mutation: mutation("publish", initialized.checkpoint.ref), checkpoint: sealed.checkpoint });
  const facts = await caller.queryCommittedFacts({ runId: "run-1", roundId: 1, checkpointRef: sealed.checkpoint.ref });
  assert.equal(facts.summary.openOrderCount, 1);

  const revisions = await FinancialRevisionService.create({ market: service, store: new InMemoryFinancialRevisionStore() });
  const revision = await revisions.initializeRevision({ runId: "run-1", checkpointRef: sealed.checkpoint.ref });
  const revisionCaller = createFinancialMarketRouter(service, revisions).createCaller({});
  const revisionFacts = await revisionCaller.queryCommittedRevisionFacts({ runId: "run-1", revisionRef: revision.ref });
  assert.equal(revisionFacts.revision.ref, revision.ref);
  assert.equal(revisionFacts.summary.openOrderCount, 1);
  const read = await revisionCaller.freezeFullSnapshot({
    runId: "run-1",
    roundId: 1,
    baseline: revision,
    mutation: mutation("freeze-settlement", revision.ref),
  });
  await assert.rejects(
    () => revisionCaller.mcpBindings({
      runId: "run-1",
      roundId: 1,
      revision: read.revision,
      agents: [{ agentId: "agent-buyer", principalId: "principal:buyer", accountId: "buyer" }],
    } as never),
    /permissions/i,
  );
  const mcpBindings = await revisionCaller.mcpBindings({
    runId: "run-1",
    roundId: 1,
    revision: read.revision,
    agents: [{
      agentId: "agent-buyer",
      principalId: "principal:buyer",
      accountId: "buyer",
      permissions: { tools: ["financial.place_order"], resources: ["financial.market"] },
    }],
  });
  assert.equal(mcpBindings.bindings[0]?.context, "financial");
  assert.deepEqual(await revisionCaller.settlementStatus({
    runId: "run-1",
    roundId: 1,
    finalFailedTurnIds: [],
  }), {
    settled: true,
    pendingIntentCount: 0,
    pendingOutboxCount: 0,
  });
  assert.notEqual(read.revision.ref, revision.ref);
});

test("decimal instrument contracts normalize to fixed-point owner state", () => {
  const section = sectionFromContract({
    accounts: [{ accountId: "buyer", cash: 1_000.25, positions: { LEEK: 0 }, maximumActionsPerRound: 3 }],
    instruments: [{ symbol: "LEEK", referencePrice: 100.05, tickSize: 0.05 }],
  });
  assert.equal(section.initialReferencePrice, 10_005);
  assert.equal(section.accounts[0]?.initialCash, 100_025);
  assert.equal(section.priceScale, 100);
  assert.equal(section.tickSizeUnits, 5);
  const action = actionsFromCandidates([{
    kind: "financial.order", actionId: "action", orderId: "order", accountId: "buyer", symbol: "LEEK",
    side: "buy", quantity: 1, limitPrice: 99.95, timeInForce: "gtc",
  }], 1, { priceScale: 100, tickSizeUnits: 5 })[0];
  assert.equal(action?.type === "submitOrder" ? action.limitPrice : undefined, 9_995);
  assert.throws(() => actionsFromCandidates([{
    kind: "financial.order", actionId: "bad-action", orderId: "bad-order", accountId: "buyer", symbol: "LEEK",
    side: "buy", quantity: 1, limitPrice: 99.96, timeInForce: "gtc",
  }], 1, { priceScale: 100, tickSizeUnits: 5 }), /tickSize 0.05/);
});
