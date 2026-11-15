import assert from "node:assert/strict";
import test from "node:test";
import { FinancialMarketService, type FinancialMarketServiceOptions } from "../src/application/financial-market-service.js";
import { sha256 } from "../src/application/canonical.js";
import { DeterministicOrderBookMatcher } from "../src/application/matching.js";
import { InMemoryFinancialMarketStateStore } from "../src/infrastructure/in-memory-state-store.js";
import type { FinancialMarketSection, MutationHeader } from "../src/domain/models.js";

const validatingExecutor = {
  async validate() { return { valid: true, errors: [] }; },
  async execute() { return { orders: [] }; },
};

async function publishMaker(
  service: FinancialMarketService,
  algorithmId = "test-maker",
  defaultConfig: Record<string, unknown> = {},
) {
  const draft = await service.saveMarketMakerDraft({
    algorithmId,
    name: "Test market maker",
    source: "def generate_orders(context):\n    return []\n",
    defaultConfig,
  });
  return service.publishMarketMaker({ algorithmId: draft.algorithmId, expectedRevision: draft.revision });
}

const initialSection: FinancialMarketSection = {
  initialReferencePrice: 100,
  accounts: [
    { accountId: "buyer", initialCash: 1_000, initialPosition: 0 , maximumActionsPerRound: 3},
    { accountId: "seller", initialCash: 0, initialPosition: 10 , maximumActionsPerRound: 3},
  ],
};

function mutation(stepId: string, expectedCheckpointRef = "checkpoint:financial_market:run-1:round:0"): MutationHeader {
  return {
    transitionId: "transition-1",
    stepId,
    payloadDigest: sha256({ stepId }),
    expectedCheckpointRef: stepId === "initialize" ? "" : expectedCheckpointRef,
  };
}

async function initialized(
  options: FinancialMarketServiceOptions = {},
): Promise<{ service: FinancialMarketService; checkpoint: string }> {
  const service = await FinancialMarketService.create(options);
  const checkpoint = await service.initialize("run-1", initialSection, mutation("initialize"));
  return { service, checkpoint: checkpoint.ref };
}

test("owns risk reserve, partial-fill settlement, and remaining reserve", async () => {
  const { service, checkpoint } = await initialized();
  const result = await service.apply(
    "run-1",
    1,
    [
      { type: "submitOrder", actionId: "buy", accountId: "buyer", side: "buy", quantity: 5, limitPrice: 100 },
      { type: "submitOrder", actionId: "sell", accountId: "seller", side: "sell", quantity: 3, limitPrice: 90 },
    ],
    mutation("apply", checkpoint),
  );

  assert.deepEqual(result.trades.map((trade) => [trade.quantity, trade.price]), [[3, 100]]);
  assert.deepEqual(service.getAccount("run-1", "buyer"), {
    accountId: "buyer", cash: 700, position: 3, maximumActionsPerRound: 3, reservedCash: 200, reservedPosition: 0,
  });
  assert.deepEqual(service.getAccount("run-1", "seller"), {
    accountId: "seller", cash: 300, position: 7, maximumActionsPerRound: 3, reservedCash: 0, reservedPosition: 0,
  });

  await service.closeRound("run-1", 1, mutation("close", checkpoint));
  assert.equal(service.getAccount("run-1", "buyer").reservedCash, 200);
});

test("rejects excess risk and exposes facts only after publish", async () => {
  const { service, checkpoint } = await initialized();
  await assert.rejects(
    service.apply(
      "run-1",
      1,
      [{ type: "submitOrder", actionId: "too-big", accountId: "buyer", side: "buy", quantity: 20, limitPrice: 100 }],
      mutation("too-big", checkpoint),
    ),
    { message: "insufficient available cash" },
  );
  const sealed = await service.seal("run-1", 1, mutation("seal", checkpoint));
  assert.throws(() => service.getCommittedFacts("run-1", 1, sealed.ref), { message: "only committed Market facts are queryable" });
  await service.publish("run-1", 1, sealed.ref, mutation("publish", checkpoint));
  assert.deepEqual(service.getCommittedFacts("run-1", 1, sealed.ref).trades, []);
});

test("IOC releases reserves and FOK never leaves a partial order", async () => {
  const { service, checkpoint } = await initialized();
  await service.apply(
    "run-1",
    1,
    [{ type: "submitOrder", actionId: "ioc-buy", accountId: "buyer", side: "buy", quantity: 5, limitPrice: 100, timeInForce: "ioc" }],
    mutation("ioc", checkpoint),
  );
  assert.equal(service.getAccount("run-1", "buyer").reservedCash, 0);

  const result = await service.apply(
    "run-1",
    1,
    [
      { type: "submitOrder", actionId: "sell-one", accountId: "seller", side: "sell", quantity: 1, limitPrice: 90 },
      { type: "submitOrder", actionId: "fok-buy", accountId: "buyer", side: "buy", quantity: 2, limitPrice: 100, timeInForce: "fok" },
    ],
    mutation("fok", checkpoint),
  );
  assert.deepEqual(result.trades, []);
  assert.equal(service.getAccount("run-1", "buyer").reservedCash, 0);
  assert.equal(service.getAccount("run-1", "seller").position, 10);
  assert.equal(service.getAccount("run-1", "seller").reservedPosition, 1);
});

test("true market IOC consumes resting depth without persisting a synthetic price", async () => {
  const { service, checkpoint } = await initialized();
  const base = service.getFullSnapshot("run-1", checkpoint);
  const result = service.materializeRoundFromSnapshot({
    runId: "run-1",
    roundId: 1,
    base,
    actions: [
      { type: "submitOrder", actionId: "ask", accountId: "seller", side: "sell", quantity: 3, limitPrice: 90 },
      { type: "submitMarketOrder", actionId: "market-buy", accountId: "buyer", side: "buy", quantity: 5, timeInForce: "ioc" },
    ],
  });

  assert.deepEqual(result.trades.map((trade) => [trade.quantity, trade.price]), [[3, 90]]);
  const marketOrder = result.material.orders.find((order) => order.orderId === "market-buy")!;
  assert.equal(marketOrder.orderType, "market");
  assert.equal(marketOrder.limitPrice, undefined);
  assert.equal(marketOrder.status, "cancelled");
  assert.equal(result.material.accounts.find((account) => account.accountId === "buyer")!.cash, 730);
});

test("market FOK and atomic replace reject without leaking partial state", async () => {
  const { service, checkpoint } = await initialized();
  const base = service.getFullSnapshot("run-1", checkpoint);
  assert.throws(() => service.materializeRoundFromSnapshot({
    runId: "run-1",
    roundId: 1,
    base,
    actions: [
      { type: "submitOrder", actionId: "ask", accountId: "seller", side: "sell", quantity: 2, limitPrice: 90 },
      { type: "submitMarketOrder", actionId: "market-fok", accountId: "buyer", side: "buy", quantity: 3, timeInForce: "fok" },
    ],
  }), /cannot be filled in full/);

  const replaced = service.materializeRoundFromSnapshot({
    runId: "run-1",
    roundId: 1,
    base,
    actions: [
      { type: "submitOrder", actionId: "old", accountId: "buyer", side: "buy", quantity: 2, limitPrice: 80 },
      {
        type: "replaceOrder",
        actionId: "replace-old",
        accountId: "buyer",
        orderId: "old",
        replacementOrderId: "new",
        side: "buy",
        quantity: 2,
        limitPrice: 85,
      },
    ],
  }).material;
  assert.equal(replaced.orders.find((order) => order.orderId === "old")!.status, "replaced");
  assert.equal(replaced.orders.find((order) => order.orderId === "old")!.replacedByOrderId, "new");
  assert.equal(replaced.orders.find((order) => order.orderId === "new")!.replacesOrderId, "old");
});

test("restores open orders and idempotency records after a restart", async () => {
  const store = new InMemoryFinancialMarketStateStore();
  const { service, checkpoint } = await initialized({ stateStore: store });
  await service.apply(
    "run-1",
    1,
    [{ type: "submitOrder", actionId: "buy", accountId: "buyer", side: "buy", quantity: 2, limitPrice: 10 }],
    mutation("apply", checkpoint),
  );
  const restarted = await FinancialMarketService.create({ stateStore: store });
  const replay = await restarted.apply(
    "run-1",
    1,
    [{ type: "submitOrder", actionId: "ignored", accountId: "buyer", side: "buy", quantity: 1, limitPrice: 1 }],
    mutation("apply", checkpoint),
  );

  assert.deepEqual(replay.trades, []);
  assert.equal(restarted.getAccount("run-1", "buyer").reservedCash, 20);
  assert.equal(restarted.getSealedCheckpoint("run-1", 0).ref, checkpoint);
});

test("restores an explicitly published Market Maker without injecting assets", async () => {
  const store = new InMemoryFinancialMarketStateStore();
  const initial = await FinancialMarketService.create({ stateStore: store, marketMakerExecutor: validatingExecutor });
  const published = await publishMaker(initial);
  const restarted = await FinancialMarketService.create({ stateStore: store, marketMakerExecutor: validatingExecutor });
  assert.deepEqual(restarted.getMarketMakerVersion(published.versionRef), published);
  assert.equal(restarted.listMarketMakers().versions.length, 1);
});

test("rebuilds a deterministic book from persisted open orders before settlement", async () => {
  const store = new InMemoryFinancialMarketStateStore();
  const { service, checkpoint } = await initialized({ stateStore: store, matcher: new DeterministicOrderBookMatcher() });
  await service.apply(
    "run-1",
    1,
    [{ type: "submitOrder", actionId: "buy", accountId: "buyer", side: "buy", quantity: 5, limitPrice: 100 }],
    mutation("buy", checkpoint),
  );
  const restarted = await FinancialMarketService.create({ stateStore: store, matcher: new DeterministicOrderBookMatcher() });
  const result = await restarted.apply(
    "run-1",
    1,
    [{ type: "submitOrder", actionId: "sell", accountId: "seller", side: "sell", quantity: 3, limitPrice: 90 }],
    mutation("sell", checkpoint),
  );

  assert.deepEqual(result.trades.map((trade) => [trade.buyOrderId, trade.sellOrderId, trade.quantity, trade.price]), [["buy", "sell", 3, 100]]);
  assert.deepEqual(restarted.getAccount("run-1", "buyer"), {
    accountId: "buyer", cash: 700, position: 3, maximumActionsPerRound: 3, reservedCash: 200, reservedPosition: 0,
  });
});

test("does not retain the removed liquidity policy as an implicit market maker", async () => {
  const service = await FinancialMarketService.create();
  const checkpoint = await service.initialize(
    "run-1",
    {
      initialReferencePrice: 100,
      accounts: [{ accountId: "maker", initialCash: 1_000, initialPosition: 5 , maximumActionsPerRound: 3}],
    },
    mutation("initialize"),
  );
  const opening = await service.openRound("run-1", 1, mutation("open", checkpoint.ref));
  assert.deepEqual([opening.bestBid, opening.bestAsk, opening.openOrderCount], [0, 0, 0]);
});

test("opens with an empty Financial asset library", async () => {
  const service = await FinancialMarketService.create();
  assert.deepEqual(service.listFinancialInitialStatePresets(), { drafts: [], versions: [] });
  assert.deepEqual(service.listMarketMakers(), { drafts: [], versions: [] });
});

test("Financial Preset tombstones are revision-checked and retain immutable audit data", async () => {
  const service = await FinancialMarketService.create();
  const draft = await service.saveFinancialInitialStatePresetDraft({
    presetId: "financial-preset:delete-test",
    name: "Delete test",
    definition: { mode: "fixed", cash: 1_000, positions: { LEEK: 2 } },
  });
  await assert.rejects(
    service.deleteFinancialInitialStatePresetDraft({ presetId: draft.presetId, expectedRevision: draft.revision + 1, idempotencyKey: "wrong" }),
    /draft has changed/,
  );
  assert.equal((await service.deleteFinancialInitialStatePresetDraft({ presetId: draft.presetId, expectedRevision: draft.revision, idempotencyKey: "delete-draft" })).status, "deleted");
  assert.equal((await service.deleteFinancialInitialStatePresetDraft({ presetId: draft.presetId, expectedRevision: draft.revision, idempotencyKey: "delete-draft" })).replayed, true);
  assert.equal(service.listFinancialInitialStatePresets().drafts.length, 0);
  const retainedDraft = service.getFinancialInitialStatePresetDraft(draft.presetId, true);
  assert.equal(retainedDraft.mode, "fixed");
  assert.equal(retainedDraft.mode === "fixed" ? retainedDraft.cash : undefined, 1_000);
  await assert.rejects(service.saveFinancialInitialStatePresetDraft({ presetId: draft.presetId, name: draft.name, definition: { mode: "fixed", cash: 1_000, positions: { LEEK: 2 } } }), /cannot be reused/);

  const versionDraft = await service.saveFinancialInitialStatePresetDraft({
    presetId: "financial-preset:version-delete-test",
    name: "Version delete test",
    definition: { mode: "fixed", cash: 2_000, positions: {} },
  });
  const version = await service.publishFinancialInitialStatePreset({ presetId: versionDraft.presetId, expectedRevision: versionDraft.revision });
  const dependentDraft = await service.saveFinancialInitialStatePresetDraft({
    presetId: "financial-preset:dependent-delete-test",
    name: "Deleted dependency",
    definition: {
      mode: "population_relative",
      sourcePresetVersionRefs: [version.versionRef],
      wealthFraction: 0.5,
      targetAssetValueFraction: 0.5,
      symbol: "LEEK",
    },
  });
  await service.deleteFinancialInitialStatePresetVersion({ versionRef: version.versionRef, idempotencyKey: "delete-version" });
  assert.throws(() => service.getFinancialInitialStatePresetVersion(version.versionRef), /does not exist/);
  assert.equal(service.getFinancialInitialStatePresetVersion(version.versionRef, true).artifactDigest, version.artifactDigest);
  assert.equal(service.listFinancialInitialStatePresets().versions.length, 0);
  assert.equal(service.listFinancialInitialStatePresets(true).versions[0]?.versionRef, version.versionRef);
  await assert.rejects(service.publishFinancialInitialStatePreset({ presetId: versionDraft.presetId, expectedRevision: versionDraft.revision }), /identical content belongs to a deleted/);
  await assert.rejects(
    service.publishFinancialInitialStatePreset({ presetId: dependentDraft.presetId, expectedRevision: dependentDraft.revision }),
    /does not exist/,
  );
  await assert.rejects(
    service.saveFinancialInitialStatePresetDraft({
      presetId: "financial-preset:new-deleted-dependency",
      name: "New deleted dependency",
      definition: {
        mode: "population_relative",
        sourcePresetVersionRefs: [version.versionRef],
        wealthFraction: 0.5,
        targetAssetValueFraction: 0.5,
        symbol: "LEEK",
      },
    }),
    /does not exist/,
  );
});

test("resolves deterministic issuance and population-relative maker funding", async () => {
  const service = await FinancialMarketService.create();
  const retailDraft = await service.saveFinancialInitialStatePresetDraft({
    presetId: "retail-test",
    name: "Retail test",
    definition: {
      mode: "deterministic_issuance",
      cash: 100_000,
      symbol: "LEEK",
      issuePrice: 100,
      buckets: [
        { weight: 1, spendCashFraction: 0 },
        { weight: 1, spendCashFraction: 1 },
      ],
      seedSalt: "test",
    },
  });
  const retail = await service.publishFinancialInitialStatePreset({ presetId: retailDraft.presetId, expectedRevision: retailDraft.revision });
  const makerDraft = await service.saveFinancialInitialStatePresetDraft({
    presetId: "maker-test",
    name: "Maker test",
    definition: {
      mode: "population_relative",
      sourcePresetVersionRefs: [retail.versionRef],
      wealthFraction: 0.3,
      targetAssetValueFraction: 0.5,
      symbol: "LEEK",
    },
  });
  const makerPreset = await service.publishFinancialInitialStatePreset({ presetId: makerDraft.presetId, expectedRevision: makerDraft.revision });
  const first = service.resolveFinancialInitialStatePreset({
    versionRef: retail.versionRef,
    seed: "42",
    subjectId: "agent-1",
    referencePrices: { LEEK: 100 },
    population: [],
  });
  const replay = service.resolveFinancialInitialStatePreset({
    versionRef: retail.versionRef,
    seed: "42",
    subjectId: "agent-1",
    referencePrices: { LEEK: 100 },
    population: [],
  });
  assert.deepEqual(replay, first);
  assert.equal(first.cash + first.positions.LEEK! * 100, 100_000);
  const buckets = new Set(Array.from({ length: 256 }, (_, index) => service.resolveFinancialInitialStatePreset({
    versionRef: retail.versionRef,
    seed: "42",
    subjectId: `agent-${index}`,
    referencePrices: { LEEK: 100 },
    population: [],
  }).cash));
  assert.deepEqual([...buckets].sort((left, right) => left - right), [0, 100_000]);

  const maker = service.resolveFinancialInitialStatePreset({
    versionRef: makerPreset.versionRef,
    seed: "42",
    subjectId: "maker",
    referencePrices: { LEEK: 100 },
    population: [
      { initialStatePresetVersionRef: retail.versionRef, cash: 100_000, positions: { LEEK: 0 } },
      { initialStatePresetVersionRef: retail.versionRef, cash: 0, positions: { LEEK: 1_000 } },
    ],
  });
  assert.equal(maker.cash + maker.positions.LEEK! * 100, 60_000);
});

test("Market Maker config treats the run selection as overrides of published defaults", async () => {
  let observedConfig: Record<string, unknown> | undefined;
  const service = await FinancialMarketService.create({
    marketMakerExecutor: {
      async validate() { return { valid: true, errors: [] }; },
      async execute(input) {
        observedConfig = input.config;
        return { orders: [] };
      },
    },
  });
  const maker = await publishMaker(service, "inventory-ladder", {
    baseOrderSize: 10,
    targetAssetValueFraction: 0.5,
    distanceCurve: 1.6,
    levelSizeDecay: 0.85,
  });
  await service.executeMarketMaker({
    selection: {
      versionRef: maker.versionRef,
      accountId: "maker",
      timing: "opening",
      config: { baseOrderSize: 17 },
    },
    roundId: 1,
    seed: "seed",
    financialHistory: { endpoint: "http://financial.test/history", capability: "opaque-capability" },
  });
  assert.equal(observedConfig?.baseOrderSize, 17);
  assert.equal(observedConfig?.targetAssetValueFraction, 0.5);
  assert.equal(observedConfig?.distanceCurve, 1.6);
  assert.equal(observedConfig?.levelSizeDecay, 0.85);
});

test("Financial canonicalization accepts finite algorithm fractions only", () => {
  assert.equal(sha256({ config: { ratio: 0.5 } }), sha256({ config: { ratio: 0.5 } }));
  assert.throws(() => sha256({ config: { ratio: Number.NaN } }), /finite numbers/);
  assert.throws(() => sha256({ config: { ratio: Number.POSITIVE_INFINITY } }), /finite numbers/);
});

test("incremental materialization settles and requotes after each individual trade", async () => {
  const service = await FinancialMarketService.create({ marketMakerExecutor: validatingExecutor });
  const builtin = await publishMaker(service, "incremental-test-maker");
  const checkpoint = await service.initialize("incremental-run", {
    initialReferencePrice: 100,
    accounts: [
      { accountId: "buyer", initialCash: 1_000, initialPosition: 0, maximumActionsPerRound: 3 },
      { accountId: "maker", initialCash: 0, initialPosition: 2, maximumActionsPerRound: 0 },
    ],
    marketMaker: {
      versionRef: builtin.versionRef,
      accountId: "maker",
      timing: "opening",
      matchingPolicy: "incremental",
      requotePolicy: "after_each_trade",
      maxRequotesPerIntent: 10,
      config: { spreadTicks: 2, quoteQuantity: 1 },
    },
  }, {
    transitionId: "initialize-incremental",
    stepId: "initialize",
    payloadDigest: sha256({ runId: "incremental-run" }),
    expectedCheckpointRef: "",
  });
  const observedMakerPositions: number[] = [];
  const result = await service.materializeRoundIncrementallyFromSnapshot({
    runId: "incremental-run",
    roundId: 1,
    base: service.getFullSnapshot("incremental-run", checkpoint.ref),
    openingMarketMakerOrders: [{ side: "sell", limitPrice: 100, quantity: 1 }],
    actions: [{ type: "submitOrder", actionId: "buy-two", accountId: "buyer", side: "buy", quantity: 2, limitPrice: 100 }],
    afterTrade: async ({ material }) => {
      const position = material.accounts.find((account) => account.accountId === "maker")!.position;
      observedMakerPositions.push(position);
      return position > 0 ? [{ side: "sell", limitPrice: 100, quantity: 1 }] : [];
    },
  });

  assert.deepEqual(result.trades.map((trade) => trade.quantity), [1, 1]);
  assert.deepEqual(observedMakerPositions, [1, 0]);
  assert.equal(result.material.accounts.find((account) => account.accountId === "buyer")!.position, 2);
});

test("committed facts and forks use seal-time snapshots, never later pending state", async () => {
  const { service, checkpoint } = await initialized();
  await service.apply(
    "run-1",
    1,
    [
      { type: "submitOrder", actionId: "buy-1", accountId: "buyer", side: "buy", quantity: 2, limitPrice: 100 },
      { type: "submitOrder", actionId: "sell-1", accountId: "seller", side: "sell", quantity: 2, limitPrice: 90 },
    ],
    mutation("apply-1", checkpoint),
  );
  const sealed = await service.seal("run-1", 1, mutation("seal-1", checkpoint));
  await service.publish("run-1", 1, sealed.ref, mutation("publish-1", checkpoint));
  await service.openRound("run-1", 2, mutation("open-2", sealed.ref));
  await service.apply(
    "run-1",
    2,
    [{ type: "submitOrder", actionId: "pending-buy", accountId: "buyer", side: "buy", quantity: 1, limitPrice: 100 }],
    mutation("apply-2", sealed.ref),
  );

  const committed = service.getCommittedFacts("run-1", 1, sealed.ref);
  assert.equal(committed.summary.openOrderCount, 0);
  assert.equal(committed.trades.length, 1);
  const fork = await service.fork("run-1", "run-2", sealed.ref, mutation("fork", sealed.ref));
  assert.equal(fork.runId, "run-2");
  assert.equal(service.getAccount("run-2", "buyer").reservedCash, 0);
  assert.equal(service.getCommittedFacts("run-2", 1, fork.ref).trades.length, 1);
});

test("rolls back a whole failed action batch and prevents self-trades", async () => {
  const { service, checkpoint } = await initialized();
  await assert.rejects(
    service.apply(
      "run-1",
      1,
      [
        { type: "submitOrder", actionId: "valid-first", accountId: "buyer", side: "buy", quantity: 1, limitPrice: 100 },
        { type: "submitOrder", actionId: "invalid-second", accountId: "buyer", side: "buy", quantity: 99, limitPrice: 100 },
      ],
      mutation("atomic", checkpoint),
    ),
  );
  assert.equal(service.getAccount("run-1", "buyer").reservedCash, 0);

  const selfService = await FinancialMarketService.create();
  const selfCheckpoint = await selfService.initialize(
    "self-run",
    { initialReferencePrice: 100, accounts: [{ accountId: "maker", initialCash: 1_000, initialPosition: 10 , maximumActionsPerRound: 3}, { accountId: "other", initialCash: 0, initialPosition: 1 , maximumActionsPerRound: 3}] },
    { ...mutation("initialize"), transitionId: "self-transition" },
  );
  const selfResult = await selfService.apply(
    "self-run",
    1,
    [
      { type: "submitOrder", actionId: "self-ask", accountId: "maker", side: "sell", quantity: 1, limitPrice: 90 },
      { type: "submitOrder", actionId: "other-ask", accountId: "other", side: "sell", quantity: 1, limitPrice: 95 },
      { type: "submitOrder", actionId: "self-buy", accountId: "maker", side: "buy", quantity: 1, limitPrice: 100 },
    ],
    { ...mutation("self-apply", selfCheckpoint.ref), transitionId: "self-transition" },
  );
  assert.deepEqual(selfResult.trades.map((trade) => [trade.buyOrderId, trade.sellOrderId]), [["self-buy", "other-ask"]]);
});
