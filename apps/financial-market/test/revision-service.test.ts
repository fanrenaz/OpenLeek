import assert from "node:assert/strict";
import test from "node:test";
import { type FinancialMcpPermissions } from "@openleek/contracts/agent";
import { sha256 } from "../src/application/canonical.js";
import { FinancialMarketService } from "../src/application/financial-market-service.js";
import type { MarketMakerExecutor } from "../src/application/market-maker-executor.js";
import { FinancialRevisionService, type FinancialMcpCredentialVerifier } from "../src/application/revision-service.js";
import { FinancialMarketWorktreeWorker } from "../src/application/revision-worker.js";
import { InMemoryFinancialMarketStateStore } from "../src/infrastructure/in-memory-state-store.js";
import { InMemoryFinancialRevisionStore } from "../src/infrastructure/in-memory-revision-store.js";

function mutation(stepId: string, expectedCheckpointRef = "") {
  return {
    transitionId: "revision-test",
    stepId,
    payloadDigest: sha256({ stepId, expectedCheckpointRef }),
    expectedCheckpointRef,
  };
}

async function publishMaker(market: FinancialMarketService, algorithmId: string) {
  const draft = await market.saveMarketMakerDraft({
    algorithmId,
    name: "Revision test market maker",
    source: "def generate_orders(context):\n    return []\n",
    defaultConfig: { spreadTicks: 2, quoteQuantity: 1 },
  });
  return market.publishMarketMaker({ algorithmId: draft.algorithmId, expectedRevision: draft.revision });
}

async function fixture(maximumActionsPerRound = 3, sellerInitialPosition = 10) {
  const marketStore = new InMemoryFinancialMarketStateStore();
  const revisionStore = new InMemoryFinancialRevisionStore();
  const market = await FinancialMarketService.create({ stateStore: marketStore });
  const checkpoint = await market.initialize(
    "revision-run",
    {
      symbol: "LEEK",
      initialReferencePrice: 100,
      accounts: [
        { accountId: "buyer", initialCash: 1_000, initialPosition: 0, maximumActionsPerRound },
        { accountId: "seller", initialCash: 0, initialPosition: sellerInitialPosition, maximumActionsPerRound },
      ],
    },
    mutation("initialize"),
  );
  const revisions = await FinancialRevisionService.create({
    market,
    store: revisionStore,
    credentialVerifier: credentials,
    endpoint: "http://financial.test/internal/mcp",
    now: () => new Date("2026-07-19T00:00:00.000Z"),
  });
  const initial = await revisions.initializeRevision({ runId: "revision-run", checkpointRef: checkpoint.ref });
  const read = await revisions.freezeFullSnapshot({ runId: "revision-run", roundId: 1, baseline: initial });
  await revisions.openWorktree({ runId: "revision-run", roundId: 1, baseRevision: initial, readRevision: read });
  return { market, marketStore, revisionStore, revisions, initial, read, bearerFor };
}

const credentials: FinancialMcpCredentialVerifier = {
  async verifyBearer(token) {
    if (token === "bad-audience") {
      return { principalId: "principal:buyer", runId: "revision-run", agentId: "agent-buyer", audience: "social", credentialVersion: 1, issuedAt: 1 };
    }
    const agentId = token.replace(/^bearer:/, "");
    if (!agentId || agentId === token) throw new Error("invalid test bearer");
    return {
      principalId: `principal:${agentId}`,
      runId: "revision-run",
      agentId,
      audience: "financial",
      credentialVersion: 1,
      issuedAt: 1,
    };
  },
};

function bearerFor(agentId: string): string {
  return `bearer:${agentId}`;
}

const fullMcpPermissions: FinancialMcpPermissions = {
  tools: ["financial.place_order", "financial.cancel_order"],
  resources: ["financial.market", "financial.account", "financial.orders"],
};

const brokerMcpPermissions: FinancialMcpPermissions = {
  tools: [
    "financial.get_quote", "financial.get_order_book", "financial.get_candles",
    "financial.list_market_trades", "financial.list_market_orders",
    "financial.get_account", "financial.list_orders", "financial.list_executions",
    "financial.get_command_status", "financial.preview_order",
    "financial.place_limit_order", "financial.place_market_order",
    "financial.replace_order", "financial.cancel_order",
  ],
  resources: ["financial.market", "financial.account", "financial.orders"],
};

test("broker MCP queries are pinned and broker writes preserve accepted-versus-filled semantics", async () => {
  const { revisions, read, bearerFor } = await fixture();
  await revisions.provisionMcpBindings({
    runId: "revision-run",
    roundId: 1,
    revision: read,
    agents: [{ agentId: "agent-buyer", principalId: "principal:agent-buyer", accountId: "buyer", permissions: brokerMcpPermissions }],
  });
  await revisions.openMcpScope({
    runId: "revision-run",
    roundId: 1,
    agentId: "agent-buyer",
    principalId: "principal:agent-buyer",
    readRevision: read,
    turnId: "turn-broker",
  });
  const bearerToken = bearerFor("agent-buyer");
  assert.ok((await revisions.listMcpTools(bearerToken)).includes("place_market_order"));
  const quote = await revisions.callMcpQuery({ bearerToken, name: "get_quote", arguments: {} }) as { revisionRef: string; roundId: number; lastPrice: number };
  assert.deepEqual(quote, { revisionRef: read.ref, roundId: 1, symbol: "LEEK", tickSize: 1, lastPrice: 100, bestBid: 0, bestAsk: 0, bidSize: 0, askSize: 0 });
  const preview = await revisions.callMcpQuery({
    bearerToken,
    name: "preview_order",
    arguments: { side: "buy", orderType: "limit", quantity: 2, limitPrice: 100 },
  }) as { preview: { nonBinding: boolean; estimatedFilledQuantity: number } };
  assert.equal(preview.preview.nonBinding, true);
  assert.equal(preview.preview.estimatedFilledQuantity, 0);

  const command = await revisions.enqueueMcpLimitOrder({
    bearerToken,
    invocationId: "broker-limit",
    side: "buy",
    fraction: 0.2,
    limitPrice: 100,
    rationale: "bounded entry",
  });
  assert.equal(command.status, "pending");
  assert.equal(command.rationale, "bounded entry");
  const retried = await revisions.enqueueMcpLimitOrder({
    bearerToken, invocationId: "broker-limit", side: "buy", fraction: 0.2, limitPrice: 100, rationale: "bounded entry",
  });
  assert.equal(retried.commandId, command.commandId);
  const repeatedOrder = await revisions.enqueueMcpLimitOrder({
    bearerToken, invocationId: "broker-limit-2", side: "buy", fraction: 0.2, limitPrice: 100, rationale: "bounded entry",
  });
  assert.notEqual(repeatedOrder.commandId, command.commandId);
  assert.equal((await revisions.listMcpTools(bearerToken)).includes("get_command_status"), false);
});

test("broker MCP exposes decimal prices while persisting fixed-point intents", async () => {
  const market = await FinancialMarketService.create();
  const checkpoint = await market.initialize("revision-run", {
    symbol: "LEEK", initialReferencePrice: 10_000, priceScale: 100, tickSizeUnits: 1,
    accounts: [{ accountId: "buyer", initialCash: 100_000, initialPosition: 0, maximumActionsPerRound: 3 }],
  }, mutation("initialize-decimal"));
  const revisions = await FinancialRevisionService.create({
    market, store: new InMemoryFinancialRevisionStore(), credentialVerifier: credentials,
    endpoint: "http://financial.test/internal/mcp", now: () => new Date("2026-07-19T00:00:00.000Z"),
  });
  const initial = await revisions.initializeRevision({ runId: "revision-run", checkpointRef: checkpoint.ref });
  const read = await revisions.freezeFullSnapshot({ runId: "revision-run", roundId: 1, baseline: initial });
  await revisions.openWorktree({ runId: "revision-run", roundId: 1, baseRevision: initial, readRevision: read });
  await revisions.provisionMcpBindings({
    runId: "revision-run", roundId: 1, revision: read,
    agents: [{ agentId: "agent-buyer", principalId: "principal:agent-buyer", accountId: "buyer", permissions: brokerMcpPermissions }],
  });
  await revisions.openMcpScope({
    runId: "revision-run", roundId: 1, agentId: "agent-buyer", principalId: "principal:agent-buyer",
    readRevision: read, turnId: "turn-decimal",
  });
  const bearerToken = bearerFor("agent-buyer");
  const quote = await revisions.callMcpQuery({ bearerToken, name: "get_quote", arguments: {} }) as { tickSize: number; lastPrice: number };
  assert.deepEqual({ tickSize: quote.tickSize, lastPrice: quote.lastPrice }, { tickSize: 0.01, lastPrice: 100 });
  const intent = await revisions.enqueueMcpLimitOrder({
    bearerToken, invocationId: "decimal-order", side: "buy", quantity: 2, limitPrice: 99.95,
  });
  assert.equal(intent.action.type === "submitOrder" ? intent.action.limitPrice : 0, 9_995);
  await assert.rejects(
    () => revisions.enqueueMcpLimitOrder({ bearerToken, invocationId: "off-tick", side: "buy", quantity: 1, limitPrice: 99.955 }),
    /more than 2 decimal places|tickSize/,
  );
});

test("one full pinned Financial revision backs market, account, and order MCP resources", async () => {
  const { revisions, read, bearerFor } = await fixture();
  const [binding] = await revisions.provisionMcpBindings({
    runId: "revision-run",
    roundId: 1,
    revision: read,
    agents: [{ agentId: "agent-buyer", principalId: "principal:agent-buyer", accountId: "buyer", permissions: fullMcpPermissions }],
  });
  assert.ok(binding);
  assert.equal("capabilityToken" in binding, false);
  const scope = await revisions.openMcpScope({
    runId: "revision-run",
    roundId: 1,
    agentId: "agent-buyer",
    principalId: "principal:agent-buyer",
    readRevision: read,
    turnId: "turn-1",
  });
  assert.ok(scope.scopeId);

  const bearer = bearerFor("agent-buyer");
  const resources = await revisions.listMcpResources(bearer);
  assert.equal(resources.length, 3);
  assert.ok(resources.every((resource) => resource.uri.includes(encodeURIComponent(read.ref))));
  const market = JSON.parse((await revisions.readMcpResource(bearer, resources[0]!.uri)).text) as { revision: { ref: string } };
  assert.equal(market.revision.ref, read.ref);
  const account = JSON.parse((await revisions.readMcpResource(bearer, resources[1]!.uri)).text) as { accountId: string; cash: number };
  assert.deepEqual(account, { accountId: "buyer", cash: 1_000, position: 0, maximumActionsPerRound: 3, reservedCash: 0, reservedPosition: 0 });
  await assert.rejects(() => revisions.listMcpResources("bad-audience"), /audience/i);

  await revisions.closeMcpScope({ runId: "revision-run", scopeId: scope.scopeId });
  await assert.rejects(() => revisions.listMcpResources(bearer), /inactive|unknown/i);
});

test("Financial executions and frozen Resources return bounded cursor pages", async () => {
  const { revisions, initial, read, bearerFor } = await fixture(60, 100);
  const commands = [];
  for (let index = 0; index < 26; index += 1) {
    commands.push(await revisions.enqueueIntent({
      runId: "revision-run",
      roundId: 1,
      agentId: "agent-seller",
      accountId: "seller",
      turnId: `turn-seller-${index}`,
      action: {
        type: "submitOrder",
        actionId: `seller-${index}`,
        accountId: "seller",
        side: "sell",
        quantity: 1,
        limitPrice: 10,
      },
    }));
    commands.push(await revisions.enqueueIntent({
      runId: "revision-run",
      roundId: 1,
      agentId: "agent-buyer",
      accountId: "buyer",
      turnId: `turn-buyer-${index}`,
      action: {
        type: "submitOrder",
        actionId: `buyer-${index}`,
        accountId: "buyer",
        side: "buy",
        quantity: 1,
        limitPrice: 10,
      },
    }));
  }
  for (const [index, command] of commands.entries()) {
    await revisions.recordOutboxPublished("revision-run", 1, command.commandId, `${index + 1}-0`);
  }
  await new FinancialMarketWorktreeWorker(revisions).drain({ runId: "revision-run", roundId: 1 });
  const candidate = await revisions.sealCandidateRevision({
    runId: "revision-run",
    roundId: 1,
    finalFailedTurnIds: [],
  });
  await revisions.commitRevision("revision-run", candidate.ref);
  const secondRead = await revisions.freezeFullSnapshot({
    runId: "revision-run",
    roundId: 2,
    baseline: candidate,
  });
  await revisions.openWorktree({
    runId: "revision-run",
    roundId: 2,
    baseRevision: candidate,
    readRevision: secondRead,
  });
  await revisions.provisionMcpBindings({
    runId: "revision-run",
    roundId: 2,
    revision: secondRead,
    agents: [{
      agentId: "agent-buyer",
      principalId: "principal:agent-buyer",
      accountId: "buyer",
      permissions: brokerMcpPermissions,
    }],
  });
  await revisions.openMcpScope({
    runId: "revision-run",
    roundId: 2,
    agentId: "agent-buyer",
    principalId: "principal:agent-buyer",
    readRevision: secondRead,
    turnId: "turn-pagination",
  });

  const bearer = bearerFor("agent-buyer");
  const firstExecutions = await revisions.callMcpQuery({
    bearerToken: bearer,
    name: "list_executions",
    arguments: {},
  }) as { executions: unknown[]; nextCursor?: string };
  assert.equal(firstExecutions.executions.length, 10);
  assert.equal(firstExecutions.nextCursor, "10");
  const secondExecutions = await revisions.callMcpQuery({
    bearerToken: bearer,
    name: "list_executions",
    arguments: { cursor: firstExecutions.nextCursor },
  }) as { executions: unknown[]; nextCursor?: string };
  assert.equal(secondExecutions.executions.length, 10);
  assert.equal(secondExecutions.nextCursor, "20");

  const resources = await revisions.listMcpResources(bearer);
  const marketUri = resources.find((resource) => resource.name === "Frozen market")!.uri;
  const ordersUri = resources.find((resource) => resource.name === "Frozen orders")!.uri;
  const firstMarket = JSON.parse((await revisions.readMcpResource(bearer, marketUri)).text) as {
    trades: unknown[];
    nextUri?: string;
  };
  assert.equal(firstMarket.trades.length, 25);
  assert.ok(firstMarket.nextUri);
  const secondMarket = JSON.parse((await revisions.readMcpResource(bearer, firstMarket.nextUri!)).text) as {
    trades: unknown[];
    nextUri?: string;
  };
  assert.equal(secondMarket.trades.length, 1);
  assert.equal(secondMarket.nextUri, undefined);

  const firstOrders = JSON.parse((await revisions.readMcpResource(bearer, ordersUri)).text) as {
    orders: unknown[];
    nextUri?: string;
  };
  assert.equal(firstOrders.orders.length, 25);
  assert.ok(firstOrders.nextUri);
  const secondOrders = JSON.parse((await revisions.readMcpResource(bearer, firstOrders.nextUri!)).text) as {
    orders: unknown[];
    nextUri?: string;
  };
  assert.equal(secondOrders.orders.length, 1);
  assert.equal(secondOrders.nextUri, undefined);

  await assert.rejects(
    () => revisions.readMcpResource(bearer, `${marketUri}?cursor=not-a-number`),
    /cursor/i,
  );
  assert.equal(revisions.getRevision(read.ref).snapshot.trades.length, 0);
  assert.equal(revisions.getRevision(initial.ref).snapshot.trades.length, 0);
});

test("Financial rotates one principal scope atomically and an old close cannot remove the new turn", async () => {
  const { revisions, read, bearerFor } = await fixture();
  await revisions.provisionMcpBindings({
    runId: "revision-run",
    roundId: 1,
    revision: read,
    agents: [{ agentId: "agent-buyer", principalId: "principal:agent-buyer", accountId: "buyer", permissions: fullMcpPermissions }],
  });
  const first = await revisions.openMcpScope({
    runId: "revision-run",
    roundId: 1,
    agentId: "agent-buyer",
    principalId: "principal:agent-buyer",
    readRevision: read,
    turnId: "turn-1",
    attemptId: "attempt-1",
  });
  const second = await revisions.openMcpScope({
    runId: "revision-run",
    roundId: 1,
    agentId: "agent-buyer",
    principalId: "principal:agent-buyer",
    readRevision: read,
    turnId: "turn-2",
    attemptId: "attempt-2",
  });
  assert.notEqual(second.scopeId, first.scopeId);
  assert.equal(second.attemptId, "attempt-2");

  await revisions.closeMcpScope({ runId: "revision-run", scopeId: first.scopeId });
  assert.equal((await revisions.listMcpResources(bearerFor("agent-buyer"))).length, 3);
  await revisions.closeMcpScope({ runId: "revision-run", scopeId: second.scopeId });
  await assert.rejects(() => revisions.listMcpResources(bearerFor("agent-buyer")), /inactive|expired/i);
});

test("Financial MCP policy filters discovery and rejects direct resource and tool access", async () => {
  const { revisions, read, bearerFor } = await fixture();
  await revisions.provisionMcpBindings({
    runId: "revision-run",
    roundId: 1,
    revision: read,
    agents: [{
      agentId: "agent-buyer",
      principalId: "principal:agent-buyer",
      accountId: "buyer",
      permissions: {
        tools: ["financial.cancel_order"],
        resources: ["financial.market"],
      },
    }],
  });
  await revisions.openMcpScope({
    runId: "revision-run",
    roundId: 1,
    agentId: "agent-buyer",
    principalId: "principal:agent-buyer",
    readRevision: read,
    turnId: "turn-policy",
  });

  const bearerToken = bearerFor("agent-buyer");
  const resources = await revisions.listMcpResources(bearerToken);
  assert.deepEqual(resources.map((resource) => resource.name), ["Frozen market"]);
  const accountUri = resources[0]!.uri.replace(/\/market$/, "/accounts/buyer");
  await assert.rejects(
    () => revisions.readMcpResource(bearerToken, accountUri),
    /financial\.account.*not allowed/i,
  );
  assert.deepEqual(await revisions.listMcpTools(bearerToken), ["cancel_order"]);
  await assert.rejects(
    () => revisions.enqueueMcpOrder({
      bearerToken,
      invocationId: "denied-order",
      side: "buy",
      quantity: 1,
      limitPrice: 100,
    }),
    /financial\.place_order.*not allowed/i,
  );
  const cancellation = await revisions.enqueueMcpCancellation({
    bearerToken,
    orderId: "missing-order",
    invocationId: "allowed-cancel",
  });
  assert.equal(cancellation.action.type, "cancelOrder");
});

test("an empty Financial MCP policy exposes and authorizes no capability", async () => {
  const { revisions, read, bearerFor } = await fixture();
  await revisions.provisionMcpBindings({
    runId: "revision-run",
    roundId: 1,
    revision: read,
    agents: [{
      agentId: "agent-buyer",
      principalId: "principal:agent-buyer",
      accountId: "buyer",
      permissions: { tools: [], resources: [] },
    }],
  });
  await revisions.openMcpScope({
    runId: "revision-run",
    roundId: 1,
    agentId: "agent-buyer",
    principalId: "principal:agent-buyer",
    readRevision: read,
    turnId: "turn-empty-policy",
  });

  const bearerToken = bearerFor("agent-buyer");
  assert.deepEqual(await revisions.listMcpResources(bearerToken), []);
  assert.deepEqual(await revisions.listMcpTools(bearerToken), []);
  await assert.rejects(
    () => revisions.enqueueMcpCancellation({ bearerToken, invocationId: "denied", orderId: "denied" }),
    /financial\.cancel_order.*not allowed/i,
  );
});

test("an accountless Financial observer can read only the pinned market after restart", async () => {
  const { market, revisionStore, revisions, read, bearerFor } = await fixture();
  await revisions.provisionMcpBindings({
    runId: "revision-run",
    roundId: 1,
    revision: read,
    agents: [{
      agentId: "agent-media",
      principalId: "principal:agent-media",
      permissions: {
        tools: ["financial.list_market_trades", "financial.list_market_orders"],
        resources: ["financial.market"],
      },
    }],
  });
  await revisions.openMcpScope({
    runId: "revision-run",
    roundId: 1,
    agentId: "agent-media",
    principalId: "principal:agent-media",
    readRevision: read,
    turnId: "turn-media-observer",
  });

  const restored = await FinancialRevisionService.create({
    market,
    store: revisionStore,
    credentialVerifier: credentials,
    endpoint: "http://financial.test/internal/mcp",
    now: () => new Date("2026-07-19T00:00:00.000Z"),
  });
  const bearerToken = bearerFor("agent-media");
  const resources = await restored.listMcpResources(bearerToken);
  assert.deepEqual(resources.map((resource) => resource.name), ["Frozen market"]);
  assert.equal(JSON.parse((await restored.readMcpResource(bearerToken, resources[0]!.uri)).text).revision.ref, read.ref);
  assert.deepEqual(await restored.listMcpTools(bearerToken), ["list_market_trades", "list_market_orders"]);
  assert.deepEqual(
    await restored.callMcpQuery({ bearerToken, name: "list_market_trades", arguments: {} }),
    { revisionRef: read.ref, roundId: 1, symbol: "LEEK", total: 0, offset: 0, trades: [] },
  );
  assert.deepEqual(
    await restored.callMcpQuery({ bearerToken, name: "list_market_orders", arguments: {} }),
    { revisionRef: read.ref, roundId: 1, symbol: "LEEK", total: 0, offset: 0, orders: [] },
  );
});

test("raw market tools return anonymous, ordered trades and active limit orders", async () => {
  const { revisions, initial, read, bearerFor } = await fixture();
  const commands = await Promise.all([
    revisions.enqueueIntent({
      runId: "revision-run",
      roundId: 1,
      agentId: "agent-seller",
      accountId: "seller",
      turnId: "turn-seller-cross",
      action: { type: "submitOrder", actionId: "seller-cross", accountId: "seller", side: "sell", quantity: 2, limitPrice: 90 },
    }),
    revisions.enqueueIntent({
      runId: "revision-run",
      roundId: 1,
      agentId: "agent-buyer",
      accountId: "buyer",
      turnId: "turn-buyer-cross",
      action: { type: "submitOrder", actionId: "buyer-cross", accountId: "buyer", side: "buy", quantity: 1, limitPrice: 100 },
    }),
    revisions.enqueueIntent({
      runId: "revision-run",
      roundId: 1,
      agentId: "agent-buyer",
      accountId: "buyer",
      turnId: "turn-buyer-resting",
      action: { type: "submitOrder", actionId: "buyer-resting", accountId: "buyer", side: "buy", quantity: 3, limitPrice: 80, expiresAtRound: 3 },
    }),
  ]);
  for (const [index, command] of commands.entries()) {
    await revisions.recordOutboxPublished("revision-run", 1, command.commandId, `${index + 1}-0`);
  }
  await new FinancialMarketWorktreeWorker(revisions).drain({ runId: "revision-run", roundId: 1 });
  const candidate = await revisions.sealCandidateRevision({ runId: "revision-run", roundId: 1, finalFailedTurnIds: [] });
  await assert.rejects(
    () => revisions.getObserverSnapshot("revision-run", candidate.ref),
    /committed/i,
  );
  await revisions.commitRevision("revision-run", candidate.ref);
  const observer = await revisions.getObserverSnapshot("revision-run", candidate.ref);
  assert.equal(observer.revision.ref, candidate.ref);
  assert.equal(observer.trades.length, 1);
  assert.equal(observer.orders.length, 2);
  assert.equal(observer.delta.newTradeCount, 1);
  const serializedObserver = JSON.stringify(observer);
  for (const forbidden of ["accountId", "orderId", "origin", "buyOrderId", "sellOrderId"]) {
    assert.doesNotMatch(serializedObserver, new RegExp(`"${forbidden}"`));
  }
  const secondRead = await revisions.freezeFullSnapshot({ runId: "revision-run", roundId: 2, baseline: candidate });
  await revisions.openWorktree({ runId: "revision-run", roundId: 2, baseRevision: candidate, readRevision: secondRead });
  await revisions.provisionMcpBindings({
    runId: "revision-run",
    roundId: 2,
    revision: secondRead,
    agents: [{
      agentId: "agent-media",
      principalId: "principal:agent-media",
      permissions: {
        tools: ["financial.list_market_trades", "financial.list_market_orders"],
        resources: [],
      },
    }],
  });
  await revisions.openMcpScope({
    runId: "revision-run",
    roundId: 2,
    agentId: "agent-media",
    principalId: "principal:agent-media",
    readRevision: secondRead,
    turnId: "turn-raw-market",
  });

  const bearerToken = bearerFor("agent-media");
  const trades = await revisions.callMcpQuery({
    bearerToken,
    name: "list_market_trades",
    arguments: { roundId: 1, limit: 1 },
  }) as { total: number; trades: Array<Record<string, unknown>> };
  assert.equal(trades.total, 1);
  assert.deepEqual(trades.trades, [{
    tradeSequence: 1,
    roundId: 1,
    price: 90,
    quantity: 1,
    buyOrderSequence: 2,
    sellOrderSequence: 1,
  }]);

  const orders = await revisions.callMcpQuery({
    bearerToken,
    name: "list_market_orders",
    arguments: { side: "buy" },
  }) as { total: number; orders: Array<Record<string, unknown>> };
  assert.equal(orders.total, 1);
  assert.deepEqual(orders.orders, [{
    orderSequence: 3,
    side: "buy",
    limitPrice: 80,
    quantity: 3,
    remainingQuantity: 3,
    timeInForce: "gtc",
    expiresAtRound: 3,
  }]);
  for (const value of [...trades.trades, ...orders.orders]) {
    for (const forbidden of ["accountId", "orderId", "origin", "buyOrderId", "sellOrderId"]) {
      assert.equal(forbidden in value, false);
    }
  }
  assert.equal(revisions.getRevision(read.ref).snapshot.orders.length, 0);
  assert.equal(revisions.getRevision(initial.ref).snapshot.orders.length, 0);
});

test("persisted pre-policy Financial principals are explicitly restored with legacy full access", async () => {
  const { market, revisionStore, revisions, read, bearerFor } = await fixture();
  await revisions.provisionMcpBindings({
    runId: "revision-run",
    roundId: 1,
    revision: read,
    agents: [{ agentId: "agent-buyer", principalId: "principal:agent-buyer", accountId: "buyer", permissions: fullMcpPermissions }],
  });
  await revisions.openMcpScope({
    runId: "revision-run",
    roundId: 1,
    agentId: "agent-buyer",
    principalId: "principal:agent-buyer",
    readRevision: read,
    turnId: "turn-legacy",
  });
  const legacyState = await revisionStore.load();
  assert.ok(legacyState);
  delete legacyState.runs["revision-run"]!.mcp.principals[0]!.permissions;
  await revisionStore.save(legacyState);

  const restored = await FinancialRevisionService.create({
    market,
    store: revisionStore,
    credentialVerifier: credentials,
    endpoint: "http://financial.test/internal/mcp",
    now: () => new Date("2026-07-19T00:00:00.000Z"),
  });
  const bearerToken = bearerFor("agent-buyer");
  assert.equal((await restored.listMcpResources(bearerToken)).length, 3);
  assert.deepEqual(await restored.listMcpTools(bearerToken), ["place_order", "cancel_order"]);
});

test("run access revocation invalidates every registered bearer and active scope", async () => {
  const { revisions, read, bearerFor } = await fixture();
  await revisions.provisionMcpBindings({
    runId: "revision-run",
    roundId: 1,
    revision: read,
    agents: [{ agentId: "agent-buyer", principalId: "principal:agent-buyer", accountId: "buyer", permissions: fullMcpPermissions }],
  });
  await revisions.openMcpScope({
    runId: "revision-run",
    roundId: 1,
    agentId: "agent-buyer",
    principalId: "principal:agent-buyer",
    readRevision: read,
    turnId: "turn-revoke",
  });
  await revisions.revokeMcpAccess("revision-run");
  await assert.rejects(() => revisions.listMcpResources(bearerFor("agent-buyer")), /revoked/i);
  await assert.rejects(
    () => revisions.openMcpScope({
      runId: "revision-run",
      roundId: 1,
      agentId: "agent-buyer",
      principalId: "principal:agent-buyer",
      readRevision: read,
      turnId: "turn-after-revoke",
    }),
    /revoked/i,
  );
});

test("worker applies durable arrivals in numeric Redis Stream order and seals a full candidate revision", async () => {
  const { revisions, initial, read } = await fixture();
  const seller = await revisions.enqueueIntent({
    runId: "revision-run",
    roundId: 1,
    agentId: "agent-seller",
    accountId: "seller",
    turnId: "turn-seller",
    action: { type: "submitOrder", actionId: "sell", accountId: "seller", side: "sell", quantity: 2, limitPrice: 90 },
  });
  const buyer = await revisions.enqueueIntent({
    runId: "revision-run",
    roundId: 1,
    agentId: "agent-buyer",
    accountId: "buyer",
    turnId: "turn-buyer",
    action: { type: "submitOrder", actionId: "buy", accountId: "buyer", side: "buy", quantity: 2, limitPrice: 100 },
  });
  // Deliberately publish 10 before 2: Stream IDs, not JS insertion/lexical
  // order, define the reproducible command sequence.
  await revisions.recordOutboxPublished("revision-run", 1, seller.commandId, "10-0");
  await revisions.recordOutboxPublished("revision-run", 1, buyer.commandId, "2-0");
  assert.deepEqual(await revisions.settlementStatus({ runId: "revision-run", roundId: 1, finalFailedTurnIds: [] }), {
    settled: false,
    pendingIntentCount: 2,
    pendingOutboxCount: 2,
  });
  const worker = new FinancialMarketWorktreeWorker(revisions);
  assert.equal(await worker.drain({ runId: "revision-run", roundId: 1 }), 2);
  assert.deepEqual(await revisions.settlementStatus({ runId: "revision-run", roundId: 1, finalFailedTurnIds: [] }), {
    settled: true,
    pendingIntentCount: 0,
    pendingOutboxCount: 0,
  });
  const provisional = revisions.getWorktree("revision-run", 1).provisionalSnapshot!;
  assert.deepEqual(provisional.orders.map((order) => [order.orderId, order.createdSequence]), [["buy", 1], ["sell", 2]]);
  const candidate = await revisions.sealCandidateRevision({ runId: "revision-run", roundId: 1, finalFailedTurnIds: [] });
  assert.equal(candidate.parentRevisionRef, initial.ref);
  const stored = revisions.getRevision(candidate.ref);
  assert.equal(stored.snapshot.publishedRound, 1);
  assert.deepEqual(stored.snapshot.trades.map((trade) => [trade.buyOrderId, trade.sellOrderId, trade.price]), [["buy", "sell", 100]]);
  // The read object remains a stable full round-entry snapshot.
  assert.equal(revisions.getRevision(read.ref).snapshot.orders.length, 0);
});

test("per-account round limits count unique intents after idempotency", async () => {
  const { revisions } = await fixture();
  const enqueue = (actionId: string, turnId = `turn-${actionId}`) => revisions.enqueueIntent({
    runId: "revision-run",
    roundId: 1,
    agentId: "agent-buyer",
    accountId: "buyer",
    turnId,
    action: { type: "submitOrder" as const, actionId, accountId: "buyer", side: "buy" as const, quantity: 1, limitPrice: 100 },
  });
  const first = await enqueue("limit-1");
  assert.equal((await enqueue("limit-1", "retry-from-another-turn")).commandId, first.commandId);
  await enqueue("limit-2");
  await enqueue("limit-3");
  await assert.rejects(() => enqueue("limit-4"), /action limit reached/i);
});

test("fractional algorithm config does not weaken integer order admission", async () => {
  const { revisions } = await fixture();
  const enqueue = (quantity: number, limitPrice: number) => revisions.enqueueIntent({
    runId: "revision-run",
    roundId: 1,
    agentId: "agent-buyer",
    accountId: "buyer",
    turnId: `turn-${quantity}-${limitPrice}`,
    action: { type: "submitOrder", actionId: `order-${quantity}-${limitPrice}`, accountId: "buyer", side: "buy", quantity, limitPrice },
  });
  await assert.rejects(() => enqueue(0.5, 100), /quantity must be a positive safe integer/);
  await assert.rejects(() => enqueue(1, 100.5), /limitPrice must be a positive safe integer/);
});

test("final failed turns rebuild a candidate from its base revision without compensation", async () => {
  const { revisions } = await fixture();
  const surviving = await revisions.enqueueIntent({
    runId: "revision-run",
    roundId: 1,
    agentId: "agent-seller",
    accountId: "seller",
    turnId: "turn-ok",
    action: { type: "submitOrder", actionId: "keep", accountId: "seller", side: "sell", quantity: 1, limitPrice: 110 },
  });
  const failed = await revisions.enqueueIntent({
    runId: "revision-run",
    roundId: 1,
    agentId: "agent-buyer",
    accountId: "buyer",
    turnId: "turn-failed",
    action: { type: "submitOrder", actionId: "drop", accountId: "buyer", side: "buy", quantity: 1, limitPrice: 100 },
  });
  await revisions.recordOutboxPublished("revision-run", 1, surviving.commandId, "1-0");
  await revisions.recordOutboxPublished("revision-run", 1, failed.commandId, "2-0");
  assert.deepEqual(await revisions.settlementStatus({ runId: "revision-run", roundId: 1, finalFailedTurnIds: ["turn-failed"] }), {
    settled: false,
    pendingIntentCount: 1,
    pendingOutboxCount: 1,
  });
  await new FinancialMarketWorktreeWorker(revisions).drain({ runId: "revision-run", roundId: 1 });
  const candidate = await revisions.sealCandidateRevision({
    runId: "revision-run",
    roundId: 1,
    finalFailedTurnIds: ["turn-failed"],
  });
  const stored = revisions.getRevision(candidate.ref);
  assert.deepEqual(stored.snapshot.orders.map((order) => order.orderId), ["keep"]);
  assert.equal(stored.snapshot.orders[0]!.status, "open");
});

test("revision state restarts with immutable objects, worktrees and outbox records", async () => {
  const { marketStore, revisionStore, revisions, read } = await fixture();
  const intent = await revisions.enqueueIntent({
    runId: "revision-run",
    roundId: 1,
    agentId: "agent-buyer",
    accountId: "buyer",
    turnId: "turn-restart",
    action: { type: "submitOrder", actionId: "restart-buy", accountId: "buyer", side: "buy", quantity: 1, limitPrice: 100 },
  });
  await revisions.recordOutboxPublished("revision-run", 1, intent.commandId, "7-0");
  const restartedMarket = await FinancialMarketService.create({ stateStore: marketStore });
  const restarted = await FinancialRevisionService.create({ market: restartedMarket, store: revisionStore });
  assert.equal(restarted.getRevision(read.ref).digest, read.digest);
  assert.equal(restarted.getWorktree("revision-run", 1).intents[intent.commandId]!.streamId, "7-0");
});

test("opening Market Maker keeps a stable three-round replacement budget and leaves agent orders alone", async () => {
  const marketStore = new InMemoryFinancialMarketStateStore();
  const revisionStore = new InMemoryFinancialRevisionStore();
  let revisions: FinancialRevisionService;
  let executions = 0;
  const executor: MarketMakerExecutor = {
    async validate() { return { valid: true, errors: [] }; },
    async execute(input) {
      executions += 1;
      const all = await revisions.readMarketMakerHistory({ capability: input.financialHistory.capability, operation: "all" }) as {
        records: Array<{ roundId: number; openingReferencePrice: number }>;
      };
      const account = await revisions.readMarketMakerHistory({ capability: input.financialHistory.capability, operation: "makerAccount" }) as { accountId: string };
      const baseline = await revisions.readMarketMakerHistory({
        capability: input.financialHistory.capability,
        operation: "participantBaseline",
      });
      assert.deepEqual(all.records.map((record) => record.roundId), Array.from({ length: executions }, (_, index) => index));
      assert.equal(all.records[0]!.openingReferencePrice, 100);
      assert.deepEqual(account, executions === 1
        ? {
            accountId: "maker",
            cash: 1_000,
            position: 5,
            reservedCash: 0,
            reservedPosition: 0,
            replacementAvailableCash: 1_000,
            replacementAvailablePosition: 5,
            tickSize: 1,
          }
        : {
            accountId: "maker",
            cash: 1_000,
            position: 5,
            reservedCash: 189,
            reservedPosition: 1,
            replacementAvailableCash: 910,
            replacementAvailablePosition: 5,
            tickSize: 1,
          });
      assert.deepEqual(baseline, { accountCount: 1, totalCash: 1_000, totalPosition: 0, tickSize: 1 });
      return { orders: [
        { side: "buy", limitPrice: 99, quantity: 1 },
        { side: "sell", limitPrice: 101, quantity: 1 },
      ] };
    },
  };
  const market = await FinancialMarketService.create({ stateStore: marketStore, marketMakerExecutor: executor });
  const builtin = await publishMaker(market, "opening-test-maker");
  const checkpoint = await market.initialize("maker-run", {
    symbol: "LEEK",
    initialReferencePrice: 100,
    accounts: [
      { accountId: "maker", initialCash: 1_000, initialPosition: 5 , maximumActionsPerRound: 3},
      { accountId: "agent", initialCash: 1_000, initialPosition: 0 , maximumActionsPerRound: 3},
    ],
    marketMaker: {
      versionRef: builtin.versionRef,
      accountId: "maker",
      timing: "opening",
      config: { spreadTicks: 2, quoteQuantity: 1 },
    },
  }, mutation("maker-initialize"));
  revisions = await FinancialRevisionService.create({
    market,
    store: revisionStore,
    marketMakerHistoryEndpoint: "http://financial.test/internal/market-maker/history",
  });
  const initial = await revisions.initializeRevision({ runId: "maker-run", checkpointRef: checkpoint.ref });
  const read = await revisions.freezeFullSnapshot({ runId: "maker-run", roundId: 1, baseline: initial });
  assert.equal(executions, 1);
  assert.deepEqual(revisions.getRevision(read.ref).snapshot.orders.map((order) => [order.orderId, order.origin]), [
    ["market-maker:1:opening:0", "market_maker"],
    ["market-maker:1:opening:1", "market_maker"],
  ]);
  const agent = await revisions.enqueueIntent({
    runId: "maker-run",
    roundId: 1,
    agentId: "agent-1",
    accountId: "agent",
    turnId: "turn-agent",
    action: { type: "submitOrder", actionId: "agent-order", accountId: "agent", side: "buy", quantity: 1, limitPrice: 90 },
  });
  const makerOwnedAgentOrder = await revisions.enqueueIntent({
    runId: "maker-run",
    roundId: 1,
    agentId: "agent-operating-maker-account",
    accountId: "maker",
    turnId: "turn-maker-owned-agent-order",
    action: { type: "submitOrder", actionId: "maker-owned-agent-order", accountId: "maker", side: "buy", quantity: 1, limitPrice: 90 },
  });
  await revisions.recordOutboxPublished("maker-run", 1, agent.commandId, "1-0");
  await revisions.recordOutboxPublished("maker-run", 1, makerOwnedAgentOrder.commandId, "2-0");
  await new FinancialMarketWorktreeWorker(revisions).drain({ runId: "maker-run", roundId: 1 });
  let candidate = await revisions.sealCandidateRevision({ runId: "maker-run", roundId: 1, finalFailedTurnIds: [] });
  assert.equal(executions, 1);
  let orders = revisions.getRevision(candidate.ref).snapshot.orders;
  assert.equal(orders.find((order) => order.orderId === "agent-order")?.origin, "agent");
  assert.equal(orders.find((order) => order.orderId === "maker-owned-agent-order")?.origin, "agent");
  assert.equal(revisions.getWorktree("maker-run", 1).marketMakerExecutions?.opening?.orders.length, 2);
  await revisions.commitRevision("maker-run", candidate.ref);

  for (const roundId of [2, 3]) {
    const nextRead = await revisions.freezeFullSnapshot({ runId: "maker-run", roundId, baseline: candidate });
    const openOrders = revisions.getRevision(nextRead.ref).snapshot.orders.filter((order) => order.status === "open");
    assert.equal(openOrders.filter((order) => order.origin === "market_maker").length, 2);
    assert.equal(openOrders.find((order) => order.orderId === "maker-owned-agent-order")?.origin, "agent");
    candidate = await revisions.sealCandidateRevision({ runId: "maker-run", roundId, finalFailedTurnIds: [] });
    orders = revisions.getRevision(candidate.ref).snapshot.orders;
    assert.equal(orders.filter((order) => order.status === "open" && order.origin === "market_maker").length, 2);
    assert.equal(revisions.getWorktree("maker-run", roundId).marketMakerExecutions?.opening?.orders.length, 2);
    await revisions.commitRevision("maker-run", candidate.ref);
  }
  assert.equal(executions, 3);
});

test("after-trade Market Maker history exposes signed maker flow with a stable round-open reference", async () => {
  const marketStore = new InMemoryFinancialMarketStateStore();
  const revisionStore = new InMemoryFinancialRevisionStore();
  let revisions: FinancialRevisionService;
  const observations: Array<{
    openingReferencePrice: number;
    makerSide: "buy" | "sell" | null;
    makerPosition: number;
    replacementAvailablePosition: number;
  }> = [];
  let executions = 0;
  const executor: MarketMakerExecutor = {
    async validate() { return { valid: true, errors: [] }; },
    async execute(input) {
      executions += 1;
      if (executions === 1) return { orders: [{ side: "sell", limitPrice: 100, quantity: 1 }] };
      const all = await revisions.readMarketMakerHistory({
        capability: input.financialHistory.capability,
        operation: "all",
      }) as {
        records: Array<{
          roundId: number;
          openingReferencePrice: number;
          trades: Array<{ makerSide: "buy" | "sell" | null }>;
        }>;
      };
      const account = await revisions.readMarketMakerHistory({
        capability: input.financialHistory.capability,
        operation: "makerAccount",
      }) as { position: number; replacementAvailablePosition: number };
      const current = all.records.find((record) => record.roundId === 1)!;
      observations.push({
        openingReferencePrice: current.openingReferencePrice,
        makerSide: current.trades.at(-1)!.makerSide,
        makerPosition: account.position,
        replacementAvailablePosition: account.replacementAvailablePosition,
      });
      return { orders: [] };
    },
  };
  const market = await FinancialMarketService.create({ stateStore: marketStore, marketMakerExecutor: executor });
  const builtin = await publishMaker(market, "signed-flow-test-maker");
  const checkpoint = await market.initialize("signed-flow-run", {
    initialReferencePrice: 100,
    accounts: [
      { accountId: "buyer", initialCash: 1_000, initialPosition: 0, maximumActionsPerRound: 3 },
      { accountId: "maker", initialCash: 0, initialPosition: 1, maximumActionsPerRound: 0 },
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
  }, mutation("signed-flow-initialize"));
  revisions = await FinancialRevisionService.create({
    market,
    store: revisionStore,
    marketMakerHistoryEndpoint: "http://financial.test/internal/market-maker/history",
  });
  const initial = await revisions.initializeRevision({ runId: "signed-flow-run", checkpointRef: checkpoint.ref });
  await revisions.freezeFullSnapshot({ runId: "signed-flow-run", roundId: 1, baseline: initial });
  const intent = await revisions.enqueueIntent({
    runId: "signed-flow-run",
    roundId: 1,
    agentId: "agent-buyer",
    accountId: "buyer",
    turnId: "turn-buy",
    action: {
      type: "submitOrder",
      actionId: "buy-maker-quote",
      accountId: "buyer",
      side: "buy",
      quantity: 1,
      limitPrice: 100,
    },
  });
  await revisions.recordOutboxPublished("signed-flow-run", 1, intent.commandId, "1-0");
  await new FinancialMarketWorktreeWorker(revisions).drain({ runId: "signed-flow-run", roundId: 1 });

  assert.deepEqual(observations, [{
    openingReferencePrice: 100,
    makerSide: "sell",
    makerPosition: 0,
    replacementAvailablePosition: 0,
  }]);
});

test("settlement Market Maker waits for candidate sealing and cannot read round worktree state", async () => {
  const marketStore = new InMemoryFinancialMarketStateStore();
  const revisionStore = new InMemoryFinancialRevisionStore();
  let revisions: FinancialRevisionService;
  let executions = 0;
  const executor: MarketMakerExecutor = {
    async validate() { return { valid: true, errors: [] }; },
    async execute(input) {
      executions += 1;
      const history = await revisions.readMarketMakerHistory({ capability: input.financialHistory.capability, operation: "all" }) as { records: Array<{ roundId: number }> };
      assert.deepEqual(history.records.map((record) => record.roundId), [0]);
      return { orders: [{ side: "buy", limitPrice: 99, quantity: 1 }] };
    },
  };
  const market = await FinancialMarketService.create({ stateStore: marketStore, marketMakerExecutor: executor });
  const builtin = await publishMaker(market, "settlement-test-maker");
  const checkpoint = await market.initialize("settlement-maker-run", {
    initialReferencePrice: 100,
    accounts: [
      { accountId: "maker", initialCash: 1_000, initialPosition: 0 , maximumActionsPerRound: 3},
      { accountId: "agent", initialCash: 1_000, initialPosition: 0 , maximumActionsPerRound: 3},
    ],
    marketMaker: { versionRef: builtin.versionRef, accountId: "maker", timing: "settlement", config: { spreadTicks: 2, quoteQuantity: 1 } },
  }, mutation("settlement-maker-initialize"));
  revisions = await FinancialRevisionService.create({ market, store: revisionStore });
  const initial = await revisions.initializeRevision({ runId: "settlement-maker-run", checkpointRef: checkpoint.ref });
  const read = await revisions.freezeFullSnapshot({ runId: "settlement-maker-run", roundId: 1, baseline: initial });
  assert.equal(executions, 0);
  assert.equal(revisions.getRevision(read.ref).snapshot.orders.length, 0);
  const candidate = await revisions.sealCandidateRevision({ runId: "settlement-maker-run", roundId: 1, finalFailedTurnIds: [] });
  assert.equal(executions, 1);
  assert.deepEqual(revisions.getRevision(candidate.ref).snapshot.orders.map((order) => [order.orderId, order.origin]), [
    ["market-maker:1:settlement:0", "market_maker"],
  ]);
});
