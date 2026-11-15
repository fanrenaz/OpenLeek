import assert from "node:assert/strict";
import test from "node:test";
import { NewsContextService, projectNewsRevision, projectNewsScope } from "../src/server/news";
import { newsDeletionInput, newsDescriptor } from "../src/server/router";
import { MemoryNewsStore } from "../src/server/runtime";

const day = 86_400;
const startUnixSeconds = Date.parse("2026-01-01T12:00:00Z") / 1000;
const definition = { schemaVersion: "2" as const, articles: [
  { articleId: "day-one-am", headline: "Day one AM", body: "Full AM report", publishedAt: "2026-01-01T08:00:00Z", source: "Research Desk" },
  { articleId: "day-one-pm", headline: "Day one PM", body: "Full PM report", publishedAt: "2026-01-01T16:00:00Z" },
  { articleId: "day-two", headline: "Day two", body: "Full day two report", publishedAt: "2026-01-02T09:00:00Z" },
] };

async function scopedService(resources: string[] = ["news.daily"]) {
  const service = new NewsContextService(new MemoryNewsStore());
  const scenario = await service.publishScenario({ name: "Daily timeline", definition });
  const initial = await service.initialize({ runId: "run:news", scenarioVersionRef: scenario.versionRef, clock: { startUnixSeconds, stepSeconds: day } });
  assert.equal(initial.committed, true);
  const round1 = await service.freeze({ runId: "run:news", roundId: 1, baselineRef: initial.ref });
  await service.bind({ runId: "run:news", agents: [{ agentId: "agent:a", principalId: "principal:a", bearerToken: "opaque", tools: ["news.get_article"], resources }] });
  await service.openScope({ runId: "run:news", roundId: 1, agentId: "agent:a", principalId: "principal:a", revisionRef: round1.ref, turnId: "turn:1", attemptId: "attempt:1" });
  return { service, initial, round1, scenario };
}

test("News exposes only full daily resources at or before the exact simulation time", async () => {
  const { service, initial, round1 } = await scopedService();
  const listed = await service.listDailyResources("opaque");
  assert.equal(listed.resources.length, 1);
  assert.match(listed.resources[0].uri, new RegExp(`^news://revision/${encodeURIComponent(round1.ref)}/days/2026-01-01$`));
  const daily = await service.readDailyResource("opaque", listed.resources[0].uri);
  assert.deepEqual(daily.articles.map((item) => item.articleId), ["day-one-am"]);
  assert.equal(daily.articles[0].body, "Full AM report");

  const round2 = await service.freeze({ runId: "run:news", roundId: 2, baselineRef: round1.ref });
  await service.openScope({ runId: "run:news", roundId: 2, agentId: "agent:a", principalId: "principal:a", revisionRef: round2.ref, turnId: "turn:2", attemptId: "attempt:2" });
  const dates = await service.listDailyResources("opaque");
  assert.deepEqual(dates.resources.map((item) => item.name), ["News 2026-01-02", "News 2026-01-01"]);
  const historical = await service.readDailyResource("opaque", dates.resources[1].uri);
  assert.deepEqual(historical.articles.map((item) => item.articleId), ["day-one-am", "day-one-pm"]);
  await assert.rejects(service.readDailyResource("opaque", `news://revision/${encodeURIComponent(initial.ref)}/days/2026-01-01`), /active revision/);
});

test("News Scenario v2 and Run clock are immutable runtime inputs", async () => {
  const service = new NewsContextService(new MemoryNewsStore());
  await assert.rejects(service.publishScenario({ name: "legacy", definition: { articles: [{ articleId: "a", headline: "A", body: "B", releaseRound: 1 }] } }), /schemaVersion/);
  const scenario = await service.publishScenario({ name: "Daily", definition: { schemaVersion: "2", articles: [] } });
  await service.initialize({ runId: "run:immutable", scenarioVersionRef: scenario.versionRef, clock: { startUnixSeconds, stepSeconds: day } });
  await assert.rejects(service.initialize({ runId: "run:immutable", scenarioVersionRef: scenario.versionRef, clock: { startUnixSeconds, stepSeconds: 60 } }), /immutable/);
});

test("News initializes a committed round-zero baseline that can be forked", async () => {
  const service = new NewsContextService(new MemoryNewsStore());
  const scenario = await service.publishScenario({ name: "Daily", definition: { schemaVersion: "2", articles: [] } });
  const baseline = await service.initialize({ runId: "run:source", scenarioVersionRef: scenario.versionRef, clock: { startUnixSeconds, stepSeconds: day } });
  const forked = await service.fork({ sourceRevisionRef: baseline.ref, targetRunId: "run:fork", targetClock: { startUnixSeconds, stepSeconds: day } });
  assert.equal(forked.committed, true);
  assert.equal(forked.roundId, 0);
});

test("Runtime v2 exposes only the generic revision and scope projections", async () => {
  const { round1, service } = await scopedService();
  assert.deepEqual(Object.keys(projectNewsRevision(round1)).sort(), ["context", "digest", "parentRevisionRef", "ref", "roundId", "runId"]);
  const scope = await service.openScope({ runId: "run:news", roundId: 1, agentId: "agent:a", principalId: "principal:a", revisionRef: round1.ref, turnId: "turn:again", attemptId: "attempt:again" });
  assert.equal(Object.hasOwn(projectNewsScope(scope), "revisionRef"), false);
});

test("News persists deletion provenance and rejects ungranted daily resources", async () => {
  const service = new NewsContextService(new MemoryNewsStore());
  const draft = await service.saveDraft({ name: "Timeline", definition: { schemaVersion: "2", articles: [] } });
  const version = await service.publishDraft({ scenarioId: draft.scenarioId, expectedRevision: draft.revision });
  const deleted = await service.deleteScenario({ target: "version", assetId: version.versionRef, idempotencyKey: "delete:1" });
  assert.equal(deleted.status, "deleted");
  assert.equal((await service.listScenarios(true)).tombstones.length, 1);
  const ungranted = await scopedService([]);
  await assert.rejects(ungranted.service.listDailyResources("opaque"), /not granted/);
});

test("News descriptor advertises one Resource and no Tools", () => {
  assert.equal(newsDescriptor.revision, "news-context:v4");
  assert.deepEqual(newsDescriptor.agentEnvironment.capabilities, [{ id: "news.daily", kind: "resource", label: { default: "Daily news", translations: { zh: "每日新闻" } } }]);
});

test("News normalizes generic dynamic-asset deletion fields at its owner boundary", () => {
  assert.deepEqual(newsDeletionInput({ target: "version", versionRef: "news-scenario:legacy:v:1", idempotencyKey: "delete:legacy" }), { target: "version", assetId: "news-scenario:legacy:v:1", idempotencyKey: "delete:legacy" });
  assert.deepEqual(newsDeletionInput({ target: "draft", algorithmId: "news-scenario:draft", expectedRevision: 2, idempotencyKey: "delete:draft" }), { target: "draft", assetId: "news-scenario:draft", expectedRevision: 2, idempotencyKey: "delete:draft" });
});
