import assert from "node:assert/strict";
import test from "node:test";
import { createActor } from "xstate";
import { assetEditorMachine } from "../src/components/assets/asset-editor-machine";

test("asset editor makes loading, dirty, validation, and publish confirmation explicit", () => {
  const actor = createActor(assetEditorMachine).start();
  assert.equal(actor.getSnapshot().matches("loading"), true);

  actor.send({ type: "LOADED" });
  actor.send({ type: "EDIT" });
  assert.equal(actor.getSnapshot().matches("dirty"), true);

  actor.send({ type: "VALIDATE" });
  assert.equal(actor.getSnapshot().matches("validating"), true);
  actor.send({ type: "SUCCESS" });
  assert.equal(actor.getSnapshot().matches("ready"), true);

  actor.send({ type: "REQUEST_PUBLISH" });
  assert.equal(actor.getSnapshot().matches("confirmingPublish"), true);
  actor.send({ type: "PUBLISH" });
  assert.equal(actor.getSnapshot().matches("publishing"), true);
  actor.send({ type: "SUCCESS" });
  assert.equal(actor.getSnapshot().matches("ready"), true);
});

test("asset editor exposes failures and lets editing recover", () => {
  const actor = createActor(assetEditorMachine).start();
  actor.send({ type: "FAIL", error: "offline" });
  assert.equal(actor.getSnapshot().matches("failure"), true);
  assert.equal(actor.getSnapshot().context.error, "offline");
  actor.send({ type: "EDIT" });
  assert.equal(actor.getSnapshot().matches("dirty"), true);
});
