import assert from "node:assert/strict";
import test from "node:test";
import { Neo4jSocialProjection, type Neo4jDriver } from "../src/infrastructure/neo4j-projection.js";

test("Neo4j projection replaces a run-scoped committed graph", async () => {
  const calls: Array<{ query: string; parameters: Record<string, unknown> }> = [];
  let closed = false;
  const driver: Neo4jDriver = {
    session: () => ({
      async run(query, parameters) {
        calls.push({ query, parameters });
        return {};
      },
      async close() { closed = true; },
    }),
  };
  const projection = new Neo4jSocialProjection(driver);
  await projection.replaceCommitted({
    runId: "run-1",
    actors: [{ actorId: "alice", displayName: "Alice", maximumActionsPerRound: 5 }],
    posts: [],
    engagements: [],
    exposures: [],
    relationships: [],
  });
  assert.equal(calls.length, 6);
  assert.match(calls[0]?.query ?? "", /DETACH DELETE/);
  assert.equal(calls[0]?.parameters.runId, "run-1");
  assert.equal(closed, true);
});
