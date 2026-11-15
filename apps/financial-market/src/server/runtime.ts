import { Pool } from "pg";
import { FinancialMarketService, type FinancialMarketServiceOptions } from "../application/financial-market-service";
import { DeterministicOrderBookMatcher, type FinancialMarketMatcher } from "../application/matching";
import { HttpMarketMakerExecutor } from "../application/http-market-maker-executor";
import type { MarketMakerExecutor } from "../application/market-maker-executor";
import type { FinancialMarketStateStore } from "../application/persistence";
import { FinancialRevisionService } from "../application/revision-service";
import type { FinancialRevisionStore } from "../application/revision-store";
import type { FinancialMcpCredentialVerifier } from "../application/revision-service";
import { InMemoryFinancialMarketStateStore } from "../infrastructure/in-memory-state-store";
import { InMemoryFinancialRevisionStore } from "../infrastructure/in-memory-revision-store";
import { NapiFinancialMarketMatcher, type MatchingEngineNapiBinding } from "../infrastructure/napi-matcher";
import { PostgresFinancialMarketStateStore, type SqlClient } from "../infrastructure/postgres-state-store";
import { PostgresFinancialRevisionStore } from "../infrastructure/postgres-revision-store";
import { financialMcpCredentialVerifierFromEnvironment } from "./credential-verifier";

declare global {
  // Keep all API route entrypoints in this process on one cache. Dedicated
  // workers synchronize through monotonic owner rows and Stream cursors.
  // eslint-disable-next-line no-var
  var __openleekFinancialMarketService: Promise<FinancialMarketService> | undefined;
  // eslint-disable-next-line no-var
  var __openleekFinancialRevisionService: Promise<FinancialRevisionService> | undefined;
}

export interface FinancialMarketRuntimeOptions {
  stateStore: FinancialMarketStateStore;
  matcher?: FinancialMarketMatcher;
  marketMakerExecutor?: MarketMakerExecutor;
  algorithmRunnerUrl?: string;
}

export interface FinancialRevisionRuntimeOptions {
  market: FinancialMarketService;
  revisionStore: FinancialRevisionStore;
  credentialVerifier?: FinancialMcpCredentialVerifier;
  endpoint?: string;
  marketMakerHistoryEndpoint?: string;
}

/** Composition root used by tests and by the environment-backed runtime. */
export function createFinancialMarketRuntime(
  options: FinancialMarketRuntimeOptions,
): Promise<FinancialMarketService> {
  const serviceOptions: FinancialMarketServiceOptions = {
    stateStore: options.stateStore,
    ...(options.matcher === undefined ? {} : { matcher: options.matcher }),
    ...(options.marketMakerExecutor === undefined
      ? options.algorithmRunnerUrl === undefined ? {} : { marketMakerExecutor: new HttpMarketMakerExecutor(options.algorithmRunnerUrl) }
      : { marketMakerExecutor: options.marketMakerExecutor }),
  };
  return FinancialMarketService.create(serviceOptions);
}

/** Separate composition root so revision tests do not require environment state. */
export function createFinancialRevisionRuntime(
  options: FinancialRevisionRuntimeOptions,
): Promise<FinancialRevisionService> {
  return FinancialRevisionService.create({
    market: options.market,
    store: options.revisionStore,
    ...(options.credentialVerifier === undefined ? {} : { credentialVerifier: options.credentialVerifier }),
    ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
    ...(options.marketMakerHistoryEndpoint === undefined ? {} : { marketMakerHistoryEndpoint: options.marketMakerHistoryEndpoint }),
  });
}

/**
 * Lazily initializes Financial Market exactly once per Node process. The
 * production branch accepts only the Financial Context's DSN and performs
 * this Context's migration before tRPC accepts commands.
 */
export function financialMarketService(): Promise<FinancialMarketService> {
  globalThis.__openleekFinancialMarketService ??= createFromEnvironment();
  return globalThis.__openleekFinancialMarketService;
}

/** Financial-owned revision/MCP runtime, sharing the same market reader. */
export function financialMarketRevisionService(): Promise<FinancialRevisionService> {
  globalThis.__openleekFinancialRevisionService ??= createRevisionFromEnvironment();
  return globalThis.__openleekFinancialRevisionService;
}

async function createFromEnvironment(): Promise<FinancialMarketService> {
  if (process.env.OPENLEEK_FINANCIAL_MARKET_IN_MEMORY === "true") {
    // Explicit test mode never needs an external native artifact, including
    // when exercised through `next start` (which sets NODE_ENV=production).
    return createFinancialMarketRuntime({
      stateStore: new InMemoryFinancialMarketStateStore(),
      matcher: new DeterministicOrderBookMatcher(),
      algorithmRunnerUrl: process.env.OPENLEEK_ALGORITHM_RUNNER_URL ?? "http://algorithm-runner:8080",
    });
  }
  const matcher = await matcherFromEnvironment();
  const connectionString = process.env.OPENLEEK_FINANCIAL_MARKET_DATABASE_URL;
  if (!connectionString) {
    throw new Error("OPENLEEK_FINANCIAL_MARKET_DATABASE_URL is required outside explicit in-memory mode");
  }
  const pool = new Pool({ connectionString, max: 10 });
  const store = new PostgresFinancialMarketStateStore(new PgSqlClient(pool));
  await store.migrate();
  return createFinancialMarketRuntime({
    stateStore: store,
    matcher,
    algorithmRunnerUrl: process.env.OPENLEEK_ALGORITHM_RUNNER_URL ?? "http://algorithm-runner:8080",
  });
}

async function createRevisionFromEnvironment(): Promise<FinancialRevisionService> {
  const market = await financialMarketService();
  if (process.env.OPENLEEK_FINANCIAL_MARKET_IN_MEMORY === "true") {
    return createFinancialRevisionRuntime({
      market,
      revisionStore: new InMemoryFinancialRevisionStore(),
      credentialVerifier: financialMcpCredentialVerifierFromEnvironment(),
      marketMakerHistoryEndpoint: process.env.OPENLEEK_FINANCIAL_MARKET_MAKER_HISTORY_URL ?? "http://financial-market:3000/internal/market-maker/history",
    });
  }
  const connectionString = process.env.OPENLEEK_FINANCIAL_MARKET_DATABASE_URL;
  if (!connectionString) {
    throw new Error("OPENLEEK_FINANCIAL_MARKET_DATABASE_URL is required outside explicit in-memory mode");
  }
  const pool = new Pool({ connectionString, max: 3 });
  const revisionStore = new PostgresFinancialRevisionStore(new PgSqlClient(pool));
  await revisionStore.migrate();
  return createFinancialRevisionRuntime({
    market,
    revisionStore,
    credentialVerifier: financialMcpCredentialVerifierFromEnvironment(),
    marketMakerHistoryEndpoint: process.env.OPENLEEK_FINANCIAL_MARKET_MAKER_HISTORY_URL ?? "http://financial-market:3000/internal/market-maker/history",
  });
}

/**
 * Production images provide the Rust artifact as this CommonJS-loadable N-API
 * module. Development and explicit in-memory tests retain the deterministic
 * TypeScript matcher, which has dedicated parity tests against the adapter.
 */
async function matcherFromEnvironment(): Promise<FinancialMarketMatcher> {
  const moduleId = process.env.OPENLEEK_MATCHING_ENGINE_NAPI_MODULE;
  if (moduleId === undefined || moduleId.length === 0) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("OPENLEEK_MATCHING_ENGINE_NAPI_MODULE is required in production");
    }
    return new DeterministicOrderBookMatcher();
  }
  // A static `require(moduleId)` is converted by webpack into an empty context
  // module, which cannot resolve a deployment-provided `.node` path. Resolve
  // Node's real CommonJS loader at runtime so the standalone image can load
  // the N-API artifact copied to OPENLEEK_MATCHING_ENGINE_NAPI_MODULE.
  // eslint-disable-next-line no-eval
  const requireNative = eval("require") as (specifier: string) => unknown;
  const loaded: unknown = requireNative(moduleId);
  const candidate = unwrapDefault(loaded);
  if (!isMatchingEngineNapiBinding(candidate)) {
    throw new Error("OPENLEEK_MATCHING_ENGINE_NAPI_MODULE must export matchOpenOrders");
  }
  return new NapiFinancialMarketMatcher(candidate);
}

class PgSqlClient implements SqlClient {
  constructor(private readonly pool: Pool) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    statement: string,
    parameters?: readonly unknown[],
  ): Promise<{ rows: Row[] }> {
    const result = await this.pool.query(statement, parameters === undefined ? undefined : [...parameters]);
    return { rows: result.rows as Row[] };
  }

  async transaction<T>(operation: (client: SqlClient) => Promise<T>): Promise<T> {
    const connection = await this.pool.connect();
    const client: SqlClient = {
      query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
        statement: string,
        parameters?: readonly unknown[],
      ) => {
        const result = await connection.query(statement, parameters === undefined ? undefined : [...parameters]);
        return { rows: result.rows as Row[] };
      },
      transaction: async <Nested>(nested: (client: SqlClient) => Promise<Nested>) => nested(client),
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
  }
}

function unwrapDefault(value: unknown): unknown {
  if (value && typeof value === "object" && "default" in value) {
    return (value as { default: unknown }).default;
  }
  return value;
}

function isMatchingEngineNapiBinding(value: unknown): value is MatchingEngineNapiBinding {
  return Boolean(value && typeof value === "object" && "matchOpenOrders" in value && typeof (value as { matchOpenOrders?: unknown }).matchOpenOrders === "function");
}
