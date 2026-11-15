import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cashToUnits, decimalDelta, priceToUnits, priceUnitsFromTickSize, unitsToDecimal } from "../src/domain/price-units";

describe("Financial decimal price units", () => {
  it("converts 0.01 prices and cash without floating-point matching", () => {
    const units = priceUnitsFromTickSize(0.01);
    assert.deepEqual(units, { priceScale: 100, tickSizeUnits: 1 });
    assert.equal(priceToUnits(100.01, units, "limitPrice"), 10_001);
    assert.equal(cashToUnits(25_000.25, units, "cash"), 2_500_025);
    assert.equal(unitsToDecimal(10_001, units.priceScale), 100.01);
  });

  it("supports non-unit ticks and rejects off-tick prices", () => {
    const units = priceUnitsFromTickSize(0.05);
    assert.deepEqual(units, { priceScale: 100, tickSizeUnits: 5 });
    assert.equal(priceToUnits(99.95, units, "limitPrice"), 9_995);
    assert.throws(() => priceToUnits(99.96, units, "limitPrice"), /tickSize 0.05/);
  });

  it("limits precision to eight decimals and checks safe range", () => {
    assert.deepEqual(priceUnitsFromTickSize(0.00000001), { priceScale: 100_000_000, tickSizeUnits: 1 });
    assert.throws(() => priceUnitsFromTickSize(0.000000001), /at most 8/);
    assert.throws(() => cashToUnits(Number.MAX_SAFE_INTEGER, { priceScale: 100, tickSizeUnits: 1 }, "cash"), /safe Financial range/);
  });

  it("normalizes deltas to the configured price precision", () => {
    assert.equal(decimalDelta(99.74, 98.59, 100), 1.15);
    assert.equal(decimalDelta(99.86, 99.8, 100), 0.06);
  });
});
