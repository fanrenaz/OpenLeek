import assert from "node:assert/strict";
import test from "node:test";
import { createActor } from "xstate";
import { defaultRunForm, formFromAdvancedJson, generatorSchemaFields, toSpecification, updateGeneratorSelection } from "../src/components/run-form-model.js";
import { parseRunCreationDraft, runCreationMachine, serializeRunCreationDraft } from "../src/components/run-creation-machine.js";

test("generator schema exposes primitive fields and preserves complex JSON fallbacks", () => {
  assert.deepEqual(generatorSchemaFields({ type: "object", required: ["count"], properties: {
    count: { type: "integer", title: "Population count" }, enabled: { type: "boolean" }, relationships: { type: "array" }, opaque: {},
  } }), [
    { name: "count", title: "Population count", type: "integer", required: true },
    { name: "enabled", title: "enabled", type: "boolean", required: false },
    { name: "relationships", title: "relationships", type: "array", required: false },
    { name: "opaque", title: "opaque", type: "unknown", required: false },
  ]);
});

test("published Population selection stores only its immutable version reference", () => {
  const selected = updateGeneratorSelection({ ...defaultRunForm(), population: { versionRef: "old" } }, "population", {
    versionRef: "population:new", name: "New", kind: "population", defaultConfig: { count: 10 }, configSchema: {},
  });
  assert.deepEqual(selected.population, { versionRef: "population:new" });
});

test("new Run forms default to one UTC day per round without overriding restored specifications", () => {
  assert.equal(defaultRunForm().stepSeconds, 86_400);
  assert.equal(defaultRunForm().maxCallsPerToolPerTurn, 6);
  const restored = formFromAdvancedJson(JSON.stringify({
    ...toSpecification(defaultRunForm(), { model: "model", revision: "revision:1" }),
    clock: { startUnixSeconds: 0, stepSeconds: 60 },
  }));
  assert.equal(restored.stepSeconds, 60);
  assert.equal(restored.maxCallsPerToolPerTurn, 6);
});

test("feed mode removes ranking and market maker selects an initial-state preset", () => {
  const state = defaultRunForm();
  state.socialMode = "feedAlgorithm";
  state.feedAlgorithm = { versionRef: "feed:v1", config: { limit: 10 } };
  state.roundAdvancement = "automatic";
  state.marketMakerEnabled = true;
  state.marketMaker = { versionRef: "maker:v1", initialStatePresetVersionRef: "financial-preset:maker:v1", timing: "settlement", matchingPolicy: "incremental", requotePolicy: "after_each_trade", maxRequotesPerIntent: 20, config: {} };
  const specification = toSpecification(state, { model: "model", revision: "revision:1" });
  assert.equal(specification.executionPolicy.roundAdvancement, "automatic");
  assert.equal(specification.agentExecution.toolCallBudget.maxCallsPerToolPerTurn, 6);
  assert.equal("ranking" in specification.contexts.social!.configuration, false);
  assert.deepEqual(specification.contexts.social!.configuration.feedAlgorithm, { versionRef: "feed:v1", config: { limit: 10 } });
  const marketMaker = specification.contexts.financial!.configuration.marketMaker as Record<string, unknown>;
  assert.equal(marketMaker.initialStatePresetVersionRef, "financial-preset:maker:v1");
  assert.equal("accountId" in marketMaker, false);
});

test("invalid advanced JSON leaves the caller's form state available to preserve", () => {
  assert.throws(() => formFromAdvancedJson("{not json"));
  assert.throws(() => formFromAdvancedJson(JSON.stringify({ schemaVersion: "4" })), /v3/);
});

test("run creation state invalidates a successful preflight on any editable form change", () => {
  const actor = createActor(runCreationMachine).start();
  actor.send({ type: "PREFLIGHT_REQUESTED" });
  actor.send({ type: "PREFLIGHT_SUCCEEDED", result: { conditionDigest: "digest" } });
  assert.equal(actor.getSnapshot().value, "preflighted");
  actor.send({ type: "FORM_CHANGED", form: { ...actor.getSnapshot().context.form, seed: 99 } });
  assert.equal(actor.getSnapshot().value, "editing");
  assert.equal(actor.getSnapshot().context.preflight, undefined);
  actor.stop();
});

test("versioned creation draft persists only the editable form and current step", () => {
  const form = { ...defaultRunForm(), worldName: "Restored world" };
  const draft = parseRunCreationDraft(serializeRunCreationDraft(3, form));
  assert.deepEqual(draft, { version: 2, activeStep: 3, form });
  assert.equal(parseRunCreationDraft(JSON.stringify({ version: 1, activeStep: 1, form })), undefined);
});
