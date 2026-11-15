import assert from "node:assert/strict";
import test from "node:test";
import { observerPollIntervalMs, observerRunIdFromRoute } from "../src/app/observer-poll.js";

test("Financial observer polls the committed Run HEAD every ten seconds", () => {
  assert.equal(observerPollIntervalMs, 10_000);
  assert.equal(observerRunIdFromRoute("run%3Aobserver"), "run:observer");
});
