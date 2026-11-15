import assert from "node:assert/strict";
import test from "node:test";
import { NapiFinancialMarketMatcher, type MatchingEngineNapiBinding } from "../src/infrastructure/napi-matcher.js";

test("N-API adapter supplies sequence-sorted durable orders and validates native output", () => {
  const received: unknown[] = [];
  const binding: MatchingEngineNapiBinding = {
    matchOpenOrders(orders) {
      received.push(orders);
      return [{ buyOrderId: "buy", sellOrderId: "sell", quantity: 1, price: 100 }];
    },
  };
  const matcher = new NapiFinancialMarketMatcher(binding);
  const trades = matcher.match([
    { orderId: "buy", accountId: "buyer", side: "buy", quantity: 1, remaining: 1, limitPrice: 100, createdSequence: 2, timeInForce: "gtc", status: "open", origin: "agent" },
    { orderId: "sell", accountId: "seller", side: "sell", quantity: 1, remaining: 1, limitPrice: 90, createdSequence: 1, timeInForce: "gtc", status: "open", origin: "agent" },
  ]);
  assert.deepEqual((received[0] as Array<{ orderId: string }>).map((order) => order.orderId), ["sell", "buy"]);
  assert.deepEqual(trades, [{ buyOrderId: "buy", sellOrderId: "sell", quantity: 1, price: 100 }]);
});
