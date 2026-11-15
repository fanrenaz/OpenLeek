import { clone } from "../application/idempotency";
import { ByteLru, jsonByteSize } from "@openleek/byte-lru";
import {
  emptyFinancialRevisionState,
  type FinancialRevisionRunState,
  type FinancialRevisionState,
  type FinancialRevisionStore,
} from "../application/revision-store";
import type { FinancialRoundWorkspace, StoredFinancialRevision } from "../application/revision-model";
import type { SqlClient } from "./postgres-state-store";

interface LegacyRow extends Record<string, unknown> {
  snapshot: FinancialRevisionState;
}

interface MetaRow extends Record<string, unknown> {
  version: number;
  capabilities: FinancialRevisionState["marketMakerHistoryCapabilities"];
}

interface RunRow extends Record<string, unknown> {
  run_id: string;
  revision_head_ref: string | null;
  mcp: FinancialRevisionRunState["mcp"];
}

interface RevisionRow extends Record<string, unknown> {
  run_id: string;
  revision_ref: string;
  revision: StoredFinancialRevision;
}

interface RevisionV4Row extends Record<string, unknown> {
  run_id: string;
  revision_ref: string;
  header: Omit<StoredFinancialRevision, "snapshot">;
  snapshot?: StoredFinancialRevision["snapshot"];
}

interface WorkspaceRow extends Record<string, unknown> {
  run_id: string;
  round_id: number;
  workspace: FinancialRoundWorkspace;
}
interface IntentRow extends Record<string, unknown> { run_id: string; round_id: number; command_id: string; intent: FinancialRoundWorkspace["intents"][string] }
interface OutboxRow extends Record<string, unknown> { run_id: string; round_id: number; command_id: string; outbox: FinancialRoundWorkspace["outbox"][string] }

/**
 * The v3 store keeps every independently-growing object in its own row. The
 * old singleton remains read-only after migration so a release rollback still
 * has an inspectable source snapshot, but no production mutation rewrites it.
 */
export class PostgresFinancialRevisionStore implements FinancialRevisionStore {
  private readonly serialized = new Map<string, string>();
  private readonly revisionCache: ByteLru<StoredFinancialRevision>;

  constructor(
    private readonly database: SqlClient,
    cacheMaxBytes = readCacheLimit("OPENLEEK_FINANCIAL_REVISION_CACHE_MAX_BYTES", 512 * 1024 * 1024),
  ) {
    this.revisionCache = new ByteLru<StoredFinancialRevision>({ maxBytes: cacheMaxBytes, sizeOf: jsonByteSize });
  }

  async migrate(): Promise<void> {
    for (const statement of CREATE_FINANCIAL_REVISION_V4_SQL) await this.database.query(statement);
    await this.database.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", ["financial-revision-v3"]);
      const marker = await client.query("SELECT 1 AS present FROM financial_revision_migrations WHERE version = 3");
      if (marker.rows[0] === undefined) {
        const legacy = await client.query<LegacyRow>(
          "SELECT snapshot FROM financial_market_revision_state WHERE state_key = $1",
          [LEGACY_STATE_KEY],
        );
        const state = legacy.rows[0]?.snapshot;
        if (state !== undefined) await this.saveStateV3(client, state, false);
        await client.query("INSERT INTO financial_revision_migrations (version) VALUES (3)");
      }
      const v4 = await client.query("SELECT 1 AS present FROM financial_revision_migrations WHERE version = 4");
      if (v4.rows[0] === undefined) {
        await client.query(
          `INSERT INTO financial_revision_headers_v4 (revision_ref, run_id, round_id, kind, header)
           SELECT revision_ref, run_id, round_id, kind, revision - 'snapshot' FROM financial_revisions
           ON CONFLICT (revision_ref) DO NOTHING`,
        );
        await client.query(
          `INSERT INTO financial_revision_snapshots_v4 (revision_ref, snapshot, snapshot_size_bytes)
           SELECT revision_ref, revision->'snapshot',
                  pg_column_size((revision->'snapshot')::jsonb)
           FROM financial_revisions ON CONFLICT (revision_ref) DO NOTHING`,
        );
        await client.query("INSERT INTO financial_revision_migrations (version) VALUES (4)");
      }
      const v5 = await client.query("SELECT 1 AS present FROM financial_revision_migrations WHERE version = 5");
      if (v5.rows[0] === undefined) {
        await client.query(
          `INSERT INTO financial_round_intents (run_id, round_id, command_id, intent)
           SELECT w.run_id, w.round_id, item.key, item.value
           FROM financial_round_workspaces w CROSS JOIN LATERAL jsonb_each(COALESCE(w.workspace->'intents', '{}'::jsonb)) item
           ON CONFLICT (command_id) DO NOTHING`,
        );
        await client.query(
          `INSERT INTO financial_round_outbox (run_id, round_id, command_id, outbox)
           SELECT w.run_id, w.round_id, item.key, item.value
           FROM financial_round_workspaces w CROSS JOIN LATERAL jsonb_each(COALESCE(w.workspace->'outbox', '{}'::jsonb)) item
           ON CONFLICT (command_id) DO NOTHING`,
        );
        await client.query("INSERT INTO financial_revision_migrations (version) VALUES (5)");
      }
      const v6 = await client.query("SELECT 1 AS present FROM financial_revision_migrations WHERE version = 6");
      if (v6.rows[0] === undefined) {
        await client.query(`UPDATE financial_round_intents SET status = COALESCE(intent->>'status', 'pending'), stream_id = intent->>'streamId'`);
        await client.query(`UPDATE financial_round_outbox SET status = COALESCE(outbox->>'status', 'pending'), published_stream_id = outbox->>'publishedStreamId'`);
        await client.query("INSERT INTO financial_revision_migrations (version) VALUES (6)");
      }
    });
    this.serialized.clear();
  }

  async load(): Promise<FinancialRevisionState | undefined> {
    const marker = await this.database.query("SELECT 1 AS present FROM financial_revision_migrations WHERE version = 4");
    if (marker.rows[0] === undefined) {
      const legacy = await this.database.query<LegacyRow>(
        "SELECT snapshot FROM financial_market_revision_state WHERE state_key = $1",
        [LEGACY_STATE_KEY],
      );
      return legacy.rows[0] === undefined ? undefined : clone(legacy.rows[0].snapshot);
    }

    const [metaResult, runResult, revisionResult, workspaceResult, hotRevisionResult, intentResult, outboxResult] = await Promise.all([
      this.database.query<MetaRow>("SELECT version, capabilities FROM financial_revision_meta WHERE singleton = TRUE"),
      this.database.query<RunRow>("SELECT run_id, revision_head_ref, mcp FROM financial_revision_runs"),
      this.database.query<RevisionV4Row>("SELECT run_id, revision_ref, header FROM financial_revision_headers_v4"),
      this.database.query<WorkspaceRow>(
        `SELECT latest.run_id, latest.round_id, latest.workspace
         FROM (
           SELECT DISTINCT ON (run_id) run_id, round_id, workspace
           FROM financial_round_workspaces ORDER BY run_id, round_id DESC
         ) latest
         JOIN financial_revision_runs r ON r.run_id = latest.run_id
         WHERE COALESCE((latest.workspace->>'closed')::boolean, false) = false
            OR latest.workspace->>'candidateRevisionRef' IS DISTINCT FROM r.revision_head_ref`,
      ),
      this.database.query<RevisionV4Row>(
        `WITH latest_workspace AS (
           SELECT DISTINCT ON (run_id) run_id, round_id, workspace
           FROM financial_round_workspaces ORDER BY run_id, round_id DESC
         )
         SELECT h.run_id, h.revision_ref, h.header, s.snapshot
         FROM financial_revision_headers_v4 h
         JOIN financial_revision_snapshots_v4 s USING (revision_ref)
         WHERE h.revision_ref IN (
           SELECT revision_head_ref FROM financial_revision_runs WHERE revision_head_ref IS NOT NULL
           UNION SELECT workspace->>'baseRevisionRef' FROM latest_workspace
             WHERE COALESCE((workspace->>'closed')::boolean, false) = false
           UNION SELECT workspace->>'readRevisionRef' FROM latest_workspace
             WHERE COALESCE((workspace->>'closed')::boolean, false) = false
           UNION SELECT w.workspace->>'candidateRevisionRef'
             FROM latest_workspace w
             JOIN financial_revision_runs r ON r.run_id = w.run_id
             WHERE w.workspace->>'candidateRevisionRef' IS NOT NULL
               AND w.workspace->>'candidateRevisionRef' IS DISTINCT FROM r.revision_head_ref
         )`,
      ),
      this.database.query<IntentRow>(`SELECT i.run_id, i.round_id, i.command_id, i.intent
        FROM financial_round_intents i JOIN financial_round_workspaces w USING (run_id, round_id)
        JOIN financial_revision_runs r USING (run_id)
        WHERE COALESCE((w.workspace->>'closed')::boolean, false) = false
           OR w.workspace->>'candidateRevisionRef' IS DISTINCT FROM r.revision_head_ref
        ORDER BY i.accepted_sequence`),
      this.database.query<OutboxRow>(`SELECT o.run_id, o.round_id, o.command_id, o.outbox
        FROM financial_round_outbox o JOIN financial_round_workspaces w USING (run_id, round_id)
        JOIN financial_revision_runs r USING (run_id)
        WHERE COALESCE((w.workspace->>'closed')::boolean, false) = false
           OR w.workspace->>'candidateRevisionRef' IS DISTINCT FROM r.revision_head_ref`),
    ]);
    if (metaResult.rows[0] === undefined && runResult.rows.length === 0) return undefined;
    const state = emptyFinancialRevisionState();
    state.version = 2;
    state.marketMakerHistoryCapabilities = clone(metaResult.rows[0]?.capabilities ?? {});
    for (const row of runResult.rows) {
      state.runs[row.run_id] = {
        revisions: {},
        ...(row.revision_head_ref === null ? {} : { revisionHeadRef: row.revision_head_ref }),
        roundWorkspaces: {},
        mcp: clone(row.mcp),
      };
      this.remember(`run:${row.run_id}`, {
        revisionHeadRef: row.revision_head_ref,
        mcp: row.mcp,
      });
    }
    for (const row of revisionResult.rows) {
      const run = state.runs[row.run_id];
      if (run === undefined) throw new Error(`Financial revision ${row.revision_ref} has no owning run`);
      run.revisions[row.revision_ref] = clone(row.header) as StoredFinancialRevision;
      this.remember(`revision-header:${row.revision_ref}`, row.header);
    }
    for (const row of hotRevisionResult.rows) {
      const run = state.runs[row.run_id];
      if (run === undefined || row.snapshot === undefined) continue;
      const revision = { ...clone(row.header), snapshot: clone(row.snapshot) } as StoredFinancialRevision;
      run.revisions[row.revision_ref] = revision;
      this.revisionCache.set(row.revision_ref, revision);
    }
    for (const row of workspaceResult.rows) {
      const run = state.runs[row.run_id];
      if (run === undefined) throw new Error(`Financial workspace ${row.run_id}/${row.round_id} has no owning run`);
      run.roundWorkspaces[String(row.round_id)] = clone(row.workspace);
      this.remember(`workspace:${row.run_id}:${row.round_id}`, row.workspace);
    }
    for (const row of intentResult.rows) {
      const workspace = state.runs[row.run_id]?.roundWorkspaces[String(row.round_id)];
      if (workspace !== undefined) {
        workspace.intents[row.command_id] = clone(row.intent);
        this.remember(`intent:${row.command_id}`, row.intent);
      }
    }
    for (const row of outboxResult.rows) {
      const workspace = state.runs[row.run_id]?.roundWorkspaces[String(row.round_id)];
      if (workspace !== undefined) {
        workspace.outbox[row.command_id] = clone(row.outbox);
        this.remember(`outbox:${row.command_id}`, row.outbox);
      }
    }
    this.remember("meta", {
      version: state.version,
      capabilities: state.marketMakerHistoryCapabilities,
    });
    return state;
  }

  async loadRevision(revisionRef: string): Promise<StoredFinancialRevision | undefined> {
    return this.revisionCache.getOrLoad(revisionRef, async () => {
      const result = await this.database.query<RevisionV4Row>(
        `SELECT h.run_id, h.revision_ref, h.header, s.snapshot
         FROM financial_revision_headers_v4 h
         JOIN financial_revision_snapshots_v4 s USING (revision_ref)
         WHERE h.revision_ref = $1`,
        [revisionRef],
      );
      const row = result.rows[0];
      if (row === undefined || row.snapshot === undefined) {
        throw new MissingFinancialRevisionError(revisionRef);
      }
      return { ...clone(row.header), snapshot: clone(row.snapshot) } as StoredFinancialRevision;
    }).catch((error) => {
      if (error instanceof MissingFinancialRevisionError) return undefined;
      throw error;
    });
  }

  async save(state: FinancialRevisionState): Promise<void> {
    try {
      await this.database.transaction((client) => this.saveStateV4(client, state, true));
    } catch (error) {
      this.serialized.clear();
      throw error;
    }
  }

  private async saveStateV4(client: SqlClient, state: FinancialRevisionState, useCache: boolean): Promise<void> {
    const meta = { version: state.version, capabilities: state.marketMakerHistoryCapabilities };
    if (!useCache || this.changed("meta", meta)) {
      await client.query(
        `INSERT INTO financial_revision_meta (singleton, version, capabilities, updated_at)
         VALUES (TRUE, $1, $2::jsonb, now())
         ON CONFLICT (singleton) DO UPDATE
         SET version = EXCLUDED.version, capabilities = EXCLUDED.capabilities, updated_at = now()`,
        [state.version, JSON.stringify(state.marketMakerHistoryCapabilities)],
      );
    }
    for (const [runId, run] of Object.entries(state.runs)) {
      const runMeta = { revisionHeadRef: run.revisionHeadRef ?? null, mcp: run.mcp };
      if (!useCache || this.changed(`run:${runId}`, runMeta)) {
        await client.query(
          `INSERT INTO financial_revision_runs (run_id, revision_head_ref, mcp, updated_at)
           VALUES ($1, $2, $3::jsonb, now())
           ON CONFLICT (run_id) DO UPDATE
           SET revision_head_ref = EXCLUDED.revision_head_ref, mcp = EXCLUDED.mcp, updated_at = now()`,
          [runId, run.revisionHeadRef ?? null, JSON.stringify(run.mcp)],
        );
      }
      for (const [revisionRef, revision] of Object.entries(run.revisions)) {
        if (revision.snapshot === undefined) continue;
        const { snapshot, ...header } = revision;
        if (useCache && !this.changed(`revision-header:${revisionRef}`, header)) continue;
        await client.query(
          `INSERT INTO financial_revision_headers_v4 (revision_ref, run_id, round_id, kind, header)
           VALUES ($1, $2, $3, $4, $5::jsonb)
           ON CONFLICT (revision_ref) DO NOTHING`,
          [revisionRef, runId, revision.roundId, revision.kind, JSON.stringify(header)],
        );
        await client.query(
          `INSERT INTO financial_revision_snapshots_v4 (revision_ref, snapshot, snapshot_size_bytes)
           VALUES ($1, $2::jsonb, $3) ON CONFLICT (revision_ref) DO NOTHING`,
          [revisionRef, JSON.stringify(snapshot), jsonByteSize(snapshot)],
        );
        this.revisionCache.set(revisionRef, revision);
      }
      for (const [roundKey, workspace] of Object.entries(run.roundWorkspaces)) {
        const persistedWorkspace = compactWorkspace(workspace);
        const intents = persistedWorkspace.intents;
        const outbox = persistedWorkspace.outbox;
        persistedWorkspace.intents = {};
        persistedWorkspace.outbox = {};
        if (!useCache || this.changed(`workspace:${runId}:${roundKey}`, persistedWorkspace)) {
          await client.query(
            `INSERT INTO financial_round_workspaces (run_id, round_id, workspace, last_applied_stream_id, updated_at)
             VALUES ($1, $2, $3::jsonb, $4, now())
             ON CONFLICT (run_id, round_id) DO UPDATE SET
               workspace = EXCLUDED.workspace,
               last_applied_stream_id = EXCLUDED.last_applied_stream_id,
               updated_at = now()
             WHERE financial_round_workspaces.last_applied_stream_id IS NULL
                OR (EXCLUDED.last_applied_stream_id IS NOT NULL AND openleek_stream_id_gte(EXCLUDED.last_applied_stream_id, financial_round_workspaces.last_applied_stream_id))`,
            [runId, Number(roundKey), JSON.stringify(persistedWorkspace), persistedWorkspace.lastAppliedStreamId ?? null],
          );
        }
        for (const [commandId, intent] of Object.entries(intents)) {
          if (useCache && !this.changed(`intent:${commandId}`, intent)) continue;
          await client.query(
            `INSERT INTO financial_round_intents (run_id, round_id, command_id, intent, status, stream_id, delivered_at, terminal_at)
             VALUES ($1, $2, $3, $4::jsonb, $5, $6, CASE WHEN $6::text IS NULL THEN NULL ELSE now() END,
                     CASE WHEN $5::text IN ('applied','rejected','discarded') THEN now() ELSE NULL END)
             ON CONFLICT (command_id) DO UPDATE SET
               intent = EXCLUDED.intent,
               status = EXCLUDED.status,
               stream_id = COALESCE(financial_round_intents.stream_id, EXCLUDED.stream_id),
               delivered_at = COALESCE(financial_round_intents.delivered_at, EXCLUDED.delivered_at),
               terminal_at = COALESCE(financial_round_intents.terminal_at, EXCLUDED.terminal_at)
             WHERE openleek_intent_status_rank(EXCLUDED.status) >= openleek_intent_status_rank(financial_round_intents.status)
               AND (openleek_intent_status_rank(financial_round_intents.status) < 1 OR EXCLUDED.status = financial_round_intents.status)`,
            [runId, Number(roundKey), commandId, JSON.stringify(intent), intent.status, intent.streamId ?? null],
          );
        }
        for (const [commandId, record] of Object.entries(outbox)) {
          if (useCache && !this.changed(`outbox:${commandId}`, record)) continue;
          await client.query(
            `INSERT INTO financial_round_outbox (run_id, round_id, command_id, outbox, status, published_stream_id, published_at)
             VALUES ($1, $2, $3, $4::jsonb, $5, $6, CASE WHEN $6::text IS NULL THEN NULL ELSE now() END)
             ON CONFLICT (command_id) DO UPDATE SET
               outbox = EXCLUDED.outbox,
               status = EXCLUDED.status,
               published_stream_id = COALESCE(financial_round_outbox.published_stream_id, EXCLUDED.published_stream_id),
               published_at = COALESCE(financial_round_outbox.published_at, EXCLUDED.published_at)
             WHERE openleek_outbox_status_rank(EXCLUDED.status) >= openleek_outbox_status_rank(financial_round_outbox.status)`,
            [runId, Number(roundKey), commandId, JSON.stringify(record), record.status, record.publishedStreamId ?? null],
          );
        }
      }
    }
  }

  private async saveStateV3(client: SqlClient, state: FinancialRevisionState, useCache: boolean): Promise<void> {
    const meta = { version: state.version, capabilities: state.marketMakerHistoryCapabilities };
    if (!useCache || this.changed("meta", meta)) {
      await client.query(
        `INSERT INTO financial_revision_meta (singleton, version, capabilities, updated_at)
         VALUES (TRUE, $1, $2::jsonb, now())
         ON CONFLICT (singleton) DO UPDATE
         SET version = EXCLUDED.version, capabilities = EXCLUDED.capabilities, updated_at = now()`,
        [state.version, JSON.stringify(state.marketMakerHistoryCapabilities)],
      );
    }
    for (const [runId, run] of Object.entries(state.runs)) {
      await client.query(
        `INSERT INTO financial_revision_runs (run_id, revision_head_ref, mcp, updated_at)
         VALUES ($1, $2, $3::jsonb, now()) ON CONFLICT (run_id) DO UPDATE
         SET revision_head_ref=EXCLUDED.revision_head_ref, mcp=EXCLUDED.mcp, updated_at=now()`,
        [runId, run.revisionHeadRef ?? null, JSON.stringify(run.mcp)],
      );
      for (const revision of Object.values(run.revisions)) {
        await client.query(
          `INSERT INTO financial_revisions (revision_ref, run_id, round_id, kind, revision)
           VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (revision_ref) DO NOTHING`,
          [revision.ref, runId, revision.roundId, revision.kind, JSON.stringify(revision)],
        );
      }
      for (const [roundKey, workspace] of Object.entries(run.roundWorkspaces)) {
        await client.query(
          `INSERT INTO financial_round_workspaces (run_id, round_id, workspace, updated_at)
           VALUES ($1,$2,$3::jsonb,now()) ON CONFLICT (run_id,round_id) DO UPDATE
           SET workspace=EXCLUDED.workspace, updated_at=now()`,
          [runId, Number(roundKey), JSON.stringify(compactWorkspace(workspace))],
        );
      }
    }
  }

  private changed(key: string, value: unknown): boolean {
    const next = JSON.stringify(value);
    if (this.serialized.get(key) === next) return false;
    this.serialized.set(key, next);
    return true;
  }

  private remember(key: string, value: unknown): void {
    this.serialized.set(key, JSON.stringify(value));
  }
}

function compactWorkspace(workspace: FinancialRoundWorkspace): FinancialRoundWorkspace {
  const persisted = clone(workspace);
  if (persisted.closed && persisted.candidateRevisionRef !== undefined) delete persisted.provisionalSnapshot;
  return persisted;
}

const LEGACY_STATE_KEY = "current";

export const CREATE_FINANCIAL_REVISION_V3_SQL = [
  `CREATE TABLE IF NOT EXISTS financial_market_revision_state (
     state_key text PRIMARY KEY,
     snapshot jsonb NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS financial_revision_migrations (
     version integer PRIMARY KEY,
     migrated_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS financial_revision_meta (
     singleton boolean PRIMARY KEY DEFAULT TRUE CHECK (singleton),
     version integer NOT NULL,
     capabilities jsonb NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS financial_revision_runs (
     run_id text PRIMARY KEY,
     revision_head_ref text,
     mcp jsonb NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS financial_revisions (
     revision_ref text PRIMARY KEY,
     run_id text NOT NULL REFERENCES financial_revision_runs(run_id) ON DELETE RESTRICT,
     round_id integer NOT NULL,
     kind text NOT NULL,
     revision jsonb NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS financial_revisions_run_round_idx
     ON financial_revisions(run_id, round_id, revision_ref)`,
  `CREATE TABLE IF NOT EXISTS financial_round_workspaces (
     run_id text NOT NULL REFERENCES financial_revision_runs(run_id) ON DELETE RESTRICT,
     round_id integer NOT NULL,
     workspace jsonb NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (run_id, round_id)
   )`,
] as const;

export const CREATE_FINANCIAL_REVISION_V4_SQL = [
  ...CREATE_FINANCIAL_REVISION_V3_SQL,
  `CREATE TABLE IF NOT EXISTS financial_revision_headers_v4 (
     revision_ref text PRIMARY KEY,
     run_id text NOT NULL REFERENCES financial_revision_runs(run_id) ON DELETE RESTRICT,
     round_id integer NOT NULL,
     kind text NOT NULL,
     header jsonb NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS financial_revision_headers_v4_run_round_idx
     ON financial_revision_headers_v4(run_id, round_id, revision_ref)`,
  `CREATE TABLE IF NOT EXISTS financial_revision_snapshots_v4 (
     revision_ref text PRIMARY KEY REFERENCES financial_revision_headers_v4(revision_ref) ON DELETE RESTRICT,
     snapshot jsonb NOT NULL,
     snapshot_size_bytes bigint NOT NULL CHECK (snapshot_size_bytes >= 0)
   )`,
  `CREATE TABLE IF NOT EXISTS financial_round_intents (
     accepted_sequence bigserial UNIQUE,
     run_id text NOT NULL,
     round_id integer NOT NULL,
     command_id text PRIMARY KEY,
     intent jsonb NOT NULL,
     FOREIGN KEY (run_id, round_id) REFERENCES financial_round_workspaces(run_id, round_id) ON DELETE RESTRICT
   )`,
  `CREATE INDEX IF NOT EXISTS financial_round_intents_round_order_idx
     ON financial_round_intents(run_id, round_id, accepted_sequence)`,
  `CREATE TABLE IF NOT EXISTS financial_round_outbox (
     run_id text NOT NULL,
     round_id integer NOT NULL,
     command_id text PRIMARY KEY,
     outbox jsonb NOT NULL,
     FOREIGN KEY (run_id, round_id) REFERENCES financial_round_workspaces(run_id, round_id) ON DELETE RESTRICT
   )`,
  `ALTER TABLE financial_round_workspaces ADD COLUMN IF NOT EXISTS last_applied_stream_id text`,
  `ALTER TABLE financial_round_intents ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending'`,
  `ALTER TABLE financial_round_intents ADD COLUMN IF NOT EXISTS stream_id text`,
  `ALTER TABLE financial_round_intents ADD COLUMN IF NOT EXISTS delivered_at timestamptz`,
  `ALTER TABLE financial_round_intents ADD COLUMN IF NOT EXISTS terminal_at timestamptz`,
  `ALTER TABLE financial_round_outbox ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending'`,
  `ALTER TABLE financial_round_outbox ADD COLUMN IF NOT EXISTS published_stream_id text`,
  `ALTER TABLE financial_round_outbox ADD COLUMN IF NOT EXISTS published_at timestamptz`,
  `ALTER TABLE financial_round_outbox ADD COLUMN IF NOT EXISTS last_publish_attempt_at timestamptz`,
  `ALTER TABLE financial_round_outbox ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0`,
  `ALTER TABLE financial_round_outbox ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now()`,
  `CREATE TABLE IF NOT EXISTS financial_stream_partitions (
     run_id text NOT NULL,
     round_id integer NOT NULL,
     stream_key text NOT NULL UNIQUE,
     lease_owner text,
     lease_expires_at timestamptz,
     last_reconciled_at timestamptz,
     PRIMARY KEY (run_id, round_id)
   )`,
  `CREATE OR REPLACE FUNCTION openleek_intent_status_rank(value text) RETURNS integer IMMUTABLE LANGUAGE sql AS $$
     SELECT CASE value WHEN 'pending' THEN 0 WHEN 'applied' THEN 1 WHEN 'rejected' THEN 1 WHEN 'discarded' THEN 1 ELSE -1 END
   $$`,
  `CREATE OR REPLACE FUNCTION openleek_outbox_status_rank(value text) RETURNS integer IMMUTABLE LANGUAGE sql AS $$
     SELECT CASE value WHEN 'pending' THEN 0 WHEN 'published' THEN 1 WHEN 'applied' THEN 2 ELSE -1 END
   $$`,
  `CREATE OR REPLACE FUNCTION openleek_stream_id_gte(candidate text, current_value text) RETURNS boolean IMMUTABLE LANGUAGE sql AS $$
     SELECT (split_part(candidate, '-', 1)::numeric, split_part(candidate, '-', 2)::numeric)
         >= (split_part(current_value, '-', 1)::numeric, split_part(current_value, '-', 2)::numeric)
   $$`,
  `CREATE OR REPLACE FUNCTION financial_reject_terminal_regression() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN
       IF openleek_intent_status_rank(OLD.status) > openleek_intent_status_rank(NEW.status)
          OR (openleek_intent_status_rank(OLD.status) = 1 AND NEW.status <> OLD.status) THEN
         RAISE EXCEPTION 'financial intent terminal status cannot regress';
       END IF;
       RETURN NEW;
     END
   $$`,
  `DROP TRIGGER IF EXISTS financial_intent_terminal_guard ON financial_round_intents`,
  `CREATE TRIGGER financial_intent_terminal_guard BEFORE UPDATE ON financial_round_intents
     FOR EACH ROW EXECUTE FUNCTION financial_reject_terminal_regression()`,
  `CREATE OR REPLACE FUNCTION financial_reject_outbox_regression() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN
       IF openleek_outbox_status_rank(OLD.status) > openleek_outbox_status_rank(NEW.status) THEN
         RAISE EXCEPTION 'financial outbox status cannot regress';
       END IF;
       RETURN NEW;
     END
   $$`,
  `DROP TRIGGER IF EXISTS financial_outbox_terminal_guard ON financial_round_outbox`,
  `CREATE TRIGGER financial_outbox_terminal_guard BEFORE UPDATE ON financial_round_outbox
     FOR EACH ROW EXECUTE FUNCTION financial_reject_outbox_regression()`,
  `CREATE INDEX IF NOT EXISTS financial_round_outbox_publish_idx
     ON financial_round_outbox(status, next_attempt_at, run_id, round_id)`,
] as const;

class MissingFinancialRevisionError extends Error {}

function readCacheLimit(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
  return value;
}
