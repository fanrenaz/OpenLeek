import { type SocialMcpPermissions } from "@openleek/contracts/agent";
import { sha256 } from "./canonical";
import { SocialDomainError, invalidArgument } from "./errors";
import type {
  SocialContextRevision,
  SocialMcpAgent,
  SocialMcpBinding,
  SocialMcpCredentialPrincipal,
  SocialMcpResource,
  SocialMcpScope,
  SocialRevisionSnapshot,
} from "./revision-model";
import { SocialEnvironmentService } from "./social-environment-service";
import type { Actor, Engagement, EngagementKind, Relationship, SocialAction, SocialPost } from "../domain/models";

const PAGE_SIZE = 25;
const FEED_PAGE_SIZE = 5;
const FEED_MAX_PAGE_SIZE = 20;
const POST_EXCERPT_LENGTH = 1_000;
type SocialMcpToolId = SocialMcpPermissions["tools"][number];
type SocialMcpResourceId = SocialMcpPermissions["resources"][number];

export interface SocialMcpResourceList {
  resources: readonly SocialMcpResource[];
}

export interface SocialMcpResourceRead {
  contents: readonly [{ uri: string; mimeType: "application/json"; text: string }];
}

/**
 * Social's MCP façade.  The application service owns all durable state; this
 * class is intentionally transport-free so the HTTP route and focused tests
 * exercise exactly the same authorization and snapshot rules.
 */
export class SocialMcpService {
  constructor(private readonly social: SocialEnvironmentService) {}

  provisionBindings(input: {
    runId: string;
    roundId: number;
    revision: SocialContextRevision;
    agents: readonly SocialMcpAgent[];
  }): Promise<readonly SocialMcpBinding[]> {
    return this.social.provisionMcpBindings(input);
  }

  openScope(input: {
    runId: string;
    roundId: number;
    agentId: string;
    principalId: string;
    revision: SocialContextRevision;
    turnId: string;
    attemptId?: string;
    ttlMs?: number;
  }): Promise<SocialMcpScope> {
    return this.social.openMcpScope(input);
  }

  closeScope(input: { runId: string; scopeId: string }): Promise<void> {
    return this.social.closeMcpScope(input);
  }

  revokeRunAccess(runId: string): Promise<void> {
    return this.social.revokeMcpBindings({ runId });
  }

  listTools(principal: SocialMcpCredentialPrincipal): readonly string[] {
    const allowed = new Set(this.social.mcpAccess(principal).permissions.tools);
    return SOCIAL_TOOLS.filter(({ capability }) => allowed.has(capability)).map(({ name }) => name);
  }

  listResources(principal: SocialMcpCredentialPrincipal): SocialMcpResourceList {
    const { scope, permissions } = this.social.mcpAccess(principal);
    const allowed = new Set(permissions.resources);
    const snapshot = this.social.revisionSnapshot(scope.runId, scope.readRevisionRef);
    const resources: SocialMcpResource[] = [];
    if (allowed.has("social.feed")) {
      resources.push({
        uri: resourceUri("feed", scope, { actorId: scope.actorId }),
        name: "recommended social feed",
        description: "Returns the first page of compact post summaries in the authenticated account's social feed.",
        mimeType: "application/json",
      });
    }
    if (allowed.has("social.profile")) {
      resources.push({
        uri: resourceUri("profile", scope, { actorId: scope.actorId }),
        name: "social profile",
        description: "Returns the authenticated account's social profile and relationship counts.",
        mimeType: "application/json",
      });
    }
    if (allowed.has("social.posts") && snapshot.exposurePolicy === "public_browse") {
      resources.push({
        uri: resourceUri("posts", scope),
        name: "public social posts",
        description: "Returns the first page of available social posts.",
        mimeType: "application/json",
      });
    }
    return { resources };
  }

  readResource(principal: SocialMcpCredentialPrincipal, uri: string): SocialMcpResourceRead {
    const { scope, permissions } = this.social.mcpAccess(principal);
    const parsed = parseResourceUri(uri);
    const capability = resourceCapability(parsed.kind);
    if (!permissions.resources.includes(capability)) {
      throw new SocialDomainError("PRECONDITION_FAILED", `Social MCP Resource is not allowed by this principal's policy: ${capability}`);
    }
    if (parsed.revision !== scope.readRevisionRef) {
      throw new SocialDomainError("PRECONDITION_FAILED", "Social Resource does not belong to this MCP scope's frozen revision");
    }
    const snapshot = this.social.revisionSnapshot(scope.runId, scope.readRevisionRef);
    const payload = this.resourcePayload(scope, snapshot, parsed.kind, parsed.actorId, parsed.postId, parsed.cursor);
    return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(payload) }] };
  }

  async invoke(
    principal: SocialMcpCredentialPrincipal,
    tool: string,
    args: Record<string, unknown>,
    invocationId = `legacy:${sha256({ tool, args })}`,
  ): Promise<unknown> {
    const { scope, permissions } = this.social.mcpAccess(principal);
    const capability = toolCapability(tool);
    if (!permissions.tools.includes(capability)) {
      throw new SocialDomainError("PRECONDITION_FAILED", `Social MCP tool is not allowed by this principal's policy: ${capability}`);
    }
    const snapshot = this.social.revisionSnapshot(scope.runId, scope.readRevisionRef);
    if (QUERY_TOOLS.has(tool)) {
      return this.queryPayload(scope, snapshot, tool, args);
    }
    const action = actionFor(scope, tool, args, invocationId);
    const commandId = `social-command:${sha256({
      runId: scope.runId,
      roundId: scope.roundId,
      agentId: scope.agentId,
      turnId: scope.turnId,
      invocationId,
    })}`;
    return this.social.enqueueIntent({ scope, commandId, action });
  }

  private resourcePayload(
    scope: SocialMcpScope,
    snapshot: SocialRevisionSnapshot,
    kind: string,
    actorId: string | undefined,
    postId: string | undefined,
    cursor: string | undefined,
  ): unknown {
    if (kind === "feed") {
      if (actorId !== scope.actorId) throw new SocialDomainError("PRECONDITION_FAILED", "Social feed belongs to a different agent");
      const entries = Object.values(snapshot.exposures)
        .filter((item) => item.actorId === scope.actorId)
        .sort((left, right) => left.rank - right.rank || left.postId.localeCompare(right.postId))
        .map((exposure) => ({
          post: snapshot.posts[exposure.postId],
          rank: exposure.rank,
        }))
        .filter((item): item is { post: SocialPost; rank: number } => item.post !== undefined);
      return page({
        scope,
        kind,
        entries,
        cursor,
        pageSize: FEED_PAGE_SIZE,
        map: ({ post, rank }) => postView(snapshot, scope.actorId, post, { rank, bodyMode: "excerpt" }),
      });
    }
    if (kind === "profile") {
      if (actorId !== scope.actorId) throw new SocialDomainError("PRECONDITION_FAILED", "Social profile belongs to a different agent");
      return { revision: scope.readRevisionRef, actor: profileView(snapshot, scope.actorId, scope.actorId) };
    }
    if (kind === "posts") {
      if (snapshot.exposurePolicy !== "public_browse") {
        throw new SocialDomainError("PRECONDITION_FAILED", "this Social scope only permits recommendation browsing");
      }
      const entries = Object.values(snapshot.posts).sort((left, right) => right.roundId - left.roundId || left.postId.localeCompare(right.postId));
      return page({ scope, kind, entries, cursor, map: (post) => postView(snapshot, scope.actorId, post) });
    }
    if (kind === "post") {
      if (!postId) throw invalidArgument("Social post resource requires postId", "uri.postId");
      const post = snapshot.posts[postId];
      if (post === undefined) throw new SocialDomainError("NOT_FOUND", `unknown Social post: ${postId}`);
      const isRecommended = Object.values(snapshot.exposures).some((item) => item.actorId === scope.actorId && item.postId === postId);
      if (snapshot.exposurePolicy !== "public_browse" && !isRecommended) {
        throw new SocialDomainError("PRECONDITION_FAILED", "post is not reachable from this agent's recommendation feed");
      }
      return { revision: scope.readRevisionRef, post: postView(snapshot, scope.actorId, post) };
    }
    throw new SocialDomainError("NOT_FOUND", `unknown Social Resource kind: ${kind}`);
  }

  private queryPayload(
    scope: SocialMcpScope,
    snapshot: SocialRevisionSnapshot,
    tool: string,
    args: Record<string, unknown>,
  ): unknown {
    const visible = visiblePostIds(snapshot, scope.actorId);
    if (tool === "get_feed") {
      const entries = Object.values(snapshot.exposures)
        .filter((item) => item.actorId === scope.actorId)
        .sort((left, right) => left.rank - right.rank || left.postId.localeCompare(right.postId))
        .flatMap((exposure) => {
          const post = snapshot.posts[exposure.postId];
          return post === undefined ? [] : [{ post, rank: exposure.rank }];
        });
      return queryPage(
        entries,
        args,
        ({ post, rank }) => postView(snapshot, scope.actorId, post, { rank, bodyMode: "excerpt" }),
        { defaultLimit: FEED_PAGE_SIZE, maximumLimit: FEED_MAX_PAGE_SIZE },
      );
    }
    if (tool === "get_post") {
      const postId = requiredText(args.postId, "postId", 240);
      const post = snapshot.posts[postId];
      if (post === undefined || !visible.has(postId)) throw new SocialDomainError("NOT_FOUND", `unknown Social post: ${postId}`);
      return { post: postView(snapshot, scope.actorId, post) };
    }
    if (tool === "list_posts" || tool === "search_posts") {
      const authorId = optionalText(args.authorId, "authorId", 240);
      const query = tool === "search_posts" ? requiredText(args.query, "query", 500).toLocaleLowerCase() : undefined;
      const entries = Object.values(snapshot.posts)
        .filter((post) => visible.has(post.postId))
        .filter((post) => authorId === undefined || post.authorId === authorId)
        .filter((post) => query === undefined || `${post.headline}\n${post.content}`.toLocaleLowerCase().includes(query))
        .sort((left, right) => right.roundId - left.roundId || left.postId.localeCompare(right.postId));
      return queryPage(entries, args, (post) => postView(snapshot, scope.actorId, post));
    }
    if (tool === "get_profile") {
      const actorId = optionalText(args.actorId, "actorId", 240) ?? scope.actorId;
      const isReachable = actorId === scope.actorId
        || Object.values(snapshot.posts).some((post) => post.authorId === actorId && visible.has(post.postId))
        || Object.values(snapshot.relationships).some((relationship) =>
          (relationship.actorId === scope.actorId && relationship.targetActorId === actorId)
          || (relationship.targetActorId === scope.actorId && relationship.actorId === actorId));
      if (!isReachable) throw new SocialDomainError("NOT_FOUND", `unknown Social actor: ${actorId}`);
      return { actor: profileView(snapshot, scope.actorId, actorId) };
    }
    if (tool === "list_relationships") {
      const direction = args.direction;
      if (direction !== "followers" && direction !== "following") {
        throw invalidArgument("direction must be followers or following", "direction");
      }
      const entries = Object.values(snapshot.relationships)
        .filter((relationship) => direction === "followers"
          ? relationship.targetActorId === scope.actorId
          : relationship.actorId === scope.actorId)
        .sort(compareRelationship)
        .map((relationship) => direction === "followers" ? relationship.actorId : relationship.targetActorId)
        .flatMap((actorId) => {
          const actor = snapshot.actors[actorId];
          return actor === undefined ? [] : [actor];
        });
      return queryPage(entries, args, (actor) => actorSummary(snapshot, scope.actorId, actor));
    }
    if (tool === "list_engagements") {
      const postId = requiredText(args.postId, "postId", 240);
      if (!visible.has(postId)) throw new SocialDomainError("NOT_FOUND", `unknown Social post: ${postId}`);
      const kind = args.kind;
      if (kind !== undefined && kind !== "like" && kind !== "repost" && kind !== "reply") {
        throw invalidArgument("kind must be like, repost, or reply", "kind");
      }
      const entries = Object.values(snapshot.engagements)
        .filter((engagement) => engagement.targetPostId === postId && (kind === undefined || engagement.kind === kind))
        .sort((left, right) => right.roundId - left.roundId || left.engagementId.localeCompare(right.engagementId));
      return queryPage(entries, args, (engagement) => engagementView(snapshot, engagement));
    }
    if (tool === "get_notifications") {
      const latestCommittedRound = scope.roundId - 1;
      const entries = Object.values(snapshot.engagements)
        .filter((engagement) => engagement.roundId === latestCommittedRound && engagement.actorId !== scope.actorId)
        .filter((engagement) => snapshot.posts[engagement.targetPostId]?.authorId === scope.actorId)
        .sort((left, right) => left.engagementId.localeCompare(right.engagementId));
      const reactions = {
        totalCount: entries.length,
        likeCount: entries.filter((engagement) => engagement.kind === "like").length,
        repostCount: entries.filter((engagement) => engagement.kind === "repost").length,
        replyCount: entries.filter((engagement) => engagement.kind === "reply").length,
      };
      return {
        reactions,
        ...queryPage(entries, args, (engagement) => notificationView(snapshot, engagement)),
      };
    }
    throw invalidArgument(`unknown Social MCP query tool: ${tool}`, "tool");
  }
}

const SOCIAL_TOOLS = [
  { name: "get_feed", capability: "social.get_feed" },
  { name: "get_post", capability: "social.get_post" },
  { name: "list_posts", capability: "social.list_posts" },
  { name: "search_posts", capability: "social.search_posts" },
  { name: "get_profile", capability: "social.get_profile" },
  { name: "list_relationships", capability: "social.list_relationships" },
  { name: "list_engagements", capability: "social.list_engagements" },
  { name: "get_notifications", capability: "social.get_notifications" },
  { name: "create_post", capability: "social.create_post" },
  { name: "like_post", capability: "social.like_post" },
  { name: "repost_post", capability: "social.repost_post" },
  { name: "reply_to_post", capability: "social.reply_to_post" },
  { name: "follow", capability: "social.follow" },
  { name: "unfollow", capability: "social.unfollow" },
  { name: "engage", capability: "social.engage" },
] as const satisfies readonly { name: string; capability: SocialMcpToolId }[];

const QUERY_TOOLS = new Set([
  "get_feed",
  "get_post",
  "list_posts",
  "search_posts",
  "get_profile",
  "list_relationships",
  "list_engagements",
  "get_notifications",
]);

function toolCapability(tool: string): SocialMcpToolId {
  const found = SOCIAL_TOOLS.find(({ name }) => name === tool);
  if (found === undefined) throw invalidArgument(`unknown Social MCP tool: ${tool}`, "tool");
  return found.capability;
}

function resourceCapability(kind: string): SocialMcpResourceId {
  switch (kind) {
    case "feed":
      return "social.feed";
    case "profile":
      return "social.profile";
    case "posts":
    case "post":
      return "social.posts";
    default:
      throw new SocialDomainError("NOT_FOUND", `unknown Social Resource kind: ${kind}`);
  }
}

function actionFor(scope: SocialMcpScope, tool: string, args: Record<string, unknown>, invocationId: string): SocialAction {
  const actionId = `mcp:social:${sha256({ runId: scope.runId, roundId: scope.roundId, agentId: scope.agentId, turnId: scope.turnId, tool, invocationId })}`;
  const text = (name: string, maximum = 10_000): string => {
    const value = args[name];
    if (typeof value !== "string" || !value.trim() || value.length > maximum) {
      throw invalidArgument(`Social MCP ${tool} requires ${name}`, name);
    }
    return value;
  };
  const generated = (prefix: string) => `${prefix}:${sha256({ actionId, args })}`;
  switch (tool) {
    case "create_post":
      return {
        kind: "post",
        actionId,
        actorId: scope.actorId,
        postId: generated("post"),
        ...(typeof args.headline === "string" && args.headline.trim() ? { headline: args.headline } : {}),
        content: text("body"),
      };
    case "follow":
      return { kind: "relationship", actionId, actorId: scope.actorId, targetActorId: text("followeeId", 240), relationshipKind: "follow" };
    case "unfollow":
      return { kind: "relationship", actionId, actorId: scope.actorId, targetActorId: text("followeeId", 240), relationshipKind: "unfollow" };
    case "like_post":
      return {
        kind: "engagement",
        actionId,
        actorId: scope.actorId,
        targetPostId: text("postId", 240),
        engagementKind: "like",
      };
    case "repost_post":
      return {
        kind: "engagement",
        actionId,
        actorId: scope.actorId,
        targetPostId: text("postId", 240),
        engagementKind: "repost",
        derivedPostId: generated("repost"),
        ...(typeof args.headline === "string" && args.headline.trim() ? { derivedHeadline: args.headline } : {}),
        ...(typeof args.body === "string" ? { derivedContent: args.body } : {}),
      };
    case "reply_to_post":
      return {
        kind: "engagement",
        actionId,
        actorId: scope.actorId,
        targetPostId: text("postId", 240),
        engagementKind: "reply",
        replyBody: text("body"),
        derivedPostId: generated("reply"),
        ...(typeof args.headline === "string" && args.headline.trim() ? { derivedHeadline: args.headline } : {}),
        derivedContent: text("body"),
      };
    case "engage": {
      const engagement = args.engagement;
      if (engagement !== "like" && engagement !== "repost" && engagement !== "reply") {
        throw invalidArgument("Social MCP engage requires like, repost, or reply", "engagement");
      }
      const replyBody = args.replyBody;
      if (replyBody !== undefined && typeof replyBody !== "string") throw invalidArgument("Social MCP replyBody must be text", "replyBody");
      if (engagement === "reply" && (typeof replyBody !== "string" || !replyBody.trim())) {
        throw invalidArgument("Social MCP reply requires replyBody", "replyBody");
      }
      const derivedPostId = engagement === "repost"
        ? generated("repost")
        : engagement === "reply"
          ? generated("reply")
          : undefined;
      return {
        kind: "engagement",
        actionId,
        actorId: scope.actorId,
        targetPostId: text("postId", 240),
        engagementKind: engagement as EngagementKind,
        ...(typeof replyBody === "string" && replyBody.trim() ? { replyBody } : {}),
        ...(derivedPostId === undefined ? {} : { derivedPostId }),
        ...(engagement === "reply" && typeof replyBody === "string" ? { derivedContent: replyBody } : {}),
      };
    }
    default:
      throw invalidArgument(`unknown Social MCP tool: ${tool}`, "tool");
  }
}

function resourceUri(
  kind: "feed" | "profile" | "posts" | "post",
  scope: SocialMcpScope,
  values: { actorId?: string; postId?: string; cursor?: string } = {},
): string {
  const parameters = new URLSearchParams({ revision: scope.readRevisionRef, ...values }).toString();
  return `social://resource/${kind}?${parameters}`;
}

function parseResourceUri(uri: string): { kind: string; revision: string; actorId?: string; postId?: string; cursor?: string } {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw invalidArgument("invalid Social Resource URI", "uri");
  }
  if (parsed.protocol !== "social:" || parsed.hostname !== "resource") {
    throw invalidArgument("unsupported Social Resource URI", "uri");
  }
  const kind = parsed.pathname.replace(/^\//, "");
  const revision = parsed.searchParams.get("revision");
  if (!revision) throw invalidArgument("Social Resource URI must pin a revision", "uri.revision");
  const actorId = parsed.searchParams.get("actorId") ?? undefined;
  const postId = parsed.searchParams.get("postId") ?? undefined;
  const cursor = parsed.searchParams.get("cursor") ?? undefined;
  return {
    kind,
    revision,
    ...(actorId === undefined ? {} : { actorId }),
    ...(postId === undefined ? {} : { postId }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

function page<T>(input: {
  scope: SocialMcpScope;
  kind: "feed" | "posts";
  entries: readonly T[];
  cursor: string | undefined;
  pageSize?: number;
  map(entry: T): unknown;
}): { revision: string; items: unknown[]; nextUri?: string } {
  const offset = input.cursor === undefined ? 0 : parseCursor(input.cursor);
  const slice = input.entries.slice(offset, offset + (input.pageSize ?? PAGE_SIZE));
  const nextOffset = offset + slice.length;
  const nextUri = nextOffset < input.entries.length
    ? resourceUri(input.kind, input.scope, { ...(input.kind === "feed" ? { actorId: input.scope.actorId } : {}), cursor: String(nextOffset) })
    : undefined;
  return {
    revision: input.scope.readRevisionRef,
    items: slice.map(input.map),
    ...(nextUri === undefined ? {} : { nextUri }),
  };
}

function parseCursor(cursor: string): number {
  if (!/^\d+$/.test(cursor)) throw invalidArgument("Social Resource cursor is invalid", "uri.cursor");
  const value = Number(cursor);
  if (!Number.isSafeInteger(value) || value < 0) throw invalidArgument("Social Resource cursor is invalid", "uri.cursor");
  return value;
}

function postView(
  snapshot: SocialRevisionSnapshot,
  viewerActorId: string,
  post: SocialPost,
  extra: { rank?: number; bodyMode?: "full" | "excerpt" } = {},
) {
  const engagements = Object.values(snapshot.engagements).filter((engagement) => engagement.targetPostId === post.postId);
  const { bodyMode = "full", ...viewExtra } = extra;
  return {
    postId: post.postId,
    actorId: post.authorId,
    authorDisplayName: snapshot.actors[post.authorId]?.displayName ?? post.authorId,
    ...(post.headline ? { headline: post.headline } : {}),
    ...(bodyMode === "excerpt"
      ? {
          bodyExcerpt: post.content.slice(0, POST_EXCERPT_LENGTH),
          bodyTruncated: post.content.length > POST_EXCERPT_LENGTH,
        }
      : { body: post.content }),
    roundId: post.roundId,
    postType: post.postType ?? "original",
    ...(post.parentPostId === undefined ? {} : { parentPostId: post.parentPostId }),
    engagement: {
      likeCount: engagements.filter((item) => item.kind === "like").length,
      repostCount: engagements.filter((item) => item.kind === "repost").length,
      replyCount: engagements.filter((item) => item.kind === "reply").length,
      viewerHasLiked: engagements.some((item) => item.kind === "like" && item.actorId === viewerActorId),
      viewerHasReposted: engagements.some((item) => item.kind === "repost" && item.actorId === viewerActorId),
    },
    ...viewExtra,
  };
}

function profileView(snapshot: SocialRevisionSnapshot, viewerActorId: string, actorId: string) {
  const actor = snapshot.actors[actorId];
  if (actor === undefined) throw new SocialDomainError("NOT_FOUND", `unknown Social actor: ${actorId}`);
  return {
    ...actorSummary(snapshot, viewerActorId, actor),
    followerCount: Object.values(snapshot.relationships).filter((item) => item.targetActorId === actorId).length,
    followingCount: Object.values(snapshot.relationships).filter((item) => item.actorId === actorId).length,
  };
}

function actorSummary(snapshot: SocialRevisionSnapshot, viewerActorId: string, actor: Actor) {
  return {
    actorId: actor.actorId,
    displayName: actor.displayName,
    viewerFollows: Object.values(snapshot.relationships)
      .some((relationship) => relationship.actorId === viewerActorId && relationship.targetActorId === actor.actorId),
  };
}

function engagementView(snapshot: SocialRevisionSnapshot, engagement: Engagement) {
  return {
    engagementId: engagement.engagementId,
    actorId: engagement.actorId,
    actorDisplayName: snapshot.actors[engagement.actorId]?.displayName ?? engagement.actorId,
    postId: engagement.targetPostId,
    kind: engagement.kind,
    ...(engagement.replyBody === undefined ? {} : { replyBody: engagement.replyBody }),
    ...(engagement.derivedPostId === undefined ? {} : { derivedPostId: engagement.derivedPostId }),
    roundId: engagement.roundId,
  };
}

function notificationView(snapshot: SocialRevisionSnapshot, engagement: Engagement) {
  return {
    notificationId: engagement.engagementId,
    kind: engagement.kind,
    actorId: engagement.actorId,
    actorDisplayName: snapshot.actors[engagement.actorId]?.displayName ?? engagement.actorId,
    postId: engagement.targetPostId,
    roundId: engagement.roundId,
    ...(engagement.replyBody === undefined ? {} : { replyBody: engagement.replyBody }),
    ...(engagement.derivedPostId === undefined ? {} : { derivedPostId: engagement.derivedPostId }),
  };
}

function visiblePostIds(snapshot: SocialRevisionSnapshot, actorId: string): Set<string> {
  if (snapshot.exposurePolicy === "public_browse") return new Set(Object.keys(snapshot.posts));
  return new Set(Object.values(snapshot.exposures)
    .filter((exposure) => exposure.actorId === actorId)
    .map((exposure) => exposure.postId));
}

function queryPage<T>(
  entries: readonly T[],
  args: Record<string, unknown>,
  map: (entry: T) => unknown,
  options: { defaultLimit?: number; maximumLimit?: number } = {},
): { items: unknown[]; nextCursor?: string } {
  const offset = args.cursor === undefined ? 0 : parseCursor(requiredText(args.cursor, "cursor", 40));
  const limit = args.limit === undefined
    ? options.defaultLimit ?? PAGE_SIZE
    : boundedInteger(args.limit, "limit", 1, options.maximumLimit ?? 100);
  const slice = entries.slice(offset, offset + limit);
  const nextOffset = offset + slice.length;
  return {
    items: slice.map(map),
    ...(nextOffset < entries.length ? { nextCursor: String(nextOffset) } : {}),
  };
}

function requiredText(value: unknown, field: string, maximum = 10_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw invalidArgument(`${field} must be non-empty text no longer than ${maximum} characters`, field);
  }
  return value.trim();
}

function optionalText(value: unknown, field: string, maximum = 10_000): string | undefined {
  if (value === undefined) return undefined;
  return requiredText(value, field, maximum);
}

function boundedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw invalidArgument(`${field} must be an integer from ${minimum} through ${maximum}`, field);
  }
  return value as number;
}

function compareRelationship(left: Relationship, right: Relationship): number {
  return left.actorId.localeCompare(right.actorId) || left.targetActorId.localeCompare(right.targetActorId);
}
