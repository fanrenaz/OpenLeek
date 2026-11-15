import { identifierSchema } from "@openleek/contracts/core";
import { z } from "zod";
import type { SocialEnvironmentService } from "./social-environment-service";

const numericCursorSchema = z.string().regex(/^\d+$/);

export const socialObserverQuerySchema = z.object({
  runId: identifierSchema,
  revisionRef: identifierSchema,
  view: z.enum(["timeline", "post", "profile", "relationships"]).default("timeline"),
  authorId: identifierSchema.optional(),
  q: z.string().max(500).optional(),
  postId: identifierSchema.optional(),
  actorId: identifierSchema.optional(),
  direction: z.enum(["followers", "following"]).optional(),
  cursor: numericCursorSchema.optional(),
  limit: z.number().int().min(1).max(200).optional(),
}).strict();

export type SocialObserverQuery = z.infer<typeof socialObserverQuerySchema>;

export async function querySocialObserver(
  service: SocialEnvironmentService,
  input: SocialObserverQuery,
): Promise<unknown> {
  const snapshot = await service.publicObserverSnapshot(input.runId, input.revisionRef);
  const actors = new Map(snapshot.actors.map((actor) => [actor.actorId, actor]));
  const engagementsFor = (postId: string) => {
    const values = snapshot.engagements.filter((engagement) => engagement.targetPostId === postId);
    return {
      likeCount: values.filter((engagement) => engagement.kind === "like").length,
      repostCount: values.filter((engagement) => engagement.kind === "repost").length,
      replyCount: values.filter((engagement) => engagement.kind === "reply").length,
    };
  };
  const postView = (post: (typeof snapshot.posts)[number]) => ({
    ...post,
    author: actors.get(post.authorId) ?? { actorId: post.authorId, displayName: post.authorId },
    ...engagementsFor(post.postId),
  });

  if (input.view === "timeline") {
    const query = input.q?.trim().toLocaleLowerCase();
    const values = snapshot.posts
      .filter((post) => input.authorId === undefined || post.authorId === input.authorId)
      .filter((post) => !query || `${post.headline}\n${post.content}`.toLocaleLowerCase().includes(query))
      .map(postView);
    return { revision: snapshot.revision, delta: snapshot.delta, ...page(values, input.cursor, input.limit ?? 50) };
  }
  if (input.view === "post") {
    if (!input.postId) throw new Error("postId is required for the post view");
    const post = snapshot.posts.find((candidate) => candidate.postId === input.postId);
    if (!post) throw new Error("unknown public post");
    const replies = snapshot.posts.filter((candidate) => candidate.parentPostId === post.postId).map(postView);
    const engagements = snapshot.engagements
      .filter((engagement) => engagement.targetPostId === post.postId)
      .map((engagement) => ({ ...engagement, actor: actors.get(engagement.actorId) }));
    return { revision: snapshot.revision, post: postView(post), replies, engagements };
  }
  if (!input.actorId) throw new Error(`actorId is required for the ${input.view} view`);
  if (input.view === "profile") {
    const actor = snapshot.actors.find((candidate) => candidate.actorId === input.actorId);
    if (!actor) throw new Error("unknown public profile");
    return {
      revision: snapshot.revision,
      actor,
      followerCount: snapshot.relationships.filter((relationship) => relationship.targetActorId === actor.actorId).length,
      followingCount: snapshot.relationships.filter((relationship) => relationship.actorId === actor.actorId).length,
      posts: snapshot.posts.filter((post) => post.authorId === actor.actorId).slice(0, 20).map(postView),
    };
  }
  const direction = input.direction ?? "followers";
  const values = snapshot.relationships
    .filter((relationship) => direction === "followers"
      ? relationship.targetActorId === input.actorId
      : relationship.actorId === input.actorId)
    .map((relationship) => {
      const relatedId = direction === "followers" ? relationship.actorId : relationship.targetActorId;
      return { relationship, actor: actors.get(relatedId) ?? { actorId: relatedId, displayName: relatedId } };
    });
  return { revision: snapshot.revision, ...page(values, input.cursor, input.limit ?? 50) };
}

function page<T>(items: T[], cursor: string | undefined, limit: number) {
  const offset = cursor === undefined ? 0 : Number(cursor);
  const next = offset + limit;
  return {
    items: items.slice(offset, next),
    ...(next < items.length ? { nextCursor: String(next) } : {}),
  };
}
