import assert from "node:assert/strict";
import test from "node:test";
import { ByteLru } from "../src/index";

test("evicts least-recently-used entries by byte size", () => {
  const cache = new ByteLru<string>({ maxBytes: 5, sizeOf: (value) => value.length });
  cache.set("a", "aa");
  cache.set("b", "bb");
  assert.equal(cache.get("a"), "aa");
  cache.set("c", "cc");
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), "aa");
  assert.equal(cache.get("c"), "cc");
});

test("coalesces concurrent loads for the same key", async () => {
  const cache = new ByteLru<string>({ maxBytes: 100, sizeOf: (value) => value.length });
  let loads = 0;
  const load = async () => {
    loads += 1;
    await Promise.resolve();
    return "value";
  };
  assert.deepEqual(await Promise.all([cache.getOrLoad("key", load), cache.getOrLoad("key", load)]), ["value", "value"]);
  assert.equal(loads, 1);
});
