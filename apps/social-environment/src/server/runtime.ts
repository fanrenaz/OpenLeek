import neo4j from "neo4j-driver";
import { Pool } from "pg";
import { SocialEnvironmentService } from "../application/social-environment-service";
import { HttpFeedAlgorithmExecutor } from "../application/http-feed-algorithm-executor";
import { HttpSocialNetworkExecutor } from "../application/http-social-network-executor";
import type { SocialProjection } from "../application/projection";
import type { SocialStateStore } from "../application/state-store";
import { Neo4jSocialProjection } from "../infrastructure/neo4j-projection";
import { PostgresSocialStateStore, type SqlQueryClient } from "../infrastructure/postgres-state-store";

export interface SocialEnvironmentRuntimeConfig {
  databaseUrl: string;
  neo4jUri: string;
  neo4jUser: string;
  neo4jPassword: string;
  neo4jDatabase: string;
  /** The Context advertises this endpoint; Experiment never constructs it. */
  mcpEndpoint: string;
  /** Internal-only Python 3.12 algorithm execution service; it has no owner credentials. */
  algorithmRunnerUrl?: string;
  /** Runner-only Social committed-history endpoint; never exposed as Agent MCP. */
  feedAlgorithmHistoryEndpoint?: string;
}

export interface SocialEnvironmentRuntimeDependencies {
  createStateStore(config: SocialEnvironmentRuntimeConfig): Promise<SocialStateStore>;
  createProjection(config: SocialEnvironmentRuntimeConfig): Promise<SocialProjection | undefined>;
}

declare global {
  // Next route chunks can load this module through separate entrypoints. The
  // Process-global promise keeps all API route entrypoints on one cache. The
  // dedicated worker synchronizes through monotonic PostgreSQL rows instead.
  // eslint-disable-next-line no-var
  var __openleekSocialEnvironmentService: Promise<SocialEnvironmentService> | undefined;
}

/** Parse only credentials owned by the Social Environment Context. */
export function socialEnvironmentRuntimeConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): SocialEnvironmentRuntimeConfig {
  return {
    databaseUrl: required(environment, "OPENLEEK_SOCIAL_ENVIRONMENT_DATABASE_URL"),
    neo4jUri: required(environment, "OPENLEEK_SOCIAL_NEO4J_URI"),
    neo4jUser: required(environment, "OPENLEEK_SOCIAL_NEO4J_USER"),
    neo4jPassword: required(environment, "OPENLEEK_SOCIAL_NEO4J_PASSWORD"),
    neo4jDatabase: environment.OPENLEEK_SOCIAL_NEO4J_DATABASE || "neo4j",
    mcpEndpoint: environment.OPENLEEK_SOCIAL_MCP_URL || "http://127.0.0.1:3106/internal/mcp",
    algorithmRunnerUrl: environment.OPENLEEK_ALGORITHM_RUNNER_URL || "http://algorithm-runner:8080",
    feedAlgorithmHistoryEndpoint: environment.OPENLEEK_SOCIAL_FEED_ALGORITHM_HISTORY_URL || "http://social-environment:3000/internal/feed-algorithm/history",
  };
}

export async function createSocialEnvironmentRuntime(
  config: SocialEnvironmentRuntimeConfig,
  dependencies: SocialEnvironmentRuntimeDependencies = productionDependencies(),
): Promise<SocialEnvironmentService> {
  const stateStore = await dependencies.createStateStore(config);
  const projection = await dependencies.createProjection(config);
  return SocialEnvironmentService.create({
    stateStore,
    ...(projection === undefined ? {} : { projection }),
    mcpEndpoint: config.mcpEndpoint,
    feedAlgorithmExecutor: new HttpFeedAlgorithmExecutor(config.algorithmRunnerUrl ?? "http://algorithm-runner:8080"),
    socialNetworkExecutor: new HttpSocialNetworkExecutor(config.algorithmRunnerUrl ?? "http://algorithm-runner:8080"),
    feedAlgorithmHistoryEndpoint: config.feedAlgorithmHistoryEndpoint ?? "http://social-environment:3000/internal/feed-algorithm/history",
  });
}

/** Lazily runs Social's owner-database migration before accepting a request. */
export function socialEnvironmentService(): Promise<SocialEnvironmentService> {
  globalThis.__openleekSocialEnvironmentService ??= createSocialEnvironmentRuntime(
    socialEnvironmentRuntimeConfig(),
    productionDependencies(process.env.OPENLEEK_SOCIAL_ENVIRONMENT_WORKER !== "true"),
  );
  return globalThis.__openleekSocialEnvironmentService;
}

export function resetSocialEnvironmentRuntimeForTest(): void {
  globalThis.__openleekSocialEnvironmentService = undefined;
}

function productionDependencies(includeProjection = true): SocialEnvironmentRuntimeDependencies {
  return {
    async createStateStore(config) {
      const pool = new Pool({ connectionString: config.databaseUrl });
      const store = new PostgresSocialStateStore(pgClient(pool));
      await store.initialise();
      return store;
    },
    async createProjection(config) {
      if (!includeProjection) return undefined;
      const driver = neo4j.driver(
        config.neo4jUri,
        neo4j.auth.basic(config.neo4jUser, config.neo4jPassword),
      );
      return new Neo4jSocialProjection({
        session({ database }) {
          const session = driver.session({ database });
          return {
            run(query, parameters) {
              return Promise.resolve(session.run(query, parameters));
            },
            close() {
              return session.close();
            },
          };
        },
      }, config.neo4jDatabase);
    },
  };
}

function pgClient(pool: Pool): SqlQueryClient {
  return {
    async query<Row extends Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ): Promise<{ rows: Row[] }> {
      const result = await pool.query(text, values as unknown[] | undefined);
      return { rows: result.rows as Row[] };
    },
    async transaction<T>(operation: (client: SqlQueryClient) => Promise<T>): Promise<T> {
      const connection = await pool.connect();
      const client: SqlQueryClient = {
        query: async <Row extends Record<string, unknown>>(
          text: string,
          values?: readonly unknown[],
        ) => {
          const result = await connection.query(text, values as unknown[] | undefined);
          return { rows: result.rows as Row[] };
        },
        transaction: async <Nested>(nested: (client: SqlQueryClient) => Promise<Nested>) => nested(client),
      };
      try {
        await connection.query("BEGIN");
        const result = await operation(client);
        await connection.query("COMMIT");
        return result;
      } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
      } finally {
        connection.release();
      }
    },
  };
}

function required(environment: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = environment[name];
  if (value === undefined || value.trim() === "") throw new Error(`${name} is required`);
  return value;
}
