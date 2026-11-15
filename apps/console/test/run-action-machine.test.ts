import assert from "node:assert/strict";
import test from "node:test";
import { createActor } from "xstate";
import { runActionMachine } from "../src/components/run-action-machine.js";

test("run action machine requires confirmation before submitting", () => {
  const actor = createActor(runActionMachine).start();
  assert.equal(actor.getSnapshot().value, "idle");
  actor.send({ type: "REQUEST", action: "cancel" });
  assert.equal(actor.getSnapshot().value, "confirming");
  assert.equal(actor.getSnapshot().context.action, "cancel");
  actor.send({ type: "CONFIRM" });
  assert.equal(actor.getSnapshot().value, "submitting");
});

test("run action machine exposes success and failure before dismissal", () => {
  const actor = createActor(runActionMachine).start();
  actor.send({ type: "REQUEST", action: "fork" });
  actor.send({ type: "CONFIRM" });
  actor.send({ type: "SUCCEED", result: "Fork created: run:2" });
  assert.equal(actor.getSnapshot().value, "succeeded");
  assert.equal(actor.getSnapshot().context.result, "Fork created: run:2");
  actor.send({ type: "DISMISS" });
  assert.equal(actor.getSnapshot().value, "idle");
  assert.equal(actor.getSnapshot().context.action, undefined);

  actor.send({ type: "REQUEST", action: "retry" });
  actor.send({ type: "CONFIRM" });
  actor.send({ type: "FAIL", error: "retry is unavailable" });
  assert.equal(actor.getSnapshot().value, "failed");
  assert.equal(actor.getSnapshot().context.error, "retry is unavailable");
});
