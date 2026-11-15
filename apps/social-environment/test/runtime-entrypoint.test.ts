import assert from "node:assert/strict";
import test from "node:test";
import { InMemorySocialStateStore } from "../src/infrastructure/memory-state-store.js";
import type { SocialProjection } from "../src/application/projection.js";
import {
  createSocialEnvironmentRuntime,
  socialEnvironmentRuntimeConfig,
  type SocialEnvironmentRuntimeConfig,
} from "../src/server/runtime.js";

const config: SocialEnvironmentRuntimeConfig = {
  databaseUrl: "postgresql://social-owner:secret@postgres/social",
  neo4jUri: "bolt://neo4j:7687",
  neo4jUser: "neo4j",
  neo4jPassword: "secret",
  neo4jDatabase: "social",
  mcpEndpoint: "http://127.0.0.1:3106/internal/mcp",
  algorithmRunnerUrl: "http://algorithm-runner:8080",
  feedAlgorithmHistoryEndpoint: "http://social-environment:3000/internal/feed-algorithm/history",
};

test("Social composition root reads only Social-owned database and Neo4j environment", () => {
  assert.deepEqual(socialEnvironmentRuntimeConfig({
    OPENLEEK_SOCIAL_ENVIRONMENT_DATABASE_URL: config.databaseUrl,
    OPENLEEK_SOCIAL_NEO4J_URI: config.neo4jUri,
    OPENLEEK_SOCIAL_NEO4J_USER: config.neo4jUser,
    OPENLEEK_SOCIAL_NEO4J_PASSWORD: config.neo4jPassword,
    OPENLEEK_SOCIAL_NEO4J_DATABASE: config.neo4jDatabase,
    OPENLEEK_SOCIAL_MCP_URL: config.mcpEndpoint,
    OPENLEEK_ALGORITHM_RUNNER_URL: config.algorithmRunnerUrl,
    OPENLEEK_SOCIAL_FEED_ALGORITHM_HISTORY_URL: config.feedAlgorithmHistoryEndpoint,
    OPENLEEK_FINANCIAL_MARKET_DATABASE_URL: "postgresql://must-not-be-read",
  }), config);
  assert.throws(
    () => socialEnvironmentRuntimeConfig({
      OPENLEEK_SOCIAL_ENVIRONMENT_DATABASE_URL: config.databaseUrl,
    }),
    /OPENLEEK_SOCIAL_NEO4J_URI is required/,
  );
});

test("Social composition root builds the service from a v2 owner state store", async () => {
  const stateStore = new InMemorySocialStateStore();
  let receivedConfig: SocialEnvironmentRuntimeConfig | undefined;
  const projection: SocialProjection = { async replaceCommitted() {} };
  const service = await createSocialEnvironmentRuntime(config, {
    async createStateStore(received) {
      receivedConfig = received;
      return stateStore;
    },
    async createProjection(received) {
      assert.equal(received.neo4jUri, config.neo4jUri);
      return projection;
    },
  });
  const checkpoint = await service.initialize("run-1", {
    actors: [{ actorId: "alice", displayName: "Alice", maximumActionsPerRound: 5 }],
    feedSize: 1,
  }, {
    transitionId: "transition-1",
    stepId: "initialize",
    payloadDigest: "a".repeat(64),
    expectedCheckpointRef: "",
  });
  assert.equal(receivedConfig?.databaseUrl, config.databaseUrl);
  assert.equal(checkpoint.runId, "run-1");
});
