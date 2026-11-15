import assert from "node:assert/strict";
import test from "node:test";
import { ContextRegistry } from "../src/server/registry";
import { MemoryStore } from "../src/server/runtime";

test("bootstrap secrets are returned once and never appear in installation reads", async () => {
  const store = new MemoryStore();
  const registry = new ContextRegistry(store, Buffer.alloc(32, 7));
  const created = await registry.create({ contextId: "news", endpoint: "http://news-context:3000", management: "platform", infrastructure: { postgres: true } });
  assert.ok(created.bootstrap.bearerToken.length >= 32);
  assert.equal("bearerToken" in await registry.get(created.installation.installationRef), false);
  assert.equal(JSON.stringify(await registry.list()).includes(created.bootstrap.bearerToken), false);
});

test("activation verifies descriptor identity and preserves strict lifecycle", async () => {
  const store = new MemoryStore();
  const registry = new ContextRegistry(store, Buffer.alloc(32, 8), async () => new Response(JSON.stringify({
    schemaVersion: "3", runtimeProtocol: "openleek-context-runtime/v2", contextId: "news", revision: "news-context:v3",
    label: { default: "News", translations: {} }, description: { default: "News", translations: {} }, infrastructure: { postgres: true }, agentAccess: "read-only",
    agentEnvironment: { capabilities: [] }, worldEnvironment: { collections: [] },
  }), { status: 200 }));
  const { installation } = await registry.create({ contextId: "news", endpoint: "http://news-context:3000", management: "platform", infrastructure: { postgres: true } });
  await assert.rejects(registry.verifyAndActivate(installation.installationRef), /only provisioned/);
  await registry.transition(installation.installationRef, "provisioned");
  assert.equal((await registry.verifyAndActivate(installation.installationRef)).descriptorRevision, "news-context:v3");
});

test("self-managed installations require TLS", async () => {
  const registry = new ContextRegistry(new MemoryStore(), Buffer.alloc(32, 9));
  await assert.rejects(registry.create({ contextId: "news", endpoint: "http://example.test", management: "self-managed" }), /HTTPS/);
});

test("built-in installation adoption is deterministic and refreshes activation", async () => {
  let token = "";
  const registry = new ContextRegistry(new MemoryStore(), Buffer.alloc(32, 4), async (_url, init) => {
    token = new Headers(init?.headers).get("authorization") ?? "";
    return Response.json({
      schemaVersion: "3", runtimeProtocol: "openleek-context-runtime/v2", contextId: "news", revision: "news-context:v3",
      label: { default: "News", translations: {} }, description: { default: "News", translations: {} }, infrastructure: { postgres: true, redis: false }, agentAccess: "read-only",
      agentEnvironment: { capabilities: [] }, worldEnvironment: { collections: [] },
    });
  });
  const input = { installationRef: "context-installation:news:builtin", contextId: "news", endpoint: "http://news:3000", bearerToken: "first", infrastructure: { postgres: true, redis: false } } as const;
  assert.equal((await registry.ensureBuiltin(input)).state, "provisioned");
  assert.equal((await registry.verifyAndActivate(input.installationRef)).state, "active");
  await registry.ensureBuiltin({ ...input, bearerToken: "second" });
  assert.equal((await registry.verifyAndActivate(input.installationRef)).state, "active");
  assert.equal(token, "Bearer second");
});
