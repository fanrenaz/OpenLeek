import assert from "node:assert/strict";
import test from "node:test";
import { emptyFinancialRevisionState } from "../src/application/revision-store.js";
import { PostgresFinancialRevisionStore } from "../src/infrastructure/postgres-revision-store.js";
import type { SqlClient } from "../src/infrastructure/postgres-state-store.js";

class FakeSqlClient implements SqlClient {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  readonly migrations = new Set<number>();
  version: number | undefined;

  async query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<{ rows: Row[] }> {
    this.calls.push({ text, ...(values === undefined ? {} : { values }) });
    if (text.includes("FROM financial_revision_migrations")) {
      const version = Number(text.match(/version = (\d+)/)?.[1]);
      return { rows: this.migrations.has(version) ? ([{ present: 1 }] as unknown as Row[]) : [] };
    }
    if (text.includes("FROM financial_revision_meta")) {
      return {
        rows: this.version === undefined
          ? []
          : ([{ version: this.version, capabilities: {} }] as unknown as Row[]),
      };
    }
    if (text.startsWith("SELECT")) return { rows: [] };
    if (text.startsWith("INSERT INTO financial_revision_migrations")) {
      const version = Number(text.match(/VALUES \((\d+)\)/)?.[1]);
      this.migrations.add(version);
    }
    if (text.startsWith("INSERT INTO financial_revision_meta")) this.version = Number(values?.[0]);
    return { rows: [] };
  }

  async transaction<T>(operation: (client: SqlClient) => Promise<T>): Promise<T> {
    return operation(this);
  }
}

test("Financial revisions migrate to v6 monotonic Stream checkpoints", async () => {
  const database = new FakeSqlClient();
  const store = new PostgresFinancialRevisionStore(database);
  await store.migrate();
  await store.save(emptyFinancialRevisionState());

  assert.deepEqual(await store.load(), emptyFinancialRevisionState());
  assert.deepEqual([...database.migrations].sort(), [3, 4, 5, 6]);
  assert.ok(database.calls.some((call) => call.text.includes("CREATE TABLE IF NOT EXISTS financial_revision_headers_v4")));
  assert.ok(database.calls.some((call) => call.text.includes("CREATE TABLE IF NOT EXISTS financial_revision_snapshots_v4")));
  assert.ok(database.calls.some((call) => call.text.includes("CREATE TABLE IF NOT EXISTS financial_round_intents")));
  assert.equal(database.calls.some((call) => call.text.startsWith("INSERT INTO financial_market_revision_state")), false);
});
