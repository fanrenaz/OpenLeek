import assert from "node:assert/strict";
import test from "node:test";

import {
  dynamicToolsForMemoryProfile,
  HttpHindsightMemoryClient,
  hookMemoryDynamicTools,
  memoryDynamicTools,
  resolveMemoryDynamicTool,
  splitMemoryDynamicTools,
} from "../src/memory-tools";

const binding = {
  bankId: "agent-private-bank",
  routeId: "memory",
  llmConfigRevision: "revision:llm:test",
  roundId: 1,
  toolProfile: "combined-v1" as const,
};

test("memory namespace exposes experience and current-strategy tools without runtime metadata", () => {
  assert.deepEqual(memoryDynamicTools.map((namespace) => namespace.name), ["memory"]);
  assert.deepEqual(memoryDynamicTools[0].tools.map((tool) => tool.name), [
    "retain", "recall", "reflect", "get_strategy", "update_strategy", "clear_strategy",
  ]);
  assert.deepEqual(
    Object.keys(memoryDynamicTools[0].tools[0].inputSchema.properties),
    ["content", "context"],
  );
  assert.deepEqual(
    Object.keys(memoryDynamicTools[0].tools[4].inputSchema.properties),
    ["content", "context"],
  );
  assert.equal(
    memoryDynamicTools[0].description,
    "Private continuity across Turns, including an optional active strategy for a self-chosen course of action.",
  );
  assert.match(memoryDynamicTools[0].tools[3].description, /previous intentions may be relevant/);
  assert.match(memoryDynamicTools[0].tools[3].description, /multi-Turn strategy/);
  assert.match(memoryDynamicTools[0].tools[4].description, /choose a course of action/);
  assert.match(memoryDynamicTools[0].tools[5].description, /no longer intend to pursue/);
  assert.match(memoryDynamicTools[0].tools[4].inputSchema.properties.content.description, /not a journal or current-state summary/);
  assert.match(memoryDynamicTools[0].tools[4].inputSchema.properties.context.description, /should be reconsidered/);
  assert.match(memoryDynamicTools[0].tools[5].description, /multi-Turn strategy/);
  assert.doesNotMatch(
    JSON.stringify(memoryDynamicTools),
    /\b(?:agent|run|round|bank|route|revision|metadata|tags)\b/i,
  );
});

test("split profile exposes independent memory and strategy namespaces", () => {
  assert.deepEqual(splitMemoryDynamicTools.map((namespace) => namespace.name), ["memory", "strategy"]);
  assert.deepEqual(splitMemoryDynamicTools[0].tools.map((tool) => tool.name), ["retain", "recall", "reflect"]);
  assert.deepEqual(splitMemoryDynamicTools[1].tools.map((tool) => tool.name), ["get", "update"]);
  assert.deepEqual(
    Object.keys(splitMemoryDynamicTools[1].tools[1].inputSchema.properties),
    ["content", "context"],
  );
  assert.deepEqual(
    splitMemoryDynamicTools[1].tools[1].inputSchema.properties.content.anyOf,
    [{ type: "string", minLength: 1, maxLength: 100_000 }, { type: "null" }],
  );
  assert.equal(dynamicToolsForMemoryProfile("combined-v1"), memoryDynamicTools);
  assert.equal(dynamicToolsForMemoryProfile("split-v2"), splitMemoryDynamicTools);
  assert.equal(dynamicToolsForMemoryProfile("hook-v1"), hookMemoryDynamicTools);
  assert.deepEqual(hookMemoryDynamicTools[0].tools.map((tool) => tool.name), ["retain", "recall"]);
  assert.deepEqual(hookMemoryDynamicTools[1].tools.map((tool) => tool.name), ["update"]);
});

test("split profile maps public namespace calls onto the existing storage operations", () => {
  assert.equal(resolveMemoryDynamicTool("split-v2", "memory", "retain", {}), "retain");
  assert.equal(resolveMemoryDynamicTool("split-v2", "strategy", "get", {}), "get_strategy");
  assert.equal(resolveMemoryDynamicTool("split-v2", "strategy", "update", { content: "Continue." }), "update_strategy");
  assert.equal(resolveMemoryDynamicTool("split-v2", "strategy", "update", { content: null }), "clear_strategy");
  assert.equal(resolveMemoryDynamicTool("split-v2", "memory", "get_strategy", {}), undefined);
  assert.equal(resolveMemoryDynamicTool("combined-v1", "memory", "get_strategy", {}), "get_strategy");
  assert.equal(resolveMemoryDynamicTool("combined-v1", "strategy", "get", {}), undefined);
  assert.equal(resolveMemoryDynamicTool("hook-v1", "memory", "recall", {}), "recall");
  assert.equal(resolveMemoryDynamicTool("hook-v1", "memory", "reflect", {}), undefined);
  assert.equal(resolveMemoryDynamicTool("hook-v1", "strategy", "get", {}), undefined);
  assert.equal(resolveMemoryDynamicTool("hook-v1", "strategy", "update", { content: "Continue." }), "update_strategy");
});

test("Hindsight calls are bound to the runtime-owned private bank", async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  const client = new HttpHindsightMemoryClient({
    baseUrl: "http://hindsight:8888",
    fetch: (async (input, init) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ results: [{ text: "remembered" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });
  await client.call(binding, "retain", { content: "A fact", context: "Use it later", bankId: "attacker-bank" });
  await client.call(binding, "recall", { query: "fact", budget: "mid", maxTokens: 100 });
  await client.call(binding, "reflect", { query: "What follows?", context: "Round 2" });
  assert.deepEqual(requests.map(({ url }) => url), [
    "http://hindsight:8888/v1/default/banks/agent-private-bank/memories",
    "http://hindsight:8888/v1/default/banks/agent-private-bank/memories/recall",
    "http://hindsight:8888/v1/default/banks/agent-private-bank/reflect",
  ]);
  assert.deepEqual((requests[0]?.body as { items: unknown[] }).items[0], {
    content: "A fact",
    context: "Use it later",
  });
});

test("current strategies are isolated from experience recall and expose only content and context", async () => {
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  const documents = [
    { id: "round-000001-strategy-update-call-old", created_at: "2026-07-30T00:00:00Z" },
    { id: "round-000002-strategy-clear-call-clear", created_at: "2026-07-31T00:00:00Z" },
    { id: "round-000003-strategy-update-call-new", created_at: "2026-08-01T00:00:00Z" },
  ];
  const client = new HttpHindsightMemoryClient({
    baseUrl: "http://hindsight:8888",
    fetch: (async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({ url, method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (method === "POST") return Response.json({ ok: true });
      if (url.endsWith("/documents?limit=500&offset=0")) {
        return Response.json({ items: documents, total: documents.length });
      }
      if (url.endsWith("/documents/round-000003-strategy-update-call-new")) {
        return Response.json({
          original_text: "Build a position only after confirmation.",
          retain_params: { context: "Reconsider if support fails." },
          document_metadata: { hidden: true },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch,
  });

  assert.deepEqual(await client.call({ ...binding, roundId: 2 }, "get_strategy", {}), null);
  assert.deepEqual(await client.call({ ...binding, roundId: 3 }, "get_strategy", {}), {
    content: "Build a position only after confirmation.",
    context: "Reconsider if support fails.",
  });
  assert.deepEqual(await client.call({ ...binding, roundId: 4 }, "update_strategy", {
    content: "Reduce exposure over the next two days.",
    context: "Stop if the trend reverses.",
  }, "call-set"), {
    content: "Reduce exposure over the next two days.",
    context: "Stop if the trend reverses.",
  });
  assert.equal(await client.call({ ...binding, roundId: 4 }, "clear_strategy", {}, "call-clear"), null);

  const posts = requests.filter(({ method }) => method === "POST");
  assert.equal(posts.length, 2);
  assert.match(posts[0]!.url, /banks\/agent-private-bank-strategies\/memories$/);
  assert.match(posts[1]!.url, /banks\/agent-private-bank-strategies\/memories$/);
  assert.deepEqual(((posts[0]!.body as { items: unknown[] }).items[0]), {
    content: "Reduce exposure over the next two days.",
    context: "Stop if the trend reverses.",
    document_id: "round-000004-strategy-update-call-set",
    update_mode: "replace",
  });
  assert.deepEqual(((posts[1]!.body as { items: unknown[] }).items[0]), {
    content: "The current strategy was cleared.",
    document_id: "round-000004-strategy-clear-call-clear",
    update_mode: "replace",
  });
  assert.doesNotMatch(posts.map(({ url }) => url).join("\n"), /agent-private-bank\/memories/);
});

test("fork copies experience and strategy documents only through the source round", async () => {
  const requests: Array<{ url: string; method: string }> = [];
  const client = new HttpHindsightMemoryClient({
    baseUrl: "http://hindsight:8888",
    fetch: (async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({ url, method });
      if (url.includes("/banks/source/documents?")) {
        return Response.json({
          items: [
            { id: "round-000001-call-a" },
            { id: "round-000003-call-b" },
          ],
          total: 2,
        });
      }
      if (url.includes("/banks/source-strategies/documents?")) {
        return Response.json({
          items: [
            { id: "round-000001-strategy-update-call-a" },
            { id: "round-000002-strategy-clear-call-b" },
            { id: "round-000003-strategy-update-call-c" },
          ],
          total: 3,
        });
      }
      if (url.includes("/document-transfer") && method === "GET") {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }
      if (url.includes("/document-transfer") && method === "POST") {
        return Response.json({ operation_id: url.includes("/target-strategies/") ? "strategy-operation" : "memory-operation" });
      }
      if (url.includes("/operations/")) return Response.json({ status: "completed" });
      return new Response("not found", { status: 404 });
    }) as typeof fetch,
  });

  await client.fork!(
    { ...binding, bankId: "source", roundId: 2 },
    { ...binding, bankId: "target", roundId: 2 },
    2,
  );

  const exports = requests.filter(({ method, url }) => method === "GET" && url.includes("/document-transfer"));
  assert.equal(exports.length, 2);
  assert.match(exports[0]!.url, /banks\/source\/document-transfer\?document_id=round-000001-call-a$/);
  assert.match(exports[1]!.url, /banks\/source-strategies\/document-transfer\?/);
  assert.match(exports[1]!.url, /document_id=round-000001-strategy-update-call-a/);
  assert.match(exports[1]!.url, /document_id=round-000002-strategy-clear-call-b/);
  assert.doesNotMatch(exports.map(({ url }) => url).join("\n"), /round-000003/);
  assert.ok(requests.some(({ method, url }) => method === "POST" && url.includes("/banks/target/document-transfer")));
  assert.ok(requests.some(({ method, url }) => method === "POST" && url.includes("/banks/target-strategies/document-transfer")));
});
