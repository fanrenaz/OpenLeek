import assert from "node:assert/strict";
import test from "node:test";
import { SocialEnvironmentService } from "../src/application/social-environment-service.js";
import { InMemorySocialStateStore } from "../src/infrastructure/memory-state-store.js";
import { createSocialEnvironmentServiceRouter } from "../src/server/router.js";

const digest = (_value: string): string => "a".repeat(64);

function mutation(stepId: string, expectedCheckpointRef = "") {
  return {
    transitionId: "transition-1",
    stepId,
    payloadDigest: digest(stepId),
    expectedCheckpointRef,
  };
}

test("router maps tRPC social commands and hides sealed facts", async () => {
  const service = await SocialEnvironmentService.create({ stateStore: new InMemorySocialStateStore() });
  const caller = createSocialEnvironmentServiceRouter(service).createCaller({});
  const initialized = await caller.socialEnvironment.initialize({
    runId: "run-1",
    mutation: mutation("initialize"),
    section: {
      exposurePolicy: "recommendation_only",
      actors: [
        { actorId: "alice", displayName: "Alice", maximumActionsPerRound: 5 },
        { actorId: "bob", displayName: "Bob", maximumActionsPerRound: 5 },
      ],
    },
  });

  await caller.socialEnvironment.applyStep({
    runId: "run-1",
    roundId: 1,
    mutation: mutation("apply-1", initialized.checkpoint.ref),
    baseline: initialized.checkpoint,
    actions: [{
      kind: "social.post",
      actionId: "post-action",
      actorId: "alice",
      postId: "post-1",
      headline: "Opening",
      body: "Market update",
    }],
  });
  const sealed = await caller.socialEnvironment.seal({
    runId: "run-1",
    roundId: 1,
    mutation: mutation("seal-1", initialized.checkpoint.ref),
    baseline: initialized.checkpoint,
  });
  await assert.rejects(
    () => caller.socialEnvironment.exportFacts({ runId: "run-1", roundId: 1, committedCheckpointRef: sealed.checkpoint.ref }),
    /pending or sealed Social facts are not queryable/,
  );

  const published = await caller.socialEnvironment.publish({
    runId: "run-1",
    roundId: 1,
    mutation: mutation("publish-1", initialized.checkpoint.ref),
    checkpoint: sealed.checkpoint,
  });
  const facts = await caller.socialEnvironment.exportFacts({
    runId: "run-1",
    roundId: 1,
    committedCheckpointRef: published.ref,
  });
  assert.deepEqual(facts.posts.map((post) => post.postId), ["post-1"]);

  const observed = await caller.socialEnvironment.observe({
    runId: "run-1",
    roundId: 2,
    mutation: mutation("observe-2", published.ref),
    baseline: published,
    actorIds: ["bob"],
  });
  assert.deepEqual(observed, {
    agents: [{
      agentId: "bob",
      followerCount: 0,
      feed: [{
        postId: "post-1",
        actorId: "alice",
        headline: "Opening",
        body: "Market update",
      }],
    }],
  });
  const committedFacts = await caller.socialEnvironment.queryCommittedFacts({
    runId: "run-1",
    roundId: 1,
    committedCheckpointRef: published.ref,
  });
  assert.equal(committedFacts.summary.postCount, 1);
});

test("router accepts static MCP bindings for the initial revision", async () => {
  const service = await SocialEnvironmentService.create({ stateStore: new InMemorySocialStateStore() });
  const caller = createSocialEnvironmentServiceRouter(service).createCaller({});
  const initialized = await caller.socialEnvironment.revisionInitialize({
    runId: "run-bindings",
    mutation: mutation("revision-initialize"),
    section: {
      exposurePolicy: "public_browse",
      actors: [{ actorId: "alice", displayName: "Alice", maximumActionsPerRound: 5 }],
      feedSize: 100,
    },
  });
  const socialRevision = { ...initialized.revision, context: "social_environment" as const };

  const result = await caller.socialEnvironment.mcpBindings({
    runId: "run-bindings",
    roundId: 0,
    revision: socialRevision,
    agents: [{
      agentId: "agent-alice",
      principalId: "principal:run-bindings:agent-alice",
      actorId: "alice",
      permissions: {
        tools: ["social.create_post", "social.follow", "social.unfollow", "social.engage"],
        resources: ["social.feed", "social.profile", "social.posts"],
      },
    }],
  });

  assert.deepEqual(result.bindings, [{
    context: "social",
    agentId: "agent-alice",
    endpoint: "http://127.0.0.1:3106/internal/mcp",
  }]);

  const facts = await caller.socialEnvironment.queryCommittedRevisionFacts({
    runId: "run-bindings",
    revisionRef: socialRevision.ref,
  });
  assert.equal(facts.summary.roundId, 0);
  assert.equal(facts.summary.postCount, 0);

  const read = await caller.socialEnvironment.freezeFullSnapshot({
    runId: "run-bindings",
    roundId: 1,
    baseline: socialRevision,
    mutation: mutation("freeze-settlement", socialRevision.ref),
  });
  assert.deepEqual(await caller.socialEnvironment.settlementStatus({
    runId: "run-bindings",
    roundId: 1,
    finalFailedTurnIds: [],
  }), {
    settled: true,
    pendingIntentCount: 0,
    pendingOutboxCount: 0,
  });
  assert.equal(read.revision.ref !== socialRevision.ref, true);
});
