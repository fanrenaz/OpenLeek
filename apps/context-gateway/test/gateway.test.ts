import assert from "node:assert/strict";
import test from "node:test";
import { ContextGateway } from "../src/server/gateway";
import { MemoryGatewayStore } from "../src/server/runtime";
test("Gateway routes only explicitly granted namespaced tools", async () => {
  let authorization = "";
  const gateway = new ContextGateway(new MemoryGatewayStore(), async () => ({ installation: { endpoint: "http://social:3000", contextId: "social" }, bearerToken: "upstream-secret" }), async (_input, init) => { authorization = new Headers(init?.headers).get("authorization") ?? ""; return Response.json({ jsonrpc: "2.0", id: 1, result: { ok: true } }); });
  const issued = await gateway.issue({ runId: "run:1", agentId: "agent:1", expiresAt: new Date(Date.now() + 60_000).toISOString(), routes: [{ contextId: "social", installationRef: "install:social", tools: ["social.create_post"], resources: ["social.feed"] }] });
  const allowed = await gateway.forward(issued.bearerToken, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "social.create_post", arguments: {} } });
  assert.equal(allowed.status, 200); assert.equal(authorization, "Bearer upstream-secret");
  assert.equal((await gateway.forward(issued.bearerToken, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "social.publish", arguments: {} } })).status, 403);
});

test("Gateway forwards protocol negotiation for a singly scoped credential", async () => {
  const methods: string[] = [];
  const gateway = new ContextGateway(new MemoryGatewayStore(), async () => ({ installation: { endpoint: "http://news:3000", contextId: "news" }, bearerToken: "upstream-secret" }), async (_input, init) => {
    methods.push(JSON.parse(String(init?.body)).method);
    return Response.json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } });
  });
  const issued = await gateway.issue({ runId: "run:1", agentId: "agent:1", expiresAt: new Date(Date.now() + 60_000).toISOString(), routes: [{ contextId: "news", installationRef: "install:news", tools: [], resources: ["news.daily"] }] });

  assert.equal((await gateway.forward(issued.bearerToken, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).status, 200);
  assert.equal((await gateway.forward(issued.bearerToken, { jsonrpc: "2.0", method: "notifications/initialized" })).status, 200);
  assert.equal((await gateway.forward(issued.bearerToken, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })).status, 200);
  assert.deepEqual(methods, ["initialize", "notifications/initialized", "tools/list"]);
});

test("Gateway routes standard resource URIs by scheme and leaves exact ownership to the Context", async () => {
  const gateway = new ContextGateway(new MemoryGatewayStore(), async () => ({ installation: { endpoint: "http://news:3000", contextId: "news" }, bearerToken: "upstream-secret" }), async () => Response.json({ jsonrpc: "2.0", id: 1, result: {} }));
  const issued = await gateway.issue({ runId: "run:1", agentId: "agent:1", expiresAt: new Date(Date.now() + 60_000).toISOString(), routes: [{ contextId: "news", installationRef: "install:news", tools: [], resources: ["news.daily"] }] });

  assert.equal((await gateway.forward(issued.bearerToken, { jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "news://revision/news-revision%3A1/days/2026-01-01" } })).status, 200);
  assert.equal((await gateway.forward(issued.bearerToken, { jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: "social://revision/social-revision%3A1/feed" } })).status, 403);
});

test("Gateway denies standard resource URIs when the route grants no resources", async () => {
  const gateway = new ContextGateway(new MemoryGatewayStore(), async () => ({ installation: { endpoint: "http://news:3000", contextId: "news" }, bearerToken: "upstream-secret" }), async () => Response.json({ jsonrpc: "2.0", id: 1, result: {} }));
  const issued = await gateway.issue({ runId: "run:1", agentId: "agent:1", expiresAt: new Date(Date.now() + 60_000).toISOString(), routes: [{ contextId: "news", installationRef: "install:news", tools: [], resources: [] }] });
  assert.equal((await gateway.forward(issued.bearerToken, { jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "news://revision/news-revision%3A1/days/2026-01-01" } })).status, 403);
});

test("Gateway authorizes server-local tool names from globally qualified policy grants", async () => {
  const gateway = new ContextGateway(new MemoryGatewayStore(), async () => ({ installation: { endpoint: "http://financial:3000", contextId: "financial" }, bearerToken: "upstream" }), async (_url, init) => Response.json(JSON.parse(String(init?.body))));
  const issued = await gateway.issue({ runId: "run:1", agentId: "agent:1", expiresAt: new Date(Date.now() + 60_000).toISOString(), routes: [{ contextId: "financial", installationRef: "install:financial", tools: ["financial.get_quote"], resources: [] }] });
  const response = await gateway.forward(issued.bearerToken, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_quote", arguments: {} } });
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { params?: { name?: string } }).params?.name, "get_quote");
});
