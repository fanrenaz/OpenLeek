import assert from "node:assert/strict";
import test from "node:test";
import { type SocialMcpPermissions } from "@openleek/contracts/agent";
import { createExperimentCredentialSigner, generateExperimentCredentialKeyPair } from "@openleek/experiment-credentials";
import { verifySocialMcpBearer } from "../src/server/social-mcp-bearer.js";
import { SocialContextWorker, type SocialCommandStream, type SocialCommandStreamMessage } from "../src/application/social-context-worker.js";
import { SocialMcpService } from "../src/application/social-mcp-service.js";
import { SocialEnvironmentService } from "../src/application/social-environment-service.js";
import { InMemorySocialStateStore } from "../src/infrastructure/memory-state-store.js";
import { projectSocialScope } from "../src/server/runtime-v2.js";

const digest = (value: string) => value.padEnd(64, "a").slice(0, 64);
const mutation = (stepId: string, expectedCheckpointRef = "") => ({
  transitionId: `revision-transition:${stepId}`,
  stepId,
  payloadDigest: digest(stepId),
  expectedCheckpointRef,
});
const principal = { principalId: "principal:run-1:agent-alice", runId: "run-1", agentId: "agent-alice" };
const fullPermissions: SocialMcpPermissions = {
  tools: [
    "social.get_feed",
    "social.get_post",
    "social.list_posts",
    "social.search_posts",
    "social.get_profile",
    "social.list_relationships",
    "social.list_engagements",
    "social.get_notifications",
    "social.get_command_status",
    "social.create_post",
    "social.like_post",
    "social.repost_post",
    "social.reply_to_post",
    "social.follow",
    "social.unfollow",
    "social.engage",
  ],
  resources: ["social.feed", "social.profile", "social.posts"],
};

test("Runtime v2 scope projection hides Social owner fields", () => {
  const ownerScope = { scopeId: "scope:1", runId: "run:1", roundId: 1, agentId: "agent:1", principalId: "principal:1", turnId: "turn:1", attemptId: "attempt:1", expiresAt: "2026-08-05T00:00:00.000Z", actorId: "actor:1", readRevisionRef: "revision:1" };
  const projected = projectSocialScope(ownerScope);
  assert.equal(Object.hasOwn(projected, "actorId"), false);
  assert.equal(Object.hasOwn(projected, "readRevisionRef"), false);
});

test("Social verifies Experiment JWS bearer credentials for its audience", () => {
  const keys = generateExperimentCredentialKeyPair();
  const signer = createExperimentCredentialSigner({ kid: "experiment-key", privateKey: keys.privateKeyPem });
  const bearer = signer.issue({ ...principal, audience: "social", credentialVersion: 1 });
  const verified = verifySocialMcpBearer(bearer, {
    OPENLEEK_EXPERIMENT_CREDENTIAL_KID: "experiment-key",
    OPENLEEK_EXPERIMENT_CREDENTIAL_PUBLIC_KEY: keys.publicKeyPem.replace(/\n/g, "\\n"),
  });
  assert.deepEqual({ ...verified, issuedAt: 0 }, { ...principal, audience: "social", credentialVersion: 1, issuedAt: 0 });
  assert.ok(verified.issuedAt > 0);
  const wrongAudience = signer.issue({ ...principal, audience: "financial", credentialVersion: 1 });
  assert.throws(() => verifySocialMcpBearer(wrongAudience, {
    OPENLEEK_EXPERIMENT_CREDENTIAL_KID: "experiment-key",
    OPENLEEK_EXPERIMENT_CREDENTIAL_PUBLIC_KEY: keys.publicKeyPem,
  }));
});

test("Social registers static principal bindings against the initial revision", async () => {
  const { service, initial } = await initialized();
  const bindings = await service.provisionMcpBindings({
    runId: "run-1",
    roundId: 0,
    revision: initial,
    agents: [{ agentId: "agent-alice", principalId: principal.principalId, actorId: "alice", permissions: fullPermissions }],
  });
  assert.deepEqual(bindings, [{ context: "social", agentId: "agent-alice", endpoint: "http://127.0.0.1:3106/internal/mcp" }]);
});

test("Social rotates one principal scope atomically and an old close cannot remove the new turn", async () => {
  const { service, initial } = await initialized();
  const read = await service.freezeFullSnapshot({
    runId: "run-1",
    roundId: 1,
    baseline: initial,
    mutation: mutation("freeze-scope-rotation", initial.ref),
  });
  await service.provisionMcpBindings({
    runId: "run-1",
    roundId: 1,
    revision: read,
    agents: [{ agentId: "agent-alice", principalId: principal.principalId, actorId: "alice", permissions: fullPermissions }],
  });
  const first = await service.openMcpScope({
    runId: "run-1",
    roundId: 1,
    agentId: "agent-alice",
    principalId: principal.principalId,
    revision: read,
    turnId: "turn-1",
    attemptId: "attempt-1",
  });
  const second = await service.openMcpScope({
    runId: "run-1",
    roundId: 1,
    agentId: "agent-alice",
    principalId: principal.principalId,
    revision: read,
    turnId: "turn-2",
    attemptId: "attempt-2",
  });
  assert.notEqual(second.scopeId, first.scopeId);
  assert.equal(service.mcpScope(principal).scopeId, second.scopeId);

  await service.closeMcpScope({ runId: "run-1", scopeId: first.scopeId });
  assert.equal(service.mcpScope(principal).scopeId, second.scopeId);
  await service.closeMcpScope({ runId: "run-1", scopeId: second.scopeId });
  assert.throws(() => service.mcpScope(principal), /scope is not active/i);
});

async function initialized(maximumActionsPerRound = 100) {
  const stateStore = new InMemorySocialStateStore();
  const service = await SocialEnvironmentService.create({
    stateStore,
    mcpEndpoint: "http://127.0.0.1:3106/internal/mcp",
  });
  const initial = await service.initializeRevision("run-1", {
    exposurePolicy: "public_browse",
    actors: [
      { actorId: "alice", displayName: "Alice", maximumActionsPerRound },
      { actorId: "bob", displayName: "Bob", maximumActionsPerRound },
      { actorId: "charlie", displayName: "Charlie", maximumActionsPerRound },
    ],
    feedSize: 100,
  }, mutation("initialize"));
  return { service, initial, stateStore };
}

test("Social MCP enforces each actor's round limit after idempotency", async () => {
  const { service, initial } = await initialized(2);
  const read = await service.freezeFullSnapshot({
    runId: "run-1",
    roundId: 1,
    baseline: initial,
    mutation: mutation("freeze-limit", initial.ref),
  });
  const mcp = new SocialMcpService(service);
  await mcp.provisionBindings({
    runId: "run-1",
    roundId: 1,
    revision: read,
    agents: [{ agentId: "agent-alice", principalId: principal.principalId, actorId: "alice", permissions: fullPermissions }],
  });
  await mcp.openScope({
    runId: "run-1",
    roundId: 1,
    agentId: "agent-alice",
    principalId: principal.principalId,
    revision: read,
    turnId: "turn-limit",
  });
  const first = await mcp.invoke(principal, "create_post", { headline: "One", body: "Accepted" }, "request-1") as { commandId: string };
  const retry = await mcp.invoke(principal, "create_post", { headline: "One", body: "Accepted" }, "request-1") as { commandId: string; duplicate: boolean };
  assert.equal(retry.commandId, first.commandId);
  assert.equal(retry.duplicate, true);
  const repeatedContent = await mcp.invoke(principal, "create_post", { headline: "One", body: "Accepted" }, "request-2") as { commandId: string };
  assert.notEqual(repeatedContent.commandId, first.commandId);
  await assert.rejects(
    () => mcp.invoke(principal, "create_post", { headline: "Two", body: "Rejected" }, "request-3"),
    /maximum actions per round/i,
  );
});

class RecordingStream implements SocialCommandStream {
  readonly published: Array<{ streamKey: string; runId: string; roundId: number; commandId: string }> = [];
  readonly acknowledgements: SocialCommandStreamMessage[] = [];

  async publish(message: { streamKey: string; runId: string; roundId: number; commandId: string }): Promise<string> {
    this.published.push(message);
    return `${this.published.length}-0`;
  }

  async acknowledge(message: SocialCommandStreamMessage): Promise<void> {
    this.acknowledgements.push(message);
  }
}

test("one frozen full revision feeds MCP Resources while Social writes remain provisional", async () => {
  const { service, initial } = await initialized();
  const read = await service.freezeFullSnapshot({
    runId: "run-1",
    roundId: 1,
    baseline: initial,
    mutation: mutation("freeze", initial.ref),
  });
  const mcp = new SocialMcpService(service);
  const [binding] = await mcp.provisionBindings({
    runId: "run-1",
    roundId: 1,
    revision: read,
    agents: [{ agentId: "agent-alice", principalId: principal.principalId, actorId: "alice", permissions: fullPermissions }],
  });
  assert.ok(binding);
  assert.equal(binding!.context, "social");
  assert.equal(binding!.endpoint, "http://127.0.0.1:3106/internal/mcp");
  assert.equal("capabilityToken" in binding!, false);
  await mcp.openScope({
    runId: "run-1",
    roundId: 1,
    agentId: "agent-alice",
    principalId: principal.principalId,
    revision: read,
    turnId: "turn-1",
  });

  const roots = mcp.listResources(principal).resources;
  const publicPosts = roots.find((resource) => resource.name === "public social posts");
  assert.ok(publicPosts, "public_browse exposes a collection Resource");
  const before = JSON.parse(mcp.readResource(principal, publicPosts!.uri).contents[0]!.text) as { revision: string; items: unknown[] };
  assert.equal(before.revision, read.ref);
  assert.deepEqual(before.items, []);

  const accepted = await mcp.invoke(principal, "create_post", { headline: "Frozen", body: "Write behind the read revision" }) as { accepted: boolean; duplicate: boolean; commandId: string };
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.duplicate, false);
  assert.match(accepted.commandId, /^social-command:/);
  assert.deepEqual(await service.settlementStatus({ runId: "run-1", roundId: 1, finalFailedTurnIds: [] }), {
    settled: false,
    pendingIntentCount: 1,
    pendingOutboxCount: 1,
  });
  // The action has a durable intent/outbox, but every Resource remains pinned.
  const after = JSON.parse(mcp.readResource(principal, publicPosts!.uri).contents[0]!.text) as { revision: string; items: unknown[] };
  assert.equal(after.revision, read.ref);
  assert.deepEqual(after.items, []);

  const stream = new RecordingStream();
  const worker = new SocialContextWorker(service, stream);
  assert.equal(await worker.publishPending("run-1", 1), 1);
  const [published] = stream.published;
  assert.ok(published);
  await worker.consume({ streamId: "1-0", runId: "run-1", roundId: 1, commandId: published!.commandId });
  assert.equal(stream.acknowledgements.length, 1);
  assert.deepEqual(await service.settlementStatus({ runId: "run-1", roundId: 1, finalFailedTurnIds: [] }), {
    settled: true,
    pendingIntentCount: 0,
    pendingOutboxCount: 0,
  });
  const candidate = await worker.seal({
    runId: "run-1",
    roundId: 1,
    baseRevision: initial,
    readRevision: read,
    finalFailedTurnIds: [],
    mutation: mutation("seal-candidate", initial.ref),
  });
  assert.equal(service.revisionSnapshot("run-1", candidate.ref).posts[Object.keys(service.revisionSnapshot("run-1", candidate.ref).posts)[0]!]!.headline, "Frozen");
  await assert.rejects(
    () => service.publicObserverSnapshot("run-1", candidate.ref),
    /committed/i,
  );
  await service.commitCandidateRevision({
    runId: "run-1",
    roundId: 1,
    candidateRevision: candidate,
    mutation: mutation("commit-observer", initial.ref),
  });
  const observer = await service.publicObserverSnapshot("run-1", candidate.ref);
  assert.equal(observer.revision.ref, candidate.ref);
  assert.equal(observer.posts.length, 1);
  assert.equal(observer.posts[0]!.headline, "Frozen");
  assert.deepEqual(observer.delta.newPostIds, [observer.posts[0]!.postId]);
  assert.doesNotMatch(JSON.stringify(observer), /"exposures?"|"notifications?"/i);
});

test("failed turns are discarded by replaying from the base revision before candidate seal", async () => {
  const { service, initial } = await initialized();
  const read = await service.freezeFullSnapshot({
    runId: "run-1",
    roundId: 1,
    baseline: initial,
    mutation: mutation("freeze-failed", initial.ref),
  });
  const mcp = new SocialMcpService(service);
  const [binding] = await mcp.provisionBindings({
    runId: "run-1",
    roundId: 1,
    revision: read,
    agents: [{ agentId: "agent-alice", principalId: principal.principalId, actorId: "alice", permissions: fullPermissions }],
  });
  await mcp.openScope({ runId: "run-1", roundId: 1, agentId: "agent-alice", principalId: principal.principalId, revision: read, turnId: "failed-turn" });
  await mcp.invoke(principal, "create_post", { headline: "Drop", body: "provider never completed" });
  assert.deepEqual(await service.settlementStatus({ runId: "run-1", roundId: 1, finalFailedTurnIds: ["failed-turn"] }), {
    settled: true,
    pendingIntentCount: 0,
    pendingOutboxCount: 0,
  });

  const stream = new RecordingStream();
  const worker = new SocialContextWorker(service, stream);
  await worker.publishPending("run-1", 1);
  await worker.consume({ streamId: "1-0", runId: "run-1", roundId: 1, commandId: stream.published[0]!.commandId });
  const candidate = await worker.seal({
    runId: "run-1",
    roundId: 1,
    baseRevision: initial,
    readRevision: read,
    finalFailedTurnIds: ["failed-turn"],
    mutation: mutation("seal-failed", initial.ref),
  });
  assert.deepEqual(Object.keys(service.revisionSnapshot("run-1", candidate.ref).posts), []);
});

test("run access revocation invalidates registered principals and active scopes", async () => {
  const { service, initial } = await initialized();
  const read = await service.freezeFullSnapshot({ runId: "run-1", roundId: 1, baseline: initial, mutation: mutation("freeze-revoke", initial.ref) });
  const mcp = new SocialMcpService(service);
  await mcp.provisionBindings({
    runId: "run-1",
    roundId: 1,
    revision: read,
    agents: [{ agentId: "agent-alice", principalId: principal.principalId, actorId: "alice", permissions: fullPermissions }],
  });
  await mcp.openScope({ runId: "run-1", roundId: 1, agentId: "agent-alice", principalId: principal.principalId, revision: read, turnId: "turn-revoke" });
  assert.equal(mcp.listResources(principal).resources.length > 0, true);
  await mcp.revokeRunAccess("run-1");
  assert.throws(() => mcp.listResources(principal), /access has been revoked/);
  await assert.rejects(
    () => mcp.openScope({ runId: "run-1", roundId: 1, agentId: "agent-alice", principalId: principal.principalId, revision: read, turnId: "turn-after-revoke" }),
    /access has been revoked/,
  );
});

test("Social Resources paginate frozen revision content through next URIs", async () => {
  const { service } = await initialized();
  const checkpoint = service.sealedCheckpoint("run-1", 0);
  await service.apply("run-1", 1, Array.from({ length: 26 }, (_, index) => ({
    kind: "post" as const,
    actionId: `seed-${index}`,
    actorId: "bob",
    postId: `seed-post-${String(index).padStart(2, "0")}`,
    content: `seed ${index}`,
  })), mutation("seed-posts", checkpoint.ref));
  const sealed = await service.seal("run-1", 1, mutation("seed-seal", checkpoint.ref));
  await service.publish("run-1", 1, sealed.ref, mutation("seed-publish", checkpoint.ref));
  const base = service.currentRevision("run-1");
  const read = await service.freezeFullSnapshot({ runId: "run-1", roundId: 2, baseline: base, mutation: mutation("seed-freeze", base.ref) });
  const mcp = new SocialMcpService(service);
  const [binding] = await mcp.provisionBindings({
    runId: "run-1",
    roundId: 2,
    revision: read,
    agents: [{ agentId: "agent-alice", principalId: principal.principalId, actorId: "alice", permissions: fullPermissions }],
  });
  await mcp.openScope({ runId: "run-1", roundId: 2, agentId: "agent-alice", principalId: principal.principalId, revision: read, turnId: "turn-page" });
  const posts = mcp.listResources(principal).resources.find((item) => item.name === "public social posts");
  assert.ok(posts);
  const first = JSON.parse(mcp.readResource(principal, posts!.uri).contents[0]!.text) as {
    revision: string;
    items: Array<{ headline?: string }>;
    nextUri?: string;
  };
  assert.equal(first.revision, read.ref);
  assert.equal(first.items.length, 25);
  assert.equal(first.items[0]?.headline, undefined, "an empty headline does not duplicate the post body");
  assert.ok(first.nextUri);
  const second = JSON.parse(mcp.readResource(principal, first.nextUri!).contents[0]!.text) as { revision: string; items: unknown[]; nextUri?: string };
  assert.equal(second.revision, read.ref);
  assert.equal(second.items.length, 1);
  assert.equal(second.nextUri, undefined);

  const feed = await mcp.invoke(principal, "get_feed", {}) as {
    items: Array<{ bodyExcerpt: string; bodyTruncated: boolean; body?: string }>;
    nextCursor?: string;
  };
  assert.equal(feed.items.length, 5);
  assert.equal(feed.nextCursor, "5");
  assert.equal(feed.items.every((item) => item.body === undefined && item.bodyTruncated === false), true);
  await assert.rejects(() => mcp.invoke(principal, "get_feed", { limit: 21 }), /limit/);
});

test("Social MCP Policies filter discovery and enforce direct tool and Resource access", async () => {
  const { service, initial } = await initialized();
  const read = await service.freezeFullSnapshot({
    runId: "run-1",
    roundId: 1,
    baseline: initial,
    mutation: mutation("freeze-policy", initial.ref),
  });
  const mcp = new SocialMcpService(service);
  await mcp.provisionBindings({
    runId: "run-1",
    roundId: 1,
    revision: read,
    agents: [{
      agentId: "agent-alice",
      principalId: principal.principalId,
      actorId: "alice",
      permissions: {
        tools: ["social.engage"],
        resources: ["social.feed"],
      },
    }],
  });
  await mcp.openScope({
    runId: "run-1",
    roundId: 1,
    agentId: "agent-alice",
    principalId: principal.principalId,
    revision: read,
    turnId: "turn-policy",
  });

  assert.deepEqual(mcp.listTools(principal), ["engage"]);
  assert.deepEqual(mcp.listResources(principal).resources.map((item) => item.name), ["recommended social feed"]);
  await assert.rejects(
    () => mcp.invoke(principal, "create_post", { headline: "Denied", body: "Denied" }),
    /social\.create_post/,
  );
  assert.throws(
    () => mcp.readResource(principal, `social://resource/profile?revision=${encodeURIComponent(read.ref)}&actorId=alice`),
    /social\.profile/,
  );
  assert.throws(
    () => mcp.readResource(principal, `social://resource/post?revision=${encodeURIComponent(read.ref)}&postId=unreachable`),
    /social\.posts/,
  );

  const accepted = await mcp.invoke(principal, "engage", { postId: "post-1", engagement: "like" }) as { accepted: boolean };
  assert.equal(accepted.accepted, true);
});

test("Social query tools expose visible facts and split writes create first-class reposts and replies", async () => {
  const { service } = await initialized();
  const checkpoint = service.sealedCheckpoint("run-1", 0);
  const rawBody = `A public market update\n${"unabridged social evidence ".repeat(80)}END-OF-RAW-POST`;
  await service.apply("run-1", 1, [
    { kind: "post", actionId: "seed-post", actorId: "bob", postId: "post-market", headline: "Market", content: rawBody },
    { kind: "engagement", actionId: "seed-like", actorId: "alice", targetPostId: "post-market", engagementKind: "like" },
    { kind: "relationship", actionId: "seed-follow", actorId: "alice", targetActorId: "bob", relationshipKind: "follow" },
    { kind: "relationship", actionId: "seed-follow-no-post", actorId: "alice", targetActorId: "charlie", relationshipKind: "follow" },
  ], mutation("query-seed", checkpoint.ref));
  const sealed = await service.seal("run-1", 1, mutation("query-seal", checkpoint.ref));
  await service.publish("run-1", 1, sealed.ref, mutation("query-publish", checkpoint.ref));

  const base = service.currentRevision("run-1");
  const read = await service.freezeFullSnapshot({
    runId: "run-1",
    roundId: 2,
    baseline: base,
    mutation: mutation("query-freeze", base.ref),
  });
  const mcp = new SocialMcpService(service);
  await mcp.provisionBindings({
    runId: "run-1",
    roundId: 2,
    revision: read,
    agents: [{ agentId: "agent-alice", principalId: principal.principalId, actorId: "alice", permissions: fullPermissions }],
  });
  await mcp.openScope({
    runId: "run-1",
    roundId: 2,
    agentId: "agent-alice",
    principalId: principal.principalId,
    revision: read,
    turnId: "turn-social-tools",
  });

  const feed = await mcp.invoke(principal, "get_feed", { limit: 10 }) as {
    items: Array<{ postId: string; bodyExcerpt: string; bodyTruncated: boolean; body?: string }>;
  };
  assert.deepEqual(feed.items.map((item) => item.postId), ["post-market"]);
  assert.equal(feed.items[0]?.bodyExcerpt, rawBody.slice(0, 1_000));
  assert.equal(feed.items[0]?.bodyTruncated, true);
  assert.equal(feed.items[0]?.body, undefined);
  const post = await mcp.invoke(principal, "get_post", { postId: "post-market" }) as {
    post: { body: string; postType: string; engagement: { likeCount: number; viewerHasLiked: boolean } };
  };
  assert.equal(post.post.body, rawBody);
  assert.equal(post.post.postType, "original");
  assert.deepEqual(post.post.engagement, {
    likeCount: 1,
    repostCount: 0,
    replyCount: 0,
    viewerHasLiked: true,
    viewerHasReposted: false,
  });
  const listed = await mcp.invoke(principal, "list_posts", {}) as { items: Array<{ postId: string; body: string }> };
  assert.equal(listed.items[0]?.body, rawBody);
  const search = await mcp.invoke(principal, "search_posts", { query: "END-OF-RAW-POST" }) as { items: Array<{ postId: string; body: string }> };
  assert.deepEqual(search.items.map((item) => item.postId), ["post-market"]);
  assert.equal(search.items[0]?.body, rawBody);
  const profile = await mcp.invoke(principal, "get_profile", { actorId: "bob" }) as {
    actor: { actorId: string; followerCount: number; followingCount: number; viewerFollows: boolean };
  };
  assert.deepEqual(profile.actor, {
    actorId: "bob",
    displayName: "Bob",
    viewerFollows: true,
    followerCount: 1,
    followingCount: 0,
  });
  const profileWithoutPost = await mcp.invoke(principal, "get_profile", { actorId: "charlie" }) as {
    actor: { actorId: string; followerCount: number; followingCount: number; viewerFollows: boolean };
  };
  assert.deepEqual(profileWithoutPost.actor, {
    actorId: "charlie",
    displayName: "Charlie",
    viewerFollows: true,
    followerCount: 1,
    followingCount: 0,
  });
  const relationships = await mcp.invoke(principal, "list_relationships", { direction: "following" }) as {
    items: Array<{ actorId: string }>;
  };
  assert.deepEqual(relationships.items.map((item) => item.actorId), ["bob", "charlie"]);
  const engagements = await mcp.invoke(principal, "list_engagements", { postId: "post-market" }) as {
    items: Array<{ kind: string; actorId: string }>;
  };
  assert.deepEqual(engagements.items.map(({ kind, actorId }) => ({ kind, actorId })), [{ kind: "like", actorId: "alice" }]);

  const like = await mcp.invoke(principal, "like_post", { postId: "post-market" }, "like-request") as { commandId: string; status: string };
  const repost = await mcp.invoke(principal, "repost_post", {
    postId: "post-market",
    body: "Sharing this update",
  }, "repost-request") as { commandId: string };
  const reply = await mcp.invoke(principal, "reply_to_post", {
    postId: "post-market",
    body: "What changed?",
  }, "reply-request") as { commandId: string };
  const compatibleReply = await mcp.invoke(principal, "engage", {
    postId: "post-market",
    engagement: "reply",
    replyBody: "Legacy-compatible reply",
  }, "compatible-reply-request") as { commandId: string };
  assert.equal(like.status, "pending");

  const stream = new RecordingStream();
  const worker = new SocialContextWorker(service, stream);
  assert.equal(await worker.publishPending("run-1", 2), 4);
  for (const [index, command] of stream.published.entries()) {
    await worker.consume({ streamId: `${index + 1}-0`, runId: "run-1", roundId: 2, commandId: command.commandId });
  }
  assert.equal(mcp.listTools(principal).includes("get_command_status"), false);

  const candidate = await worker.seal({
    runId: "run-1",
    roundId: 2,
    baseRevision: base,
    readRevision: read,
    finalFailedTurnIds: [],
    mutation: mutation("query-candidate", base.ref),
  });
  const snapshot = service.revisionSnapshot("run-1", candidate.ref);
  assert.deepEqual(snapshot.exposures, service.revisionSnapshot("run-1", read.ref).exposures);
  const generatedPosts = Object.values(snapshot.posts).filter((post) => post.roundId === 2);
  assert.equal(generatedPosts.some((post) => post.postId.startsWith("repost:") && post.content === "Sharing this update"), true);
  assert.equal(generatedPosts.some((post) => post.postId.startsWith("reply:") && post.content === "What changed?"), true);
  const targetEngagements = Object.values(snapshot.engagements).filter((item) => item.targetPostId === "post-market");
  assert.equal(targetEngagements.filter((item) => item.kind === "like").length, 1);
  assert.equal(targetEngagements.filter((item) => item.kind === "repost").length, 1);
  assert.equal(targetEngagements.filter((item) => item.kind === "reply").length, 2);
  assert.equal(
    Object.values(snapshot.posts).some((item) =>
      item.postType === "reply"
      && item.parentPostId === "post-market"
      && item.content === "Legacy-compatible reply"),
    true,
  );
  assert.deepEqual(new Set([like.commandId, repost.commandId, reply.commandId, compatibleReply.commandId]).size, 4);
});

test("get_notifications summarizes and pages only reactions received in the latest committed round", async () => {
  const { service } = await initialized();
  const checkpoint = service.sealedCheckpoint("run-1", 0);
  await service.apply("run-1", 1, [
    { kind: "post", actionId: "alice-post", actorId: "alice", postId: "post-alice", content: "Alice update" },
    { kind: "post", actionId: "bob-post", actorId: "bob", postId: "post-bob", content: "Bob update" },
    { kind: "engagement", actionId: "bob-like", actorId: "bob", targetPostId: "post-alice", engagementKind: "like" },
    {
      kind: "engagement",
      actionId: "bob-repost",
      actorId: "bob",
      targetPostId: "post-alice",
      engagementKind: "repost",
      derivedPostId: "bob-repost-post",
    },
    {
      kind: "engagement",
      actionId: "charlie-reply",
      actorId: "charlie",
      targetPostId: "post-alice",
      engagementKind: "reply",
      replyBody: "Interesting",
      derivedPostId: "charlie-reply-post",
    },
    { kind: "engagement", actionId: "alice-self-like", actorId: "alice", targetPostId: "post-alice", engagementKind: "like" },
    { kind: "engagement", actionId: "charlie-bob-like", actorId: "charlie", targetPostId: "post-bob", engagementKind: "like" },
  ], mutation("notifications-round-1", checkpoint.ref));
  const sealed = await service.seal("run-1", 1, mutation("notifications-seal-1", checkpoint.ref));
  await service.publish("run-1", 1, sealed.ref, mutation("notifications-publish-1", checkpoint.ref));

  const base = service.currentRevision("run-1");
  const read = await service.freezeFullSnapshot({
    runId: "run-1",
    roundId: 2,
    baseline: base,
    mutation: mutation("notifications-freeze-2", base.ref),
  });
  const mcp = new SocialMcpService(service);
  await mcp.provisionBindings({
    runId: "run-1",
    roundId: 2,
    revision: read,
    agents: [{ agentId: "agent-alice", principalId: principal.principalId, actorId: "alice", permissions: fullPermissions }],
  });
  await mcp.openScope({
    runId: "run-1",
    roundId: 2,
    agentId: "agent-alice",
    principalId: principal.principalId,
    revision: read,
    turnId: "turn-notifications",
  });

  const first = await mcp.invoke(principal, "get_notifications", { limit: 2 }) as {
    reactions: { totalCount: number; likeCount: number; repostCount: number; replyCount: number };
    items: Array<{ notificationId: string; kind: string; actorId: string; postId: string; replyBody?: string; derivedPostId?: string }>;
    nextCursor?: string;
  };
  assert.deepEqual(first.reactions, { totalCount: 3, likeCount: 1, repostCount: 1, replyCount: 1 });
  assert.equal(first.items.length, 2);
  assert.equal(first.nextCursor, "2");

  const second = await mcp.invoke(principal, "get_notifications", { limit: 2, cursor: first.nextCursor }) as typeof first;
  assert.deepEqual(second.reactions, first.reactions, "summary covers all matching reactions, not only the current page");
  assert.equal(second.items.length, 1);
  assert.equal(second.nextCursor, undefined);
  const items = [...first.items, ...second.items];
  assert.deepEqual(new Set(items.map((item) => item.kind)), new Set(["like", "repost", "reply"]));
  assert.equal(items.every((item) => item.postId === "post-alice" && item.actorId !== "alice"), true);
  assert.deepEqual(
    items.find((item) => item.kind === "reply"),
    {
      notificationId: "engagement:run-1:charlie-reply",
      kind: "reply",
      actorId: "charlie",
      actorDisplayName: "Charlie",
      postId: "post-alice",
      roundId: 1,
      replyBody: "Interesting",
      derivedPostId: "charlie-reply-post",
    },
  );
});

test("candidate revisions retain frozen exposures when a round has no Social actions", async () => {
  const { service } = await initialized();
  const checkpoint = service.sealedCheckpoint("run-1", 0);
  await service.apply("run-1", 1, [
    { kind: "post", actionId: "seed-exposure-post", actorId: "bob", postId: "post-exposure", content: "Visible next round" },
  ], mutation("exposure-seed", checkpoint.ref));
  const sealed = await service.seal("run-1", 1, mutation("exposure-seal-1", checkpoint.ref));
  await service.publish("run-1", 1, sealed.ref, mutation("exposure-publish-1", checkpoint.ref));

  const base = service.currentRevision("run-1");
  const read = await service.freezeFullSnapshot({
    runId: "run-1",
    roundId: 2,
    baseline: base,
    mutation: mutation("exposure-freeze-2", base.ref),
  });
  const candidate = await service.sealCandidateRevision({
    runId: "run-1",
    roundId: 2,
    baseRevision: base,
    readRevision: read,
    finalFailedTurnIds: [],
    mutation: mutation("exposure-candidate-2", base.ref),
  });

  const readExposures = service.revisionSnapshot("run-1", read.ref).exposures;
  assert.equal(Object.keys(readExposures).length, 3);
  assert.deepEqual(service.revisionSnapshot("run-1", candidate.ref).exposures, readExposures);
});

test("social.posts authorizes both the public directory and individual post Resources", async () => {
  const { service, initial } = await initialized();
  const read = await service.freezeFullSnapshot({
    runId: "run-1",
    roundId: 1,
    baseline: initial,
    mutation: mutation("freeze-post-policy", initial.ref),
  });
  const mcp = new SocialMcpService(service);
  await mcp.provisionBindings({
    runId: "run-1",
    roundId: 1,
    revision: read,
    agents: [{
      agentId: "agent-alice",
      principalId: principal.principalId,
      actorId: "alice",
      permissions: { tools: [], resources: ["social.posts"] },
    }],
  });
  await mcp.openScope({
    runId: "run-1",
    roundId: 1,
    agentId: "agent-alice",
    principalId: principal.principalId,
    revision: read,
    turnId: "turn-post-policy",
  });

  assert.deepEqual(mcp.listTools(principal), []);
  assert.deepEqual(mcp.listResources(principal).resources.map((item) => item.name), ["public social posts"]);
  assert.throws(
    () => mcp.readResource(principal, `social://resource/post?revision=${encodeURIComponent(read.ref)}&postId=missing`),
    /unknown Social post/,
  );
  await assert.rejects(
    () => mcp.invoke(principal, "engage", { postId: "missing", engagement: "like" }),
    /social\.engage/,
  );
});

test("an empty Social MCP Policy exposes no tools or Resources", async () => {
  const { service, initial } = await initialized();
  const read = await service.freezeFullSnapshot({
    runId: "run-1",
    roundId: 1,
    baseline: initial,
    mutation: mutation("freeze-empty-policy", initial.ref),
  });
  const mcp = new SocialMcpService(service);
  await mcp.provisionBindings({
    runId: "run-1",
    roundId: 1,
    revision: read,
    agents: [{
      agentId: "agent-alice",
      principalId: principal.principalId,
      actorId: "alice",
      permissions: { tools: [], resources: [] },
    }],
  });
  await mcp.openScope({
    runId: "run-1",
    roundId: 1,
    agentId: "agent-alice",
    principalId: principal.principalId,
    revision: read,
    turnId: "turn-empty-policy",
  });

  assert.deepEqual(mcp.listTools(principal), []);
  assert.deepEqual(mcp.listResources(principal).resources, []);
  assert.throws(
    () => mcp.readResource(principal, `social://resource/feed?revision=${encodeURIComponent(read.ref)}&actorId=alice`),
    /social\.feed/,
  );
  await assert.rejects(
    () => mcp.invoke(principal, "follow", { followeeId: "bob" }),
    /social\.follow/,
  );
});

test("legacy Social MCP registrations are explicitly migrated to full access", async () => {
  const { service, initial, stateStore } = await initialized();
  await service.provisionMcpBindings({
    runId: "run-1",
    roundId: 0,
    revision: initial,
    agents: [{
      agentId: "agent-alice",
      principalId: principal.principalId,
      actorId: "alice",
      permissions: fullPermissions,
    }],
  });
  const legacy = await stateStore.load();
  assert.ok(legacy);
  const storedPrincipal = legacy.runs["run-1"]!.mcp!.principals[0]!;
  delete storedPrincipal.permissions;
  await stateStore.save(legacy);

  const restored = await SocialEnvironmentService.create({
    stateStore,
    mcpEndpoint: "http://127.0.0.1:3106/internal/mcp",
  });
  const migrated = await stateStore.load();
  assert.equal(migrated?.runs["run-1"]?.mcp?.principals[0]?.legacyFullAccess, true);
  const read = await restored.freezeFullSnapshot({
    runId: "run-1",
    roundId: 1,
    baseline: initial,
    mutation: mutation("freeze-legacy", initial.ref),
  });
  const mcp = new SocialMcpService(restored);
  await mcp.openScope({
    runId: "run-1",
    roundId: 1,
    agentId: "agent-alice",
    principalId: principal.principalId,
    revision: read,
    turnId: "turn-legacy",
  });
  assert.deepEqual(mcp.listTools(principal), [
    "get_feed",
    "get_post",
    "list_posts",
    "search_posts",
    "get_profile",
    "list_relationships",
    "list_engagements",
    "get_notifications",
    "create_post",
    "like_post",
    "repost_post",
    "reply_to_post",
    "follow",
    "unfollow",
    "engage",
  ]);
  assert.deepEqual(
    mcp.listResources(principal).resources.map((item) => item.name),
    ["recommended social feed", "social profile", "public social posts"],
  );
});
