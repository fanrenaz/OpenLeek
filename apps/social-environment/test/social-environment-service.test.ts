import assert from "node:assert/strict";
import test from "node:test";
import { SocialDomainError } from "../src/application/errors.js";
import { SocialEnvironmentService } from "../src/application/social-environment-service.js";
import { InMemorySocialStateStore } from "../src/infrastructure/memory-state-store.js";
import type { CommittedSocialGraph, Mutation, SocialSection } from "../src/domain/models.js";
import type { SocialProjection } from "../src/application/projection.js";

const DIGEST = (value: string): string => (value === "changed" ? "b" : "a").repeat(64);

function mutation(stepId: string, expectedCheckpointRef = ""): Mutation {
  return {
    transitionId: "transition-1",
    stepId,
    payloadDigest: DIGEST(stepId),
    expectedCheckpointRef,
  };
}

const section: SocialSection = {
  actors: [
    { actorId: "alice", displayName: "Alice", maximumActionsPerRound: 5 },
    { actorId: "bob", displayName: "Bob", maximumActionsPerRound: 5 },
  ],
  relationships: [{ actorId: "bob", targetActorId: "alice" }],
  feedSize: 10,
  ranking: { recencyWeight: 1, engagementWeight: 1 },
  audienceReception: { engagementProbability: 0.1, repostProbability: 0.02 },
};

async function service(store = new InMemorySocialStateStore(), projection?: SocialProjection) {
  return SocialEnvironmentService.create({ stateStore: store, ...(projection === undefined ? {} : { projection }) });
}

async function initialized(store = new InMemorySocialStateStore(), projection?: SocialProjection) {
  const context = await service(store, projection);
  const checkpoint = await context.initialize("run-1", section, mutation("initialize"));
  return { context, checkpoint, store };
}

test("pending posts, engagements, and relationships stay hidden until publish", async () => {
  const { context, checkpoint } = await initialized();
  const beforePublish = await context.observe("run-1", 1, ["bob"], mutation("observe-1", checkpoint.ref));
  assert.deepEqual(beforePublish[0]?.exposures, []);

  const acceptedPosts = await context.apply("run-1", 1, [
    { kind: "post", actionId: "post-action", actorId: "alice", postId: "post-1", headline: "Opening", content: "Market update" },
    { kind: "engagement", actionId: "like-action", actorId: "bob", targetPostId: "post-1", engagementKind: "like" },
    { kind: "relationship", actionId: "unfollow-action", actorId: "bob", targetActorId: "alice", relationshipKind: "unfollow" },
  ], mutation("apply-1", checkpoint.ref));
  assert.deepEqual(acceptedPosts.map((post) => post.postId), ["post-1"]);

  const sealed = await context.seal("run-1", 1, mutation("seal-1", checkpoint.ref));
  assert.throws(
    () => context.exportFacts("run-1", 1, sealed.ref),
    (error: unknown) => error instanceof SocialDomainError && error.code === "PRECONDITION_FAILED",
  );
  await context.publish("run-1", 1, sealed.ref, mutation("publish-1", checkpoint.ref));

  const facts = context.exportFacts("run-1", 1, sealed.ref);
  assert.deepEqual(facts.posts.map((post) => post.postId), ["post-1"]);
  assert.equal(facts.engagements.length, 1);
  assert.deepEqual(facts.relationships, []);
  assert.deepEqual(facts.summary.audienceReception, [{
    postId: "post-1",
    exposureCount: 0,
    likeCount: 1,
    repostCount: 0,
    replyCount: 0,
  }]);
});

test("ObserveAgents atomically settles a deterministic idempotent exposure feed", async () => {
  const { context, checkpoint } = await initialized();
  await context.apply("run-1", 1, [
    { kind: "post", actionId: "post-b", actorId: "alice", postId: "post-b", content: "B" },
    { kind: "post", actionId: "post-a", actorId: "alice", postId: "post-a", content: "A" },
  ], mutation("apply-1", checkpoint.ref));
  const sealedOne = await context.seal("run-1", 1, mutation("seal-1", checkpoint.ref));
  await context.publish("run-1", 1, sealedOne.ref, mutation("publish-1", checkpoint.ref));

  const first = await context.observe("run-1", 2, ["bob"], mutation("observe-2", sealedOne.ref));
  const replay = await context.observe("run-1", 2, ["bob"], mutation("observe-2", sealedOne.ref));
  assert.deepEqual(replay, first);
  assert.deepEqual(first[0]?.exposures.map((item) => [item.postId, item.rank]), [
    ["post-a", 1],
    ["post-b", 2],
  ]);

  await assert.rejects(
    () => context.observe("run-1", 2, ["bob"], { ...mutation("observe-2", sealedOne.ref), payloadDigest: DIGEST("changed") }),
    (error: unknown) => error instanceof SocialDomainError && error.code === "IDEMPOTENCY_CONFLICT",
  );
});

test("restart restores pending state and the idempotency ledger", async () => {
  const store = new InMemorySocialStateStore();
  const { context, checkpoint } = await initialized(store);
  const apply = mutation("apply-1", checkpoint.ref);
  await context.apply("run-1", 1, [
    { kind: "post", actionId: "post-action", actorId: "alice", postId: "post-1", content: "pending" },
  ], apply);
  // This snapshot is written as PostgreSQL jsonb in production, which rejects
  // literal NUL escape sequences in object keys.
  assert.equal(JSON.stringify(await store.load()).includes("\\u0000"), false);

  const restarted = await service(store);
  const replay = await restarted.apply("run-1", 1, [
    { kind: "post", actionId: "other", actorId: "alice", postId: "other", content: "ignored" },
  ], apply);
  assert.deepEqual(replay.map((post) => post.postId), ["post-1"]);
  const sealed = await restarted.seal("run-1", 1, mutation("seal-1", checkpoint.ref));
  await restarted.publish("run-1", 1, sealed.ref, mutation("publish-1", checkpoint.ref));
  assert.equal(restarted.exportFacts("run-1", 1, sealed.ref).posts[0]?.content, "pending");
});

class FailOnceStateStore extends InMemorySocialStateStore {
  failNextSave = false;

  override async save(state: Parameters<InMemorySocialStateStore["save"]>[0]): Promise<void> {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error("simulated Postgres write failure");
    }
    await super.save(state);
  }
}

class BlockingSnapshotStateStore extends InMemorySocialStateStore {
  saveCalls = 0;
  private blockNext = false;
  private readonly blocked = deferred<void>();
  private readonly release = deferred<void>();

  blockNextSave(): Promise<void> {
    this.blockNext = true;
    return this.blocked.promise;
  }

  releaseBlockedSave(): void {
    this.release.resolve();
  }

  override async save(state: Parameters<InMemorySocialStateStore["save"]>[0]): Promise<void> {
    this.saveCalls += 1;
    // Model the database boundary: the SQL parameter is captured before a
    // slow write, so an overlapping stale snapshot could otherwise win last.
    const snapshot = structuredClone(state);
    if (this.blockNext) {
      this.blockNext = false;
      this.blocked.resolve();
      await this.release.promise;
    }
    await super.save(snapshot);
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T | PromiseLike<T>): void; reject(reason?: unknown): void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject; });
  return { promise, resolve, reject };
}

test("MCP writes and worker-shaped mutations serialize one Social owner snapshot", async () => {
  const store = new BlockingSnapshotStateStore();
  const context = await service(store);
  const blocked = store.blockNextSave();
  const first = context.initialize("run-1", section, mutation("initialize-run-1"));
  await blocked;

  const second = context.initialize("run-2", section, mutation("initialize-run-2"));
  assert.equal(store.saveCalls, 1, "the second mutation must wait for the first durable write");

  store.releaseBlockedSave();
  await Promise.all([first, second]);
  assert.deepEqual(Object.keys((await store.load())!.runs).sort(), ["run-1", "run-2"]);
});

test("a failed Postgres write does not leave a process-local Social mutation", async () => {
  const store = new FailOnceStateStore();
  const { context, checkpoint } = await initialized(store);
  const apply = mutation("apply-1", checkpoint.ref);
  store.failNextSave = true;
  await assert.rejects(
    () => context.apply("run-1", 1, [
      { kind: "post", actionId: "post-action", actorId: "alice", postId: "post-1", content: "pending" },
    ], apply),
    /simulated Postgres write failure/,
  );
  const result = await context.apply("run-1", 1, [
    { kind: "post", actionId: "post-action", actorId: "alice", postId: "post-1", content: "pending" },
  ], apply);
  assert.deepEqual(result.map((post) => post.postId), ["post-1"]);
});

test("fork starts from committed source state without copying later source facts", async () => {
  const { context, checkpoint } = await initialized();
  await context.apply("run-1", 1, [
    { kind: "post", actionId: "source-post", actorId: "alice", postId: "source-post", content: "source" },
  ], mutation("apply-1", checkpoint.ref));
  const committedOne = await context.seal("run-1", 1, mutation("seal-1", checkpoint.ref));
  await context.publish("run-1", 1, committedOne.ref, mutation("publish-1", checkpoint.ref));

  const forkCheckpoint = await context.fork(
    "run-1",
    "run-2",
    committedOne.ref,
    mutation("fork", committedOne.ref),
  );
  assert.equal(forkCheckpoint.runId, "run-2");
  assert.deepEqual(context.exportFacts("run-2", 1, forkCheckpoint.ref).posts.map((post) => post.postId), ["source-post"]);

  await context.apply("run-1", 2, [
    { kind: "post", actionId: "later-post", actorId: "alice", postId: "later-post", content: "later" },
  ], mutation("apply-2", committedOne.ref));
  assert.deepEqual(context.exportFacts("run-2", 1, forkCheckpoint.ref).posts.map((post) => post.postId), ["source-post"]);
});

class MemoryProjection implements SocialProjection {
  readonly graphs: CommittedSocialGraph[] = [];

  async replaceCommitted(graph: CommittedSocialGraph): Promise<void> {
    this.graphs.push(structuredClone(graph));
  }
}

test("Neo4j projection only receives committed facts and rebuilds after restart", async () => {
  const store = new InMemorySocialStateStore();
  const projection = new MemoryProjection();
  const { context, checkpoint } = await initialized(store, projection);
  await context.apply("run-1", 1, [
    { kind: "post", actionId: "post-action", actorId: "alice", postId: "post-1", content: "pending" },
  ], mutation("apply-1", checkpoint.ref));
  assert.equal(projection.graphs.length, 0);

  const sealed = await context.seal("run-1", 1, mutation("seal-1", checkpoint.ref));
  await context.publish("run-1", 1, sealed.ref, mutation("publish-1", checkpoint.ref));
  assert.deepEqual(projection.graphs.at(-1)?.posts.map((post) => post.postId), ["post-1"]);

  const rebuilt = new MemoryProjection();
  await service(store, rebuilt);
  assert.deepEqual(rebuilt.graphs.at(-1), projection.graphs.at(-1));
});
