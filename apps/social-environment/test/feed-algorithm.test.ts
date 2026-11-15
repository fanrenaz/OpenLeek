import assert from "node:assert/strict";
import test from "node:test";
import type { FeedAlgorithmExecutor } from "../src/application/feed-algorithm-executor.js";
import { SocialEnvironmentService } from "../src/application/social-environment-service.js";
import { InMemorySocialStateStore } from "../src/infrastructure/memory-state-store.js";

const mutation = (stepId: string, expectedCheckpointRef = "") => ({
  transitionId: `feed-algorithm:${stepId}`,
  stepId,
  payloadDigest: stepId.padEnd(64, "a").slice(0, 64),
  expectedCheckpointRef,
});

class RecordingExecutor implements FeedAlgorithmExecutor {
  readonly executions: Array<{
    seed: string;
    roundId: number;
    config: Record<string, unknown>;
    feedSize: number;
    actorIds: string[];
    socialHistory: { endpoint: string; capability: string };
  }> = [];

  async validate() {
    return {
      valid: true,
      configSchema: { type: "object", properties: { boost: { type: "number", default: 2 } } },
      defaultConfig: { boost: 2 },
      errors: [],
    };
  }

  async execute(input: Parameters<FeedAlgorithmExecutor["execute"]>[0]) {
    this.executions.push({
      seed: input.seed,
      roundId: input.roundId,
      config: input.config,
      feedSize: input.feedSize,
      actorIds: input.actorIds,
      socialHistory: input.socialHistory,
    });
    return { feeds: input.actorIds.map((actorId) => ({ actorId, postIds: [] })) };
  }
}

test("Social saves editable source separately, publishes immutable versions, and freezes only the version reference", async () => {
  const executor = new RecordingExecutor();
  const service = await SocialEnvironmentService.create({ stateStore: new InMemorySocialStateStore(), feedAlgorithmExecutor: executor });
  const draft = await service.saveFeedAlgorithmDraft({
    name: "Research feed",
    source: "class FeedAlgorithm:\n    CONFIG_SCHEMA = {}\n    DEFAULT_CONFIG = {}\n    def __init__(self, config, context): pass\n    def rank(self, actor_id): return []",
    defaultConfig: { boost: 1 },
    dependencies: ["numpy"],
  });
  const validation = await service.validateFeedAlgorithm({ algorithmId: draft.algorithmId });
  assert.equal(validation.valid, true);
  const version = await service.publishFeedAlgorithm({ algorithmId: draft.algorithmId, expectedRevision: draft.revision });
  assert.equal(version.defaultConfig.boost, 2, "runner-supplied default config is frozen with the version");
  assert.equal(service.listFeedAlgorithms().versions[0]?.versionRef, version.versionRef);

  const initial = await service.initializeRevision("run:custom-feed", {
    actors: [
      { actorId: "alice", displayName: "Alice", maximumActionsPerRound: 5 },
      { actorId: "bob", displayName: "Bob", maximumActionsPerRound: 5 },
    ],
    feedSize: 10,
    feedAlgorithm: { versionRef: version.versionRef, config: { boost: 7 } },
  }, mutation("initialize"), 123);
  const checkpoint = service.sealedCheckpoint("run:custom-feed", 0);
  await service.apply("run:custom-feed", 1, [{ kind: "post", actionId: "post-1", actorId: "alice", postId: "post-1", content: "research" }], mutation("post", checkpoint.ref));
  const sealed = await service.seal("run:custom-feed", 1, mutation("seal", checkpoint.ref));
  await service.publish("run:custom-feed", 1, sealed.ref, mutation("publish", checkpoint.ref));
  const committed = service.currentRevision("run:custom-feed");
  await service.freezeFullSnapshot({ runId: "run:custom-feed", roundId: 2, baseline: committed, mutation: mutation("freeze", committed.ref) });
  assert.deepEqual(executor.executions[0]?.config, { boost: 7 });
  assert.equal(executor.executions[0]?.roundId, 2);
  assert.match(executor.executions[0]?.seed ?? "", /^[a-f0-9]{64}$/);
  assert.deepEqual(executor.executions[0]?.actorIds, ["alice", "bob"]);
  assert.equal("snapshot" in (executor.executions[0] ?? {}), false);
  assert.match(executor.executions[0]?.socialHistory.endpoint ?? "", /internal\/feed-algorithm\/history$/);

  const changedDraft = await service.saveFeedAlgorithmDraft({
    algorithmId: draft.algorithmId,
    expectedRevision: draft.revision,
    name: draft.name,
    source: `${draft.source}\n# edited after publish`,
    defaultConfig: { boost: 99 },
  });
  assert.equal(changedDraft.revision, 2);
  assert.equal(service.getFeedAlgorithmVersion(version.versionRef).source.includes("edited after publish"), false);
});

test("Social Feed Algorithm tombstones hide selections but retain audit reads", async () => {
  const service = await SocialEnvironmentService.create({
    stateStore: new InMemorySocialStateStore(),
    feedAlgorithmExecutor: new RecordingExecutor(),
  });
  const draft = await service.saveFeedAlgorithmDraft({
    algorithmId: "feed:delete-test",
    name: "Delete test",
    source: "class FeedAlgorithm: pass",
    defaultConfig: {},
  });
  await assert.rejects(
    service.deleteFeedAlgorithmDraft({ algorithmId: draft.algorithmId, expectedRevision: draft.revision + 1, idempotencyKey: "wrong" }),
    (error: unknown) => error instanceof Error && error.message.includes("draft has changed"),
  );
  assert.equal((await service.deleteFeedAlgorithmDraft({ algorithmId: draft.algorithmId, expectedRevision: draft.revision, idempotencyKey: "delete-draft" })).status, "deleted");
  assert.equal((await service.deleteFeedAlgorithmDraft({ algorithmId: draft.algorithmId, expectedRevision: draft.revision, idempotencyKey: "delete-draft" })).replayed, true);
  assert.equal(service.listFeedAlgorithms().drafts.length, 0);
  assert.equal(service.getFeedAlgorithmDraft(draft.algorithmId, true).source, draft.source);
  await assert.rejects(service.saveFeedAlgorithmDraft({ algorithmId: draft.algorithmId, name: draft.name, source: draft.source, defaultConfig: {} }), /cannot be reused/);

  const versionDraft = await service.saveFeedAlgorithmDraft({ algorithmId: "feed:version-delete-test", name: "Version", source: "class FeedAlgorithm: pass", defaultConfig: {} });
  const version = await service.publishFeedAlgorithm({ algorithmId: versionDraft.algorithmId, expectedRevision: versionDraft.revision });
  await service.deleteFeedAlgorithmVersion({ versionRef: version.versionRef, idempotencyKey: "delete-version" });
  assert.throws(() => service.getFeedAlgorithmVersion(version.versionRef), /does not exist/);
  assert.equal(service.getFeedAlgorithmVersion(version.versionRef, true).artifactDigest, version.artifactDigest);
  assert.equal(service.listFeedAlgorithms().versions.length, 0);
  assert.equal(service.listFeedAlgorithms(true).versions[0]?.versionRef, version.versionRef);
  await assert.rejects(service.publishFeedAlgorithm({ algorithmId: versionDraft.algorithmId, expectedRevision: versionDraft.revision }), /identical content belongs to a deleted/);
});
