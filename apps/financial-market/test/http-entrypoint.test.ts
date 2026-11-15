import assert from "node:assert/strict";
import test from "node:test";
import { GET as health } from "../src/app/health/route.js";

test("health remains process-local when the dedicated worker flag is enabled", async () => {
  const previous = process.env.OPENLEEK_FINANCIAL_MARKET_WORKER;
  process.env.OPENLEEK_FINANCIAL_MARKET_WORKER = "true";
  try {
    const response = health();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok", service: "financial-market" });
    assert.equal((globalThis as { __openleekFinancialMarketWorker?: unknown }).__openleekFinancialMarketWorker, undefined);
  } finally {
    if (previous === undefined) delete process.env.OPENLEEK_FINANCIAL_MARKET_WORKER;
    else process.env.OPENLEEK_FINANCIAL_MARKET_WORKER = previous;
  }
});
