import assert from "node:assert/strict";
import test from "node:test";
import { sha256 } from "../src/application/canonical.js";
import { InMemoryFinancialMarketStateStore } from "../src/infrastructure/in-memory-state-store.js";
import { createFinancialMarketAppRouter } from "../src/server/router.js";
import { createFinancialMarketRuntime } from "../src/server/runtime.js";

function mutation(stepId: string, expectedCheckpointRef = "") {
  return {
    transitionId: "runtime-transition",
    stepId,
    payloadDigest: sha256({ stepId }),
    expectedCheckpointRef,
  };
}

test("standalone root router lazily resolves the Context-owned runtime", async () => {
  let calls = 0;
  const service = await createFinancialMarketRuntime({ stateStore: new InMemoryFinancialMarketStateStore() });
  const router = createFinancialMarketAppRouter(async () => {
    calls += 1;
    return service;
  });
  const caller = router.createCaller({});
  const section = {
    accounts: [{ accountId: "account-1", cash: 1_000, positions: { LEEK: 3 }, maximumActionsPerRound: 3 }],
    instruments: [{ symbol: "LEEK", referencePrice: 100 }],
  };

  const initialized = await caller.financialMarket.initialize({
    runId: "runtime-run",
    section,
    mutation: mutation("initialize"),
  });
  assert.equal(initialized.checkpoint.runId, "runtime-run");
  assert.equal(calls, 1);
  const observed = await caller.financialMarket.observe({
    runId: "runtime-run",
    roundId: 1,
    baseline: initialized.checkpoint,
  });
  assert.deepEqual(observed.accounts, [{ accountId: "account-1", cash: 1_000, positions: { LEEK: 3 } }]);
  assert.equal(calls, 2);
});

test("health is process-local and readiness initializes an explicit in-memory Context", async () => {
  const original = process.env.OPENLEEK_FINANCIAL_MARKET_IN_MEMORY;
  process.env.OPENLEEK_FINANCIAL_MARKET_IN_MEMORY = "true";
  try {
    const health = await import("../src/app/health/route.js");
    const ready = await import("../src/app/ready/route.js");
    const healthResponse = health.GET();
    const readyResponse = await ready.GET();
    assert.equal(healthResponse.status, 200);
    assert.equal(readyResponse.status, 200);
    assert.deepEqual(await healthResponse.json(), { status: "ok", service: "financial-market" });
    assert.deepEqual(await readyResponse.json(), { status: "ready", service: "financial-market" });
  } finally {
    if (original === undefined) delete process.env.OPENLEEK_FINANCIAL_MARKET_IN_MEMORY;
    else process.env.OPENLEEK_FINANCIAL_MARKET_IN_MEMORY = original;
  }
});
