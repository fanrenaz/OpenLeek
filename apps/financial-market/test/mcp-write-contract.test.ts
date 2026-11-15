import assert from "node:assert/strict";
import test from "node:test";
import { FinancialMarketError } from "../src/domain/errors";
import {
  financialAcknowledgement,
  financialRequestIdentity,
  publicFinancialMcpError,
} from "../src/application/mcp-write-presentation";

test("Financial write presentation returns natural acknowledgements without identifiers", () => {
  assert.equal(financialAcknowledgement("place_order"), "Order submitted successfully.");
  assert.equal(financialAcknowledgement("place_market_order"), "Order submitted successfully.");
  assert.equal(financialAcknowledgement("replace_order"), "Order replacement submitted successfully.");
  assert.equal(financialAcknowledgement("cancel_order"), "Order cancellation submitted successfully.");
  assert.equal(financialRequestIdentity("request-7"), "string:request-7");
  assert.throws(() => financialRequestIdentity(undefined), /transport identity/);
});

test("Financial write presentation redacts owner and queue metadata", () => {
  assert.equal(
    publicFinancialMcpError("place_order", new FinancialMarketError("INTERNAL", "worktree command secret-id failed")),
    "Order action could not be submitted.",
  );
  assert.equal(
    publicFinancialMcpError("cancel_order", new FinancialMarketError("NOT_FOUND", "unknown order secret-id")),
    "The requested order is unavailable.",
  );
});
