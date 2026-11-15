import assert from "node:assert/strict";
import test from "node:test";
import { financialDataDictionary } from "../src/domain/data-dictionary.js";

test("Financial publishes asset and committed-fact contracts", () => {
  assert.equal(financialDataDictionary.revision, "financial-domain:2026-08-06-market-maker-replacement-budget");
  assert.deepEqual(financialDataDictionary.entries.map(({ id }) => id), [
    "financial-preset", "market-maker", "financial-committed-facts", "financial-observer-market",
  ]);
  const marketMaker = financialDataDictionary.entries.find(({ id }) => id === "market-maker");
  assert.ok(marketMaker?.management.capabilities.includes("delete-version"));
  const context = marketMaker?.programming?.contextSchema as {
    properties?: {
      financialHistory?: {
        properties?: Record<string, unknown>;
      };
    };
  };
  assert.ok(context.properties?.financialHistory?.properties?.participantBaseline);
  const makerAccount = context.properties?.financialHistory?.properties?.makerAccount as {
    required?: string[];
    properties?: Record<string, unknown>;
  };
  assert.ok(makerAccount.required?.includes("replacementAvailableCash"));
  assert.ok(makerAccount.required?.includes("replacementAvailablePosition"));
  assert.ok(makerAccount.properties?.replacementAvailableCash);
  assert.ok(makerAccount.properties?.replacementAvailablePosition);
  const record = context.properties?.financialHistory?.properties?.record as {
    properties?: Record<string, unknown>;
  };
  assert.ok(record.properties?.openingReferencePrice);
  const observer = financialDataDictionary.entries.find(({ id }) => id === "financial-observer-market");
  assert.equal(observer?.entryKind, "projection");
  assert.deepEqual(observer?.management.capabilities, ["read"]);
  assert.equal(financialDataDictionary.entries.find(({ id }) => id === "financial-committed-facts")?.entryKind, "evidence");
});
