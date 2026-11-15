import { Pool } from "pg";
import { MemoryNewsStore, NewsContextService, type NewsBinding, type NewsRevision, type NewsRunConfiguration, type NewsScenarioDraft, type NewsScenarioTombstone, type NewsScenarioVersion, type NewsScope, type NewsStore } from "./news";
export { MemoryNewsStore } from "./news";

let singleton: Promise<NewsContextService> | undefined;
export function newsContext() { return singleton ??= create(); }

async function create() {
  if (process.env.OPENLEEK_NEWS_CONTEXT_IN_MEMORY === "true") return new NewsContextService(new MemoryNewsStore());
  const connectionString = process.env.OPENLEEK_NEWS_CONTEXT_DATABASE_URL;
  if (!connectionString) throw new Error("OPENLEEK_NEWS_CONTEXT_DATABASE_URL is required");
  const pool = new Pool({ connectionString, max: 10 });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS news_scenario_drafts (scenario_id text PRIMARY KEY, record jsonb NOT NULL);
    CREATE TABLE IF NOT EXISTS news_scenario_versions (version_ref text PRIMARY KEY, record jsonb NOT NULL);
    CREATE TABLE IF NOT EXISTS news_scenario_tombstones (target text NOT NULL, asset_id text NOT NULL, record jsonb NOT NULL, PRIMARY KEY(target,asset_id));
    CREATE TABLE IF NOT EXISTS news_run_configurations (run_id text PRIMARY KEY, record jsonb NOT NULL);
    CREATE TABLE IF NOT EXISTS news_revisions (revision_ref text PRIMARY KEY, run_id text NOT NULL, round_id integer NOT NULL, record jsonb NOT NULL, UNIQUE(run_id, round_id));
    CREATE TABLE IF NOT EXISTS news_bindings (token_digest text PRIMARY KEY, run_id text NOT NULL, agent_id text NOT NULL, record jsonb NOT NULL);
    CREATE INDEX IF NOT EXISTS news_bindings_run_idx ON news_bindings(run_id);
    CREATE TABLE IF NOT EXISTS news_scopes (run_id text NOT NULL, agent_id text NOT NULL, scope_id text NOT NULL, record jsonb NOT NULL, PRIMARY KEY(run_id,agent_id));
  `);
  const store: NewsStore = {
    async saveDraft(value) { await upsert(pool, "news_scenario_drafts", "scenario_id", value.scenarioId, value); },
    async draft(id) { return record<NewsScenarioDraft>(pool, "news_scenario_drafts", "scenario_id", id); },
    async listDrafts() { return records<NewsScenarioDraft>(pool, "news_scenario_drafts"); },
    async saveScenario(value) { await pool.query("INSERT INTO news_scenario_versions(version_ref,record) VALUES($1,$2) ON CONFLICT(version_ref) DO NOTHING", [value.versionRef, value]); },
    async scenario(ref) { return record<NewsScenarioVersion>(pool, "news_scenario_versions", "version_ref", ref); },
    async listScenarios() { return records<NewsScenarioVersion>(pool, "news_scenario_versions"); },
    async saveTombstone(value) { await pool.query("INSERT INTO news_scenario_tombstones(target,asset_id,record) VALUES($1,$2,$3) ON CONFLICT(target,asset_id) DO NOTHING", [value.target, value.assetId, value]); },
    async tombstone(target, id) { return (await pool.query<{ record: NewsScenarioTombstone }>("SELECT record FROM news_scenario_tombstones WHERE target=$1 AND asset_id=$2", [target, id])).rows[0]?.record; },
    async listTombstones() { return records<NewsScenarioTombstone>(pool, "news_scenario_tombstones"); },
    async saveRun(value) { await upsert(pool, "news_run_configurations", "run_id", value.runId, value); },
    async run(runId) { return record<NewsRunConfiguration>(pool, "news_run_configurations", "run_id", runId); },
    async saveRevision(value) { await pool.query("INSERT INTO news_revisions(revision_ref,run_id,round_id,record) VALUES($1,$2,$3,$4) ON CONFLICT(revision_ref) DO UPDATE SET record=EXCLUDED.record", [value.ref, value.runId, value.roundId, value]); },
    async revision(ref) { return record<NewsRevision>(pool, "news_revisions", "revision_ref", ref); },
    async saveBinding(value) { await pool.query("INSERT INTO news_bindings(token_digest,run_id,agent_id,record) VALUES($1,$2,$3,$4) ON CONFLICT(token_digest) DO UPDATE SET record=EXCLUDED.record", [value.tokenDigest, value.runId, value.agentId, value]); },
    async binding(tokenDigest) { return record<NewsBinding>(pool, "news_bindings", "token_digest", tokenDigest); },
    async bindingsForRun(runId) { return (await pool.query<{ record: NewsBinding }>("SELECT record FROM news_bindings WHERE run_id=$1", [runId])).rows.map((row) => row.record); },
    async saveScope(value) { await pool.query("INSERT INTO news_scopes(run_id,agent_id,scope_id,record) VALUES($1,$2,$3,$4) ON CONFLICT(run_id,agent_id) DO UPDATE SET scope_id=EXCLUDED.scope_id,record=EXCLUDED.record", [value.runId, value.agentId, value.scopeId, value]); },
    async scope(runId, agentId) { return (await pool.query<{ record: NewsScope }>("SELECT record FROM news_scopes WHERE run_id=$1 AND agent_id=$2", [runId, agentId])).rows[0]?.record; },
    async deleteScope(runId, agentId, scopeId) { await pool.query(`DELETE FROM news_scopes WHERE run_id=$1 AND agent_id=$2${scopeId ? " AND scope_id=$3" : ""}`, scopeId ? [runId, agentId, scopeId] : [runId, agentId]); },
  };
  return new NewsContextService(store);
}

async function upsert(pool: Pool, table: string, key: string, id: string, value: unknown) { await pool.query(`INSERT INTO ${table}(${key},record) VALUES($1,$2) ON CONFLICT(${key}) DO UPDATE SET record=EXCLUDED.record`, [id, value]); }
async function record<T>(pool: Pool, table: string, key: string, id: string) { return (await pool.query<{ record: T }>(`SELECT record FROM ${table} WHERE ${key}=$1`, [id])).rows[0]?.record; }
async function records<T>(pool: Pool, table: string) { return (await pool.query<{ record: T }>(`SELECT record FROM ${table} ORDER BY 1`)).rows.map((row) => row.record); }
