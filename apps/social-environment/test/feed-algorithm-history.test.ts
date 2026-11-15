import assert from "node:assert/strict";
import test from "node:test";
import type { FeedAlgorithmExecutor } from "../src/application/feed-algorithm-executor.js";
import { SocialEnvironmentService } from "../src/application/social-environment-service.js";
import type { SocialState } from "../src/application/state-store.js";
import { InMemorySocialStateStore } from "../src/infrastructure/memory-state-store.js";

const mutation = (stepId: string, expectedCheckpointRef = "") => ({
  transitionId: `feed-algorithm-history:${stepId}`,
  stepId,
  payloadDigest: stepId.padEnd(64, "b").slice(0, 64),
  expectedCheckpointRef,
});

test("Feed Algorithms read only complete committed Social lineage and capabilities are one execution", async () => {
  let service: SocialEnvironmentService;
  const capabilities: string[] = [];
  const observedRounds: number[][] = [];
  const executor: FeedAlgorithmExecutor = {
    async validate() {
      return { valid: true, configSchema: {}, defaultConfig: {}, errors: [] };
    },
    async execute(input) {
      capabilities.push(input.socialHistory.capability);
      const all = await service.readFeedAlgorithmHistory({
        capability: input.socialHistory.capability,
        operation: "all",
      }) as { records: Array<{ roundId: number; snapshot: Record<string, unknown> }> };
      observedRounds.push(all.records.map((record) => record.roundId));
      assert.deepEqual(all.records.map((record) => record.roundId), [0, 1]);
      const roundOne = await service.readFeedAlgorithmHistory({
        capability: input.socialHistory.capability,
        operation: "round",
        roundId: 1,
      }) as { roundId: number; snapshot: Record<string, unknown> };
      assert.equal(roundOne.roundId, 1);
      assert.deepEqual(Object.keys(roundOne.snapshot.posts as Record<string, unknown>), ["post-1"]);
      assert.deepEqual(roundOne.snapshot.engagements, {
        "engagement:run:history:like-action-1": {
          engagementId: "engagement:run:history:like-action-1",
          actorId: "alice",
          targetPostId: "post-1",
          kind: "like",
          roundId: 1,
        },
      });
      assert.ok("exposures" in roundOne.snapshot);
      assert.ok("relationships" in roundOne.snapshot);
      await assert.rejects(
        () => service.readFeedAlgorithmHistory({
          capability: input.socialHistory.capability,
          operation: "all",
          cursor: "not-a-cursor",
        }),
        /cursor is invalid/,
      );
      return {
        feeds: input.actorIds.map((actorId) => ({
          actorId,
          postIds: Object.keys(roundOne.snapshot.posts as Record<string, unknown>),
        })),
      };
    },
  };
  service = await SocialEnvironmentService.create({
    stateStore: new InMemorySocialStateStore(),
    feedAlgorithmExecutor: executor,
    feedAlgorithmHistoryEndpoint: "http://social.test/internal/feed-algorithm/history",
  });
  const draft = await service.saveFeedAlgorithmDraft({
    name: "History reader",
    source: "class FeedAlgorithm:\n    def __init__(self, config, context): pass\n    def rank(self, actor_id): return []",
    defaultConfig: {},
  });
  const version = await service.publishFeedAlgorithm({ algorithmId: draft.algorithmId, expectedRevision: draft.revision });
  await service.initializeRevision("run:history", {
    actors: [{ actorId: "alice", displayName: "Alice", maximumActionsPerRound: 5 }],
    feedSize: 5,
    feedAlgorithm: { versionRef: version.versionRef, config: {} },
  }, mutation("initialize"));
  const initialCheckpoint = service.sealedCheckpoint("run:history", 0);
  await service.apply("run:history", 1, [{
    kind: "post",
    actionId: "post-action-1",
    actorId: "alice",
    postId: "post-1",
    content: "committed history",
  }, {
    kind: "engagement",
    actionId: "like-action-1",
    actorId: "alice",
    targetPostId: "post-1",
    engagementKind: "like",
  }], mutation("post", initialCheckpoint.ref));
  const sealed = await service.seal("run:history", 1, mutation("seal", initialCheckpoint.ref));
  await service.publish("run:history", 1, sealed.ref, mutation("publish", initialCheckpoint.ref));
  const committed = service.currentRevision("run:history");

  const read = await service.freezeFullSnapshot({
    runId: "run:history",
    roundId: 2,
    baseline: committed,
    mutation: mutation("freeze", committed.ref),
  });
  const readSnapshot = service.revisionSnapshot("run:history", read.ref);
  assert.equal(readSnapshot.exposures[JSON.stringify([2, "alice", "post-1"])]?.rank, 1);
  assert.deepEqual(observedRounds, [[0, 1]], "the round-two read snapshot is never part of its own algorithm history");
  await assert.rejects(
    () => service.readFeedAlgorithmHistory({ capability: capabilities[0]!, operation: "all" }),
    /inactive or expired/,
  );

  const beforePreview = service.revisionSnapshot("run:history", committed.ref);
  const preview = await service.previewFeedAlgorithm({
    versionRef: version.versionRef,
    config: {},
    runId: "run:history",
    revisionRef: committed.ref,
    seed: "preview-seed",
  });
  assert.deepEqual(preview.feeds, [{ actorId: "alice", postIds: ["post-1"] }]);
  assert.deepEqual(service.revisionSnapshot("run:history", committed.ref).exposures, beforePreview.exposures);
  await assert.rejects(
    () => service.readFeedAlgorithmHistory({ capability: capabilities[1]!, operation: "round", roundId: 1 }),
    /inactive or expired/,
  );

  const fork = await service.forkRevision({
    sourceRunId: "run:history",
    targetRunId: "run:history-fork",
    sourceRevision: committed,
    mutation: mutation("fork", committed.ref),
  });
  const forkPreview = await service.previewFeedAlgorithm({
    versionRef: version.versionRef,
    config: {},
    runId: "run:history-fork",
    revisionRef: fork.ref,
    seed: "fork-preview-seed",
  });
  assert.deepEqual(forkPreview.feeds, [{ actorId: "alice", postIds: ["post-1"] }]);
  assert.deepEqual(observedRounds, [[0, 1], [0, 1], [0, 1]], "fork history retains its committed source lineage");
});

test("Social owner state v1 is rejected instead of migrated", async () => {
  const legacy = {
    version: 1,
    runs: {},
    idempotency: {},
    algorithmRegistry: { drafts: {}, versions: {} },
  } as unknown as SocialState;
  await assert.rejects(
    SocialEnvironmentService.create({
      stateStore: {
        async load() { return legacy; },
        async loadRevision() { return undefined; },
        async save() {},
      },
    }),
    /state snapshot is invalid/,
  );
});
