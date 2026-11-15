import assert from "node:assert/strict";
import test from "node:test";
import { socialDataDictionary } from "../src/domain/data-dictionary.js";

test("Social publishes asset and committed-fact contracts", () => {
  assert.equal(socialDataDictionary.revision, "social-domain:2026-07-31");
  assert.deepEqual(socialDataDictionary.entries.map(({ id }) => id), [
    "social-network", "feed-algorithm", "social-committed-facts", "social-observer-public",
  ]);
  assert.ok(socialDataDictionary.entries.find(({ id }) => id === "feed-algorithm")?.management.capabilities.includes("preview"));
  const observer = socialDataDictionary.entries.find(({ id }) => id === "social-observer-public");
  assert.equal(observer?.entryKind, "projection");
  assert.deepEqual(observer?.management.capabilities, ["read"]);
  assert.equal(socialDataDictionary.entries.find(({ id }) => id === "social-committed-facts")?.management.idField, "revisionRef");
});
