import assert from "node:assert/strict";
import test from "node:test";
import { hasObserverAccess, observerHeader } from "../src/server/observer-access.js";

test("Financial observer access requires the exact internal proxy token", () => {
  const previous = process.env.OPENLEEK_CONTEXT_OBSERVER_PROXY_TOKEN;
  process.env.OPENLEEK_CONTEXT_OBSERVER_PROXY_TOKEN = "financial-observer-secret";
  try {
    assert.equal(hasObserverAccess(new Request("http://financial.test/observer-api")), false);
    assert.equal(hasObserverAccess(new Request("http://financial.test/observer-api", {
      headers: { [observerHeader]: "wrong-secret" },
    })), false);
    assert.equal(hasObserverAccess(new Request("http://financial.test/observer-api", {
      headers: { [observerHeader]: "financial-observer-secret" },
    })), true);
  } finally {
    if (previous === undefined) delete process.env.OPENLEEK_CONTEXT_OBSERVER_PROXY_TOKEN;
    else process.env.OPENLEEK_CONTEXT_OBSERVER_PROXY_TOKEN = previous;
  }
});
