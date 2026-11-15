import assert from "node:assert/strict";
import { test } from "node:test";
import { fromEnvironmentConfig, testConfiguration } from "../src/server/bootstrap";
import { graphFor, resolvedProfile, revisionFor, validateConfig } from "../src/server/model";
import { LlmConfigurationService } from "../src/server/service";
import { InMemoryConfigStore, SnapshotEncryption } from "../src/server/store";

test("bootstrap creates the independent Hindsight memory route from environment", () => {
  const config = fromEnvironmentConfig({
    OPENLEEK_LLM_CONFIGURATION_BOOTSTRAP_PROVIDER: "upstream",
    OPENLEEK_LLM_CONFIGURATION_BOOTSTRAP_PROTOCOL: "anthropic",
    OPENLEEK_LLM_CONFIGURATION_BOOTSTRAP_BASE_URL: "https://example.invalid/anthropic",
    OPENLEEK_LLM_CONFIGURATION_BOOTSTRAP_API_KEY: "secret",
    OPENLEEK_LLM_CONFIGURATION_BOOTSTRAP_MODEL: "model-flash",
  });
  assert.deepEqual(validateConfig(config), []);
  assert.equal(resolvedProfile(config, "memory").model, "model-flash");
  assert.equal(resolvedProfile(config, "memory").protocol, "anthropic");
});

test("service publishes immutable revisions and rejects stale mutations", async () => {
  const store = new InMemoryConfigStore();
  const service = new LlmConfigurationService(store);
  await service.initialize(async () => testConfiguration());
  const first = await service.graph();
  const saved = await service.patch({
    baseRevision: first.revision,
    changes: [{ kind: "route", id: "memory", field: "model", value: "agent-model" }],
  });
  assert.equal(saved.result, "committed");
  assert.notEqual(saved.revision, first.revision);
  const stale = await service.patch({
    baseRevision: first.revision,
    changes: [{ kind: "route", id: "memory", field: "model", value: "memory-model" }],
  });
  assert.equal(stale.result, "revisionConflict");
  assert.equal((await service.profile(first.revision, "memory"))?.model, "memory-model");
  assert.equal((await service.profile(saved.revision, "memory"))?.model, "agent-model");
});

test("public graph masks provider credentials", () => {
  const config = testConfiguration();
  const graph = graphFor(config, revisionFor(config));
  const provider = graph.resources.find((resource) => resource.kind === "provider");
  assert.equal(provider?.value.api_key, "******");
  assert.equal(resolvedProfile(config, "memory").apiKey, "test-secret");
});

test("snapshot encryption authenticates the complete payload", () => {
  const encryption = new SnapshotEncryption(Buffer.alloc(32, 7));
  const encrypted = encryption.encrypt("sensitive");
  assert.equal(encryption.decrypt(encrypted), "sensitive");
  const parts = encrypted.split(".");
  parts[2] = `${parts[2]?.[0] === "A" ? "B" : "A"}${parts[2]?.slice(1)}`;
  assert.throws(() => encryption.decrypt(parts.join(".")));
});
