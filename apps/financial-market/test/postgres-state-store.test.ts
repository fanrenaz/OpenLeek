import assert from "node:assert/strict";
import test from "node:test";
import type { FinancialMarketSnapshot } from "../src/application/persistence.js";
import { PostgresFinancialMarketStateStore, type SqlClient } from "../src/infrastructure/postgres-state-store.js";

class FakeSqlClient implements SqlClient {
  readonly calls: Array<{ statement: string; parameters?: readonly unknown[] }> = [];
  readonly migrations = new Set<number>();
  version: number | undefined;

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    statement: string,
    parameters?: readonly unknown[],
  ): Promise<{ rows: Row[] }> {
    this.calls.push({ statement, ...(parameters === undefined ? {} : { parameters }) });
    if (statement.includes("FROM financial_market_migrations")) {
      const version = Number(statement.match(/version = (\d+)/)?.[1]);
      return { rows: this.migrations.has(version) ? ([{ present: 1 }] as unknown as Row[]) : [] };
    }
    if (statement.includes("FROM financial_market_meta")) {
      return { rows: this.version === undefined ? [] : ([{ version: this.version }] as unknown as Row[]) };
    }
    if (statement.startsWith("SELECT")) return { rows: [] };
    if (statement.startsWith("INSERT INTO financial_market_migrations")) {
      const version = Number(statement.match(/VALUES \((\d+)\)/)?.[1]);
      this.migrations.add(version);
    }
    if (statement.startsWith("INSERT INTO financial_market_meta")) this.version = Number(parameters?.[0]);
    return { rows: [] };
  }

  async transaction<T>(operation: (client: SqlClient) => Promise<T>): Promise<T> {
    return operation(this);
  }
}

test("Postgres persistence migrates to v4 lazy seal tables", async () => {
  const database = new FakeSqlClient();
  const store = new PostgresFinancialMarketStateStore(database);
  const snapshot: FinancialMarketSnapshot = {
    version: 2,
    runs: [],
    idempotency: [],
    marketMakerRegistry: { drafts: {}, versions: {} },
  };
  await store.migrate();
  await store.save(snapshot);
  const loaded = await store.load();

  assert.deepEqual(loaded, {
    ...snapshot,
    marketMakerRegistry: { ...snapshot.marketMakerRegistry, tombstones: [] },
    financialInitialStatePresetRegistry: { drafts: {}, versions: {}, tombstones: [] },
  });
  assert.equal(database.calls.some((call) => call.statement.startsWith("INSERT INTO financial_market_state")), false);
  assert.deepEqual([...database.migrations].sort(), [3, 4]);
  assert.ok(database.calls.some((call) => call.statement.includes("CREATE TABLE IF NOT EXISTS financial_market_seal_headers_v4")));
  assert.ok(database.calls.some((call) => call.statement.includes("CREATE TABLE IF NOT EXISTS financial_market_seal_materials_v4")));
  const upsert = database.calls.find((call) => call.statement.startsWith("INSERT INTO financial_market_meta"));
  assert.equal(upsert?.parameters?.[0], 2);
});
