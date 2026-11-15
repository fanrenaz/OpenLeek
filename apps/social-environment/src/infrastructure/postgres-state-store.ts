import {
  emptySocialState,
  type IdempotencyRecord,
  type SocialRunState,
  type SocialState,
  type SocialStateStore,
} from "../application/state-store";
import type {
  SocialFeedAlgorithmHistoryCapability,
  SocialRoundWorkspace,
  StoredSocialRevision,
} from "../application/revision-model";
import type { AssetTombstone } from "@openleek/contracts/assets";
import { ByteLru, jsonByteSize } from "@openleek/byte-lru";

export interface SqlQueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  rows: Row[];
}

export interface SqlQueryClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlQueryResult<Row>>;
  transaction<T>(operation: (client: SqlQueryClient) => Promise<T>): Promise<T>;
}

interface LegacyRow extends Record<string, unknown> { state: SocialState }
interface MetaRow extends Record<string, unknown> { version: number }
interface RunRow extends Record<string, unknown> { run_id: string; run_state: Omit<SocialRunState, "revisions" | "roundWorkspaces"> }
interface RevisionRow extends Record<string, unknown> { run_id: string; revision_ref: string; revision: StoredSocialRevision }
interface RevisionV4Row extends Record<string, unknown> {
  run_id: string;
  revision_ref: string;
  header: Omit<StoredSocialRevision, "snapshot">;
  snapshot?: StoredSocialRevision["snapshot"];
}
interface WorkspaceRow extends Record<string, unknown> { run_id: string; round_id: number; workspace: SocialRoundWorkspace }
interface IntentRow extends Record<string, unknown> { run_id: string; round_id: number; command_id: string; intent: SocialRoundWorkspace["intents"][string] }
interface OutboxRow extends Record<string, unknown> { run_id: string; round_id: number; command_id: string; outbox: SocialRoundWorkspace["outbox"][string] }
interface IdempotencyRow extends Record<string, unknown> { receipt_key: string; receipt: IdempotencyRecord }
interface CapabilityRow extends Record<string, unknown> { capability_key: string; capability: SocialFeedAlgorithmHistoryCapability }
interface RegistryRow extends Record<string, unknown> { registry_kind: "algorithm" | "network"; target: "draft" | "version"; asset_key: string; payload: unknown }
interface TombstoneRow extends Record<string, unknown> { registry_kind: "algorithm" | "network"; tombstone: AssetTombstone }

/** Normalized v3 Social owner store; the v2 singleton is retained read-only. */
export class PostgresSocialStateStore implements SocialStateStore {
  private readonly serialized = new Map<string, string>();
  private readonly revisionCache: ByteLru<StoredSocialRevision>;

  constructor(
    private readonly client: SqlQueryClient,
    cacheMaxBytes = readCacheLimit("OPENLEEK_SOCIAL_REVISION_CACHE_MAX_BYTES", 256 * 1024 * 1024),
  ) {
    this.revisionCache = new ByteLru<StoredSocialRevision>({ maxBytes: cacheMaxBytes, sizeOf: jsonByteSize });
  }

  async initialise(): Promise<void> {
    for (const statement of POSTGRES_SOCIAL_MIGRATION_V4) await this.client.query(statement);
    await this.client.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", ["social-state-v3"]);
      const marker = await client.query("SELECT 1 AS present FROM social_state_migrations WHERE version = 3");
      if (marker.rows[0] === undefined) {
        const legacy = await client.query<LegacyRow>("SELECT state FROM social_environment_state WHERE singleton = TRUE");
        if (legacy.rows[0] !== undefined) await this.saveStateV3(client, legacy.rows[0].state, false);
        await client.query("INSERT INTO social_state_migrations (version) VALUES (3)");
      }
      const v4 = await client.query("SELECT 1 AS present FROM social_state_migrations WHERE version = 4");
      if (v4.rows[0] === undefined) {
        await client.query(
          `INSERT INTO social_revision_headers_v4 (revision_ref, run_id, round_id, kind, header)
           SELECT revision_ref, run_id, round_id, kind, revision - 'snapshot' FROM social_revisions
           ON CONFLICT (revision_ref) DO NOTHING`,
        );
        await client.query(
          `INSERT INTO social_revision_snapshots_v4 (revision_ref, snapshot, snapshot_size_bytes)
           SELECT revision_ref, revision->'snapshot', pg_column_size((revision->'snapshot')::jsonb)
           FROM social_revisions ON CONFLICT (revision_ref) DO NOTHING`,
        );
        await client.query("INSERT INTO social_state_migrations (version) VALUES (4)");
      }
      const v5 = await client.query("SELECT 1 AS present FROM social_state_migrations WHERE version = 5");
      if (v5.rows[0] === undefined) {
        await client.query(
          `INSERT INTO social_round_intents (run_id, round_id, command_id, intent)
           SELECT w.run_id, w.round_id, item.key, item.value
           FROM social_round_workspaces w CROSS JOIN LATERAL jsonb_each(COALESCE(w.workspace->'intents', '{}'::jsonb)) item
           ON CONFLICT (command_id) DO NOTHING`,
        );
        await client.query(
          `INSERT INTO social_round_outbox (run_id, round_id, command_id, outbox)
           SELECT w.run_id, w.round_id, item.key, item.value
           FROM social_round_workspaces w CROSS JOIN LATERAL jsonb_each(COALESCE(w.workspace->'outbox', '{}'::jsonb)) item
           ON CONFLICT (command_id) DO NOTHING`,
        );
        await client.query("INSERT INTO social_state_migrations (version) VALUES (5)");
      }
      const v6 = await client.query("SELECT 1 AS present FROM social_state_migrations WHERE version = 6");
      if (v6.rows[0] === undefined) {
        await client.query(`UPDATE social_round_intents SET status = COALESCE(intent->>'status', 'pending'), stream_id = intent->>'streamId'`);
        await client.query(`UPDATE social_round_outbox SET status = COALESCE(outbox->>'status', 'pending'), published_stream_id = outbox->>'publishedStreamId'`);
        await client.query("INSERT INTO social_state_migrations (version) VALUES (6)");
      }
    });
    this.serialized.clear();
  }

  async load(): Promise<SocialState | null> {
    const marker = await this.client.query("SELECT 1 AS present FROM social_state_migrations WHERE version = 4");
    if (marker.rows[0] === undefined) {
      const legacy = await this.client.query<LegacyRow>("SELECT state FROM social_environment_state WHERE singleton = TRUE");
      return legacy.rows[0]?.state ?? null;
    }
    const [meta, runs, revisions, workspaces, hotRevisions, receipts, capabilities, registry, tombstones, intents, outbox] = await Promise.all([
      this.client.query<MetaRow>("SELECT version FROM social_state_meta WHERE singleton = TRUE"),
      this.client.query<RunRow>("SELECT run_id, run_state FROM social_runs"),
      this.client.query<RevisionV4Row>("SELECT run_id, revision_ref, header FROM social_revision_headers_v4"),
      this.client.query<WorkspaceRow>(
        `SELECT latest.run_id, latest.round_id, latest.workspace
         FROM (
           SELECT DISTINCT ON (run_id) run_id, round_id, workspace
           FROM social_round_workspaces ORDER BY run_id, round_id DESC
         ) latest
         JOIN social_runs r ON r.run_id = latest.run_id
         WHERE COALESCE((latest.workspace->>'closed')::boolean, false) = false
            OR latest.workspace->>'candidateRevisionRef' IS DISTINCT FROM r.run_state->>'revisionHeadRef'`,
      ),
      this.client.query<RevisionV4Row>(
        `WITH latest_workspace AS (
           SELECT DISTINCT ON (run_id) run_id, round_id, workspace
           FROM social_round_workspaces ORDER BY run_id, round_id DESC
         )
         SELECT h.run_id, h.revision_ref, h.header, s.snapshot
         FROM social_revision_headers_v4 h JOIN social_revision_snapshots_v4 s USING (revision_ref)
         WHERE h.revision_ref IN (
           SELECT run_state->>'revisionHeadRef' FROM social_runs
           UNION SELECT workspace->>'baseRevisionRef' FROM latest_workspace
             WHERE COALESCE((workspace->>'closed')::boolean, false) = false
           UNION SELECT workspace->>'readRevisionRef' FROM latest_workspace
             WHERE COALESCE((workspace->>'closed')::boolean, false) = false
           UNION SELECT w.workspace->>'candidateRevisionRef' FROM latest_workspace w
             JOIN social_runs r ON r.run_id = w.run_id
             WHERE w.workspace->>'candidateRevisionRef' IS NOT NULL
               AND w.workspace->>'candidateRevisionRef' IS DISTINCT FROM r.run_state->>'revisionHeadRef'
         )`,
      ),
      this.client.query<IdempotencyRow>("SELECT receipt_key, receipt FROM social_idempotency"),
      this.client.query<CapabilityRow>("SELECT capability_key, capability FROM social_feed_history_capabilities"),
      this.client.query<RegistryRow>("SELECT registry_kind, target, asset_key, payload FROM social_registry_entries"),
      this.client.query<TombstoneRow>("SELECT registry_kind, tombstone FROM social_registry_tombstones ORDER BY registry_kind, sequence"),
      this.client.query<IntentRow>(`SELECT i.run_id, i.round_id, i.command_id, i.intent
        FROM social_round_intents i JOIN social_round_workspaces w USING (run_id, round_id)
        JOIN social_runs r USING (run_id)
        WHERE COALESCE((w.workspace->>'closed')::boolean, false) = false
           OR w.workspace->>'candidateRevisionRef' IS DISTINCT FROM r.run_state->>'revisionHeadRef'
        ORDER BY i.accepted_sequence`),
      this.client.query<OutboxRow>(`SELECT o.run_id, o.round_id, o.command_id, o.outbox
        FROM social_round_outbox o JOIN social_round_workspaces w USING (run_id, round_id)
        JOIN social_runs r USING (run_id)
        WHERE COALESCE((w.workspace->>'closed')::boolean, false) = false
           OR w.workspace->>'candidateRevisionRef' IS DISTINCT FROM r.run_state->>'revisionHeadRef'`),
    ]);
    if (meta.rows[0] === undefined && runs.rows.length === 0) return null;
    const state = emptySocialState();
    for (const row of runs.rows) {
      state.runs[row.run_id] = {
        ...clone(row.run_state),
        revisions: {},
        roundWorkspaces: {},
      };
      this.remember(`run:${row.run_id}`, row.run_state);
    }
    for (const row of revisions.rows) {
      const run = state.runs[row.run_id];
      if (run === undefined) throw new Error(`Social revision ${row.revision_ref} has no owning run`);
      run.revisions[row.revision_ref] = clone(row.header) as StoredSocialRevision;
      this.remember(`revision-header:${row.revision_ref}`, row.header);
    }
    for (const row of hotRevisions.rows) {
      const run = state.runs[row.run_id];
      if (run === undefined || row.snapshot === undefined) continue;
      const revision = { ...clone(row.header), snapshot: clone(row.snapshot) } as StoredSocialRevision;
      run.revisions[row.revision_ref] = revision;
      this.revisionCache.set(row.revision_ref, revision);
    }
    for (const row of workspaces.rows) {
      const run = state.runs[row.run_id];
      if (run === undefined) throw new Error(`Social workspace ${row.run_id}/${row.round_id} has no owning run`);
      run.roundWorkspaces[String(row.round_id)] = clone(row.workspace);
      this.remember(`workspace:${row.run_id}:${row.round_id}`, row.workspace);
    }
    for (const row of intents.rows) {
      const workspace = state.runs[row.run_id]?.roundWorkspaces[String(row.round_id)];
      if (workspace !== undefined) {
        workspace.intents[row.command_id] = clone(row.intent);
        this.remember(`intent:${row.command_id}`, row.intent);
      }
    }
    for (const row of outbox.rows) {
      const workspace = state.runs[row.run_id]?.roundWorkspaces[String(row.round_id)];
      if (workspace !== undefined) {
        workspace.outbox[row.command_id] = clone(row.outbox);
        this.remember(`outbox:${row.command_id}`, row.outbox);
      }
    }
    for (const row of receipts.rows) {
      state.idempotency[row.receipt_key] = clone(row.receipt);
      this.remember(`receipt:${row.receipt_key}`, row.receipt);
    }
    for (const row of capabilities.rows) state.feedAlgorithmHistoryCapabilities[row.capability_key] = clone(row.capability);
    for (const row of registry.rows) {
      const target = row.target === "draft" ? "drafts" : "versions";
      const destination = row.registry_kind === "algorithm" ? state.algorithmRegistry : state.networkRegistry;
      (destination[target] as Record<string, unknown>)[row.asset_key] = clone(row.payload);
      this.remember(`registry:${row.registry_kind}:${row.target}:${row.asset_key}`, row.payload);
    }
    for (const row of tombstones.rows) {
      const destination = row.registry_kind === "algorithm" ? state.algorithmRegistry : state.networkRegistry;
      (destination.tombstones ??= []).push(clone(row.tombstone));
      this.remember(`tombstone:${row.registry_kind}:${row.tombstone.idempotencyKey}`, row.tombstone);
    }
    this.remember("meta", { version: state.version });
    return state;
  }

  async loadRevision(revisionRef: string): Promise<StoredSocialRevision | undefined> {
    return this.revisionCache.getOrLoad(revisionRef, async () => {
      const result = await this.client.query<RevisionV4Row>(
        `SELECT h.run_id, h.revision_ref, h.header, s.snapshot
         FROM social_revision_headers_v4 h JOIN social_revision_snapshots_v4 s USING (revision_ref)
         WHERE h.revision_ref = $1`,
        [revisionRef],
      );
      const row = result.rows[0];
      if (row === undefined || row.snapshot === undefined) throw new MissingSocialRevisionError(revisionRef);
      return { ...clone(row.header), snapshot: clone(row.snapshot) } as StoredSocialRevision;
    }).catch((error) => {
      if (error instanceof MissingSocialRevisionError) return undefined;
      throw error;
    });
  }

  async save(state: SocialState): Promise<void> {
    try {
      await this.client.transaction((client) => this.saveStateV4(client, state, true));
    } catch (error) {
      this.serialized.clear();
      throw error;
    }
  }

  private async saveStateV4(client: SqlQueryClient, state: SocialState, useCache: boolean): Promise<void> {
    if (!useCache || this.changed("meta", { version: state.version })) {
      await client.query(
        `INSERT INTO social_state_meta (singleton, version, updated_at) VALUES (TRUE, $1, now())
         ON CONFLICT (singleton) DO UPDATE SET version = EXCLUDED.version, updated_at = now()`,
        [state.version],
      );
    }
    for (const [runId, run] of Object.entries(state.runs)) {
      const runState = clone(run) as SocialRunState;
      delete (runState as Partial<SocialRunState>).revisions;
      delete (runState as Partial<SocialRunState>).roundWorkspaces;
      if (!useCache || this.changed(`run:${runId}`, runState)) {
        await client.query(
          `INSERT INTO social_runs (run_id, run_state, updated_at) VALUES ($1, $2::jsonb, now())
           ON CONFLICT (run_id) DO UPDATE SET run_state = EXCLUDED.run_state, updated_at = now()`,
          [runId, JSON.stringify(runState)],
        );
      }
      for (const [revisionRef, revision] of Object.entries(run.revisions)) {
        if (revision.snapshot === undefined) continue;
        const { snapshot, ...header } = revision;
        if (useCache && !this.changed(`revision-header:${revisionRef}`, header)) continue;
        await client.query(
          `INSERT INTO social_revision_headers_v4 (revision_ref, run_id, round_id, kind, header)
           VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (revision_ref) DO NOTHING`,
          [revisionRef, runId, revision.roundId, revision.kind, JSON.stringify(header)],
        );
        await client.query(
          `INSERT INTO social_revision_snapshots_v4 (revision_ref, snapshot, snapshot_size_bytes)
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
            `INSERT INTO social_round_workspaces (run_id, round_id, workspace, last_applied_stream_id, updated_at)
             VALUES ($1, $2, $3::jsonb, $4, now())
             ON CONFLICT (run_id, round_id) DO UPDATE SET
               workspace = EXCLUDED.workspace,
               last_applied_stream_id = EXCLUDED.last_applied_stream_id,
               updated_at = now()
             WHERE social_round_workspaces.last_applied_stream_id IS NULL
                OR (EXCLUDED.last_applied_stream_id IS NOT NULL AND openleek_stream_id_gte(EXCLUDED.last_applied_stream_id, social_round_workspaces.last_applied_stream_id))`,
            [runId, Number(roundKey), JSON.stringify(persistedWorkspace), persistedWorkspace.lastAppliedStreamId ?? null],
          );
        }
        for (const [commandId, intent] of Object.entries(intents)) {
          if (useCache && !this.changed(`intent:${commandId}`, intent)) continue;
          await client.query(
            `INSERT INTO social_round_intents (run_id, round_id, command_id, intent, status, stream_id, delivered_at, terminal_at)
             VALUES ($1, $2, $3, $4::jsonb, $5, $6, CASE WHEN $6::text IS NULL THEN NULL ELSE now() END,
                     CASE WHEN $5::text IN ('applied','rejected','discarded') THEN now() ELSE NULL END)
             ON CONFLICT (command_id) DO UPDATE SET
               intent = EXCLUDED.intent,
               status = EXCLUDED.status,
               stream_id = COALESCE(social_round_intents.stream_id, EXCLUDED.stream_id),
               delivered_at = COALESCE(social_round_intents.delivered_at, EXCLUDED.delivered_at),
               terminal_at = COALESCE(social_round_intents.terminal_at, EXCLUDED.terminal_at)
             WHERE openleek_intent_status_rank(EXCLUDED.status) >= openleek_intent_status_rank(social_round_intents.status)
               AND (openleek_intent_status_rank(social_round_intents.status) < 1 OR EXCLUDED.status = social_round_intents.status)`,
            [runId, Number(roundKey), commandId, JSON.stringify(intent), intent.status, intent.streamId ?? null],
          );
        }
        for (const [commandId, record] of Object.entries(outbox)) {
          if (useCache && !this.changed(`outbox:${commandId}`, record)) continue;
          await client.query(
            `INSERT INTO social_round_outbox (run_id, round_id, command_id, outbox, status, published_stream_id, published_at)
             VALUES ($1, $2, $3, $4::jsonb, $5, $6, CASE WHEN $6::text IS NULL THEN NULL ELSE now() END)
             ON CONFLICT (command_id) DO UPDATE SET
               outbox = EXCLUDED.outbox,
               status = EXCLUDED.status,
               published_stream_id = COALESCE(social_round_outbox.published_stream_id, EXCLUDED.published_stream_id),
               published_at = COALESCE(social_round_outbox.published_at, EXCLUDED.published_at)
             WHERE openleek_outbox_status_rank(EXCLUDED.status) >= openleek_outbox_status_rank(social_round_outbox.status)`,
            [runId, Number(roundKey), commandId, JSON.stringify(record), record.status, record.publishedStreamId ?? null],
          );
        }
      }
    }
    for (const [key, receipt] of Object.entries(state.idempotency)) {
      if (useCache && !this.changed(`receipt:${key}`, receipt)) continue;
      await client.query(
        `INSERT INTO social_idempotency (receipt_key, receipt) VALUES ($1, $2::jsonb)
         ON CONFLICT (receipt_key) DO NOTHING`,
        [key, JSON.stringify(receipt)],
      );
    }
    await client.query("DELETE FROM social_feed_history_capabilities");
    for (const [key, capability] of Object.entries(state.feedAlgorithmHistoryCapabilities)) {
      await client.query(
        "INSERT INTO social_feed_history_capabilities (capability_key, capability) VALUES ($1, $2::jsonb)",
        [key, JSON.stringify(capability)],
      );
    }
    await this.saveRegistry(client, "algorithm", state.algorithmRegistry, useCache);
    await this.saveRegistry(client, "network", state.networkRegistry, useCache);
  }

  private async saveStateV3(client: SqlQueryClient, state: SocialState, useCache: boolean): Promise<void> {
    await client.query(
      `INSERT INTO social_state_meta (singleton, version, updated_at) VALUES (TRUE, $1, now())
       ON CONFLICT (singleton) DO UPDATE SET version=EXCLUDED.version, updated_at=now()`,
      [state.version],
    );
    for (const [runId, run] of Object.entries(state.runs)) {
      const runState = clone(run) as SocialRunState;
      delete (runState as Partial<SocialRunState>).revisions;
      delete (runState as Partial<SocialRunState>).roundWorkspaces;
      await client.query(
        `INSERT INTO social_runs (run_id, run_state, updated_at) VALUES ($1,$2::jsonb,now())
         ON CONFLICT (run_id) DO UPDATE SET run_state=EXCLUDED.run_state, updated_at=now()`,
        [runId, JSON.stringify(runState)],
      );
      for (const revision of Object.values(run.revisions)) {
        await client.query(
          `INSERT INTO social_revisions (revision_ref,run_id,round_id,kind,revision)
           VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (revision_ref) DO NOTHING`,
          [revision.ref, runId, revision.roundId, revision.kind, JSON.stringify(revision)],
        );
      }
      for (const [roundKey, workspace] of Object.entries(run.roundWorkspaces)) {
        await client.query(
          `INSERT INTO social_round_workspaces (run_id,round_id,workspace,updated_at)
           VALUES ($1,$2,$3::jsonb,now()) ON CONFLICT (run_id,round_id) DO UPDATE
           SET workspace=EXCLUDED.workspace, updated_at=now()`,
          [runId, Number(roundKey), JSON.stringify(compactWorkspace(workspace))],
        );
      }
    }
    for (const [key, receipt] of Object.entries(state.idempotency)) {
      await client.query(
        `INSERT INTO social_idempotency (receipt_key,receipt) VALUES ($1,$2::jsonb)
         ON CONFLICT (receipt_key) DO NOTHING`,
        [key, JSON.stringify(receipt)],
      );
    }
    await this.saveRegistry(client, "algorithm", state.algorithmRegistry, useCache);
    await this.saveRegistry(client, "network", state.networkRegistry, useCache);
  }

  private async saveRegistry(
    client: SqlQueryClient,
    kind: "algorithm" | "network",
    registry: SocialState["algorithmRegistry"] | SocialState["networkRegistry"],
    useCache: boolean,
  ): Promise<void> {
    for (const [target, records] of [["draft", registry.drafts], ["version", registry.versions]] as const) {
      for (const [key, payload] of Object.entries(records)) {
        if (useCache && !this.changed(`registry:${kind}:${target}:${key}`, payload)) continue;
        await client.query(
          `INSERT INTO social_registry_entries (registry_kind, target, asset_key, payload, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, now())
           ON CONFLICT (registry_kind, target, asset_key)
           DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
          [kind, target, key, JSON.stringify(payload)],
        );
      }
    }
    for (const tombstone of registry.tombstones ?? []) {
      const key = `tombstone:${kind}:${tombstone.idempotencyKey}`;
      if (useCache && !this.changed(key, tombstone)) continue;
      await client.query(
        `INSERT INTO social_registry_tombstones (registry_kind, idempotency_key, tombstone)
         VALUES ($1, $2, $3::jsonb) ON CONFLICT (registry_kind, idempotency_key) DO NOTHING`,
        [kind, tombstone.idempotencyKey, JSON.stringify(tombstone)],
      );
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

function clone<T>(value: T): T {
  return structuredClone(value);
}

function compactWorkspace(workspace: SocialRoundWorkspace): SocialRoundWorkspace {
  const persisted = clone(workspace);
  if (persisted.closed && persisted.candidateRevisionRef !== undefined) delete persisted.provisionalSnapshot;
  return persisted;
}

export const POSTGRES_SOCIAL_MIGRATION = [
  `CREATE TABLE IF NOT EXISTS social_environment_state (
     singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
     schema_version INTEGER NOT NULL,
     state JSONB NOT NULL,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
   )`,
  `CREATE TABLE IF NOT EXISTS social_state_migrations (
     version integer PRIMARY KEY,
     migrated_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS social_state_meta (
     singleton boolean PRIMARY KEY DEFAULT TRUE CHECK (singleton),
     version integer NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS social_runs (
     run_id text PRIMARY KEY,
     run_state jsonb NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS social_revisions (
     revision_ref text PRIMARY KEY,
     run_id text NOT NULL REFERENCES social_runs(run_id) ON DELETE RESTRICT,
     round_id integer NOT NULL,
     kind text NOT NULL,
     revision jsonb NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS social_revisions_run_round_idx
     ON social_revisions(run_id, round_id, revision_ref)`,
  `CREATE TABLE IF NOT EXISTS social_round_workspaces (
     run_id text NOT NULL REFERENCES social_runs(run_id) ON DELETE RESTRICT,
     round_id integer NOT NULL,
     workspace jsonb NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (run_id, round_id)
   )`,
  `CREATE TABLE IF NOT EXISTS social_idempotency (
     receipt_key text PRIMARY KEY,
     receipt jsonb NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS social_feed_history_capabilities (
     capability_key text PRIMARY KEY,
     capability jsonb NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS social_registry_entries (
     registry_kind text NOT NULL,
     target text NOT NULL,
     asset_key text NOT NULL,
     payload jsonb NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (registry_kind, target, asset_key)
   )`,
  `CREATE TABLE IF NOT EXISTS social_registry_tombstones (
     sequence bigserial UNIQUE,
     registry_kind text NOT NULL,
     idempotency_key text NOT NULL,
     tombstone jsonb NOT NULL,
     PRIMARY KEY (registry_kind, idempotency_key)
   )`,
] as const;

export const POSTGRES_SOCIAL_MIGRATION_V4 = [
  ...POSTGRES_SOCIAL_MIGRATION,
  `CREATE TABLE IF NOT EXISTS social_revision_headers_v4 (
     revision_ref text PRIMARY KEY,
     run_id text NOT NULL REFERENCES social_runs(run_id) ON DELETE RESTRICT,
     round_id integer NOT NULL,
     kind text NOT NULL,
     header jsonb NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS social_revision_headers_v4_run_round_idx
     ON social_revision_headers_v4(run_id, round_id, revision_ref)`,
  `CREATE TABLE IF NOT EXISTS social_revision_snapshots_v4 (
     revision_ref text PRIMARY KEY REFERENCES social_revision_headers_v4(revision_ref) ON DELETE RESTRICT,
     snapshot jsonb NOT NULL,
     snapshot_size_bytes bigint NOT NULL CHECK (snapshot_size_bytes >= 0)
   )`,
  `CREATE TABLE IF NOT EXISTS social_round_intents (
     accepted_sequence bigserial UNIQUE,
     run_id text NOT NULL,
     round_id integer NOT NULL,
     command_id text PRIMARY KEY,
     intent jsonb NOT NULL,
     FOREIGN KEY (run_id, round_id) REFERENCES social_round_workspaces(run_id, round_id) ON DELETE RESTRICT
   )`,
  `CREATE INDEX IF NOT EXISTS social_round_intents_round_order_idx
     ON social_round_intents(run_id, round_id, accepted_sequence)`,
  `CREATE TABLE IF NOT EXISTS social_round_outbox (
     run_id text NOT NULL,
     round_id integer NOT NULL,
     command_id text PRIMARY KEY,
     outbox jsonb NOT NULL,
     FOREIGN KEY (run_id, round_id) REFERENCES social_round_workspaces(run_id, round_id) ON DELETE RESTRICT
   )`,
  `ALTER TABLE social_round_workspaces ADD COLUMN IF NOT EXISTS last_applied_stream_id text`,
  `ALTER TABLE social_round_intents ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending'`,
  `ALTER TABLE social_round_intents ADD COLUMN IF NOT EXISTS stream_id text`,
  `ALTER TABLE social_round_intents ADD COLUMN IF NOT EXISTS delivered_at timestamptz`,
  `ALTER TABLE social_round_intents ADD COLUMN IF NOT EXISTS terminal_at timestamptz`,
  `ALTER TABLE social_round_outbox ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending'`,
  `ALTER TABLE social_round_outbox ADD COLUMN IF NOT EXISTS published_stream_id text`,
  `ALTER TABLE social_round_outbox ADD COLUMN IF NOT EXISTS published_at timestamptz`,
  `ALTER TABLE social_round_outbox ADD COLUMN IF NOT EXISTS last_publish_attempt_at timestamptz`,
  `ALTER TABLE social_round_outbox ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0`,
  `ALTER TABLE social_round_outbox ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now()`,
  `CREATE TABLE IF NOT EXISTS social_stream_partitions (
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
  `CREATE OR REPLACE FUNCTION social_reject_terminal_regression() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN
       IF openleek_intent_status_rank(OLD.status) > openleek_intent_status_rank(NEW.status)
          OR (openleek_intent_status_rank(OLD.status) = 1 AND NEW.status <> OLD.status) THEN
         RAISE EXCEPTION 'social intent terminal status cannot regress';
       END IF;
       RETURN NEW;
     END
   $$`,
  `DROP TRIGGER IF EXISTS social_intent_terminal_guard ON social_round_intents`,
  `CREATE TRIGGER social_intent_terminal_guard BEFORE UPDATE ON social_round_intents
     FOR EACH ROW EXECUTE FUNCTION social_reject_terminal_regression()`,
  `CREATE OR REPLACE FUNCTION social_reject_outbox_regression() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN
       IF openleek_outbox_status_rank(OLD.status) > openleek_outbox_status_rank(NEW.status) THEN
         RAISE EXCEPTION 'social outbox status cannot regress';
       END IF;
       RETURN NEW;
     END
   $$`,
  `DROP TRIGGER IF EXISTS social_outbox_terminal_guard ON social_round_outbox`,
  `CREATE TRIGGER social_outbox_terminal_guard BEFORE UPDATE ON social_round_outbox
     FOR EACH ROW EXECUTE FUNCTION social_reject_outbox_regression()`,
  `CREATE INDEX IF NOT EXISTS social_round_outbox_publish_idx
     ON social_round_outbox(status, next_attempt_at, run_id, round_id)`,
] as const;

class MissingSocialRevisionError extends Error {}

function readCacheLimit(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
  return value;
}
