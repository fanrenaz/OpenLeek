import type { SocialProjection } from "../application/projection";
import type { CommittedSocialGraph } from "../domain/models";

export interface Neo4jSession {
  run(query: string, parameters: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export interface Neo4jDriver {
  session(options: { database: string }): Neo4jSession;
}

/**
 * A fully replaceable projection. Every Cypher query is scoped to a run, and
 * callers only ever hand this adapter the committed graph assembled by Social.
 */
export class Neo4jSocialProjection implements SocialProjection {
  constructor(
    private readonly driver: Neo4jDriver,
    private readonly database = "neo4j",
  ) {}

  async replaceCommitted(graph: CommittedSocialGraph): Promise<void> {
    const session = this.driver.session({ database: this.database });
    try {
      await consume(
        session.run("MATCH (node {runId: $runId}) DETACH DELETE node", { runId: graph.runId }),
      );
      await consume(
        session.run(
          `UNWIND $actors AS actor
           MERGE (socialActor:SocialActor {runId: $runId, actorId: actor.actorId})
           SET socialActor.displayName = actor.displayName,
               socialActor.maximumActionsPerRound = actor.maximumActionsPerRound`,
          { runId: graph.runId, actors: graph.actors },
        ),
      );
      await consume(
        session.run(
          `UNWIND $posts AS post
           MATCH (author:SocialActor {runId: $runId, actorId: post.authorId})
           MERGE (socialPost:SocialPost {runId: $runId, postId: post.postId})
           SET socialPost.content = post.content,
               socialPost.headline = post.headline,
               socialPost.roundId = post.roundId
           MERGE (socialPost)-[:AUTHORED_BY]->(author)`,
          { runId: graph.runId, posts: graph.posts },
        ),
      );
      await consume(
        session.run(
          `UNWIND $relationships AS relationship
           MATCH (follower:SocialActor {runId: $runId, actorId: relationship.actorId})
           MATCH (followee:SocialActor {runId: $runId, actorId: relationship.targetActorId})
           MERGE (follower)-[:FOLLOWS]->(followee)`,
          { runId: graph.runId, relationships: graph.relationships },
        ),
      );
      await consume(
        session.run(
          `UNWIND $exposures AS exposure
           MATCH (actor:SocialActor {runId: $runId, actorId: exposure.actorId})
           MATCH (post:SocialPost {runId: $runId, postId: exposure.postId})
           MERGE (actor)-[edge:EXPOSED_TO {roundId: exposure.roundId}]->(post)
           SET edge.exposureId = exposure.exposureId,
               edge.rank = exposure.rank`,
          { runId: graph.runId, exposures: graph.exposures },
        ),
      );
      await consume(
        session.run(
          `UNWIND $engagements AS engagement
           MATCH (actor:SocialActor {runId: $runId, actorId: engagement.actorId})
           MATCH (post:SocialPost {runId: $runId, postId: engagement.targetPostId})
           MERGE (actor)-[edge:ENGAGED {engagementId: engagement.engagementId}]->(post)
           SET edge.kind = engagement.kind,
               edge.roundId = engagement.roundId,
               edge.replyBody = engagement.replyBody`,
          { runId: graph.runId, engagements: graph.engagements },
        ),
      );
    } finally {
      await session.close();
    }
  }
}

async function consume(result: Promise<unknown>): Promise<void> {
  await result;
}
