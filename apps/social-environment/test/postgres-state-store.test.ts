import assert from "node:assert/strict";
import test from "node:test";
import { PostgresSocialStateStore, type SqlQueryClient } from "../src/infrastructure/postgres-state-store.js";
import { emptySocialState } from "../src/application/state-store.js";

class FakeSqlClient implements SqlQueryClient {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  readonly migrations = new Set<number>();
  version: number | undefined;

  async query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<{ rows: Row[] }> {
    this.calls.push({ text, ...(values === undefined ? {} : { values }) });
    if (text.includes("FROM social_state_migrations")) {
      const version = Number(text.match(/version = (\d+)/)?.[1]);
      return { rows: this.migrations.has(version) ? ([{ present: 1 }] as unknown as Row[]) : [] };
    }
    if (text.includes("FROM social_state_meta")) {
      return { rows: this.version === undefined ? [] : ([{ version: this.version }] as unknown as Row[]) };
    }
    if (text.startsWith("SELECT")) return { rows: [] };
    if (text.startsWith("INSERT INTO social_state_migrations")) {
      const version = Number(text.match(/VALUES \((\d+)\)/)?.[1]);
      this.migrations.add(version);
    }
    if (text.startsWith("INSERT INTO social_state_meta")) this.version = Number(values?.[0]);
    return { rows: [] };
  }

  async transaction<T>(operation: (client: SqlQueryClient) => Promise<T>): Promise<T> {
    return operation(this);
  }
}

test("Postgres state store migrates to v6 monotonic Stream checkpoints", async () => {
  const client = new FakeSqlClient();
  const store = new PostgresSocialStateStore(client);
  await store.initialise();
  const state = emptySocialState();
  await store.save(state);
  assert.deepEqual(await store.load(), state);
  const upsert = client.calls.find((call) => call.text.startsWith("INSERT INTO social_state_meta"));
  assert.ok(upsert);
  assert.match(upsert.text, /\$1/);
  assert.deepEqual(upsert.values?.[0], 2);
  assert.equal(client.calls.some((call) => call.text.startsWith("INSERT INTO social_environment_state")), false);
  assert.deepEqual([...client.migrations].sort(), [3, 4, 5, 6]);
  assert.ok(client.calls.some((call) => call.text.includes("CREATE TABLE IF NOT EXISTS social_revision_headers_v4")));
  assert.ok(client.calls.some((call) => call.text.includes("CREATE TABLE IF NOT EXISTS social_revision_snapshots_v4")));
  assert.ok(client.calls.some((call) => call.text.includes("CREATE TABLE IF NOT EXISTS social_round_intents")));
});
