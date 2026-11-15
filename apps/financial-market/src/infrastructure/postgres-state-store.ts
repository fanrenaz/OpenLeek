import { clone, type IdempotencyRecord } from "../application/idempotency";
import { ByteLru, jsonByteSize } from "@openleek/byte-lru";
import type {
  FinancialInitialStatePresetRegistry,
  FinancialMarketSnapshot,
  FinancialMarketStateStore,
  MarketMakerRegistry,
  PersistedMarketRun,
  PersistedSeal,
} from "../application/persistence";

export interface SqlQueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  rows: Row[];
}

export interface SqlClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    statement: string,
    parameters?: readonly unknown[],
  ): Promise<SqlQueryResult<Row>>;
  transaction<T>(operation: (client: SqlClient) => Promise<T>): Promise<T>;
}

interface LegacyRow extends Record<string, unknown> { snapshot: FinancialMarketSnapshot }
interface MetaRow extends Record<string, unknown> { version: number }
interface RunRow extends Record<string, unknown> { run_id: string; run_state: Omit<PersistedMarketRun, "sealed"> }
interface SealRow extends Record<string, unknown> { run_id: string; seal: PersistedSeal }
interface SealV4Row extends Record<string, unknown> {
  run_id: string;
  round_id: number;
  header: Omit<PersistedSeal, "material">;
  material?: PersistedSeal["material"];
}
interface ReceiptRow extends Record<string, unknown> { receipt: IdempotencyRecord }
interface RegistryRow extends Record<string, unknown> { registry_kind: "market_maker" | "preset"; target: "draft" | "version"; asset_key: string; payload: unknown }
interface TombstoneRow extends Record<string, unknown> { registry_kind: "market_maker" | "preset"; tombstone: NonNullable<MarketMakerRegistry["tombstones"]>[number] }

/** Normalized market-core persistence. The legacy singleton is migration input only. */
export class PostgresFinancialMarketStateStore implements FinancialMarketStateStore {
  private readonly serialized = new Map<string, string>();
  private readonly sealCache: ByteLru<PersistedSeal>;

  constructor(
    private readonly database: SqlClient,
    cacheMaxBytes = readCacheLimit("OPENLEEK_FINANCIAL_SEAL_CACHE_MAX_BYTES", 128 * 1024 * 1024),
  ) {
    this.sealCache = new ByteLru<PersistedSeal>({ maxBytes: cacheMaxBytes, sizeOf: jsonByteSize });
  }

  async migrate(): Promise<void> {
    for (const statement of CREATE_FINANCIAL_MARKET_V4_SQL) await this.database.query(statement);
    await this.database.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", ["financial-market-v3"]);
      const marker = await client.query("SELECT 1 AS present FROM financial_market_migrations WHERE version = 3");
      if (marker.rows[0] === undefined) {
        const legacy = await client.query<LegacyRow>(
          "SELECT snapshot FROM financial_market_state WHERE state_key = $1",
          [LEGACY_STATE_KEY],
        );
        if (legacy.rows[0] !== undefined) await this.saveSnapshotV3(client, legacy.rows[0].snapshot, false);
        await client.query("INSERT INTO financial_market_migrations (version) VALUES (3)");
      }
      const v4 = await client.query("SELECT 1 AS present FROM financial_market_migrations WHERE version = 4");
      if (v4.rows[0] === undefined) {
        await client.query(
          `INSERT INTO financial_market_seal_headers_v4 (run_id, round_id, header)
           SELECT run_id, round_id, seal - 'material' FROM financial_market_seals
           ON CONFLICT (run_id, round_id) DO NOTHING`,
        );
        await client.query(
          `INSERT INTO financial_market_seal_materials_v4 (run_id, round_id, material, material_size_bytes)
           SELECT run_id, round_id, seal->'material', pg_column_size((seal->'material')::jsonb)
           FROM financial_market_seals ON CONFLICT (run_id, round_id) DO NOTHING`,
        );
        await client.query("INSERT INTO financial_market_migrations (version) VALUES (4)");
      }
    });
    this.serialized.clear();
  }

  async load(): Promise<FinancialMarketSnapshot | undefined> {
    const marker = await this.database.query("SELECT 1 AS present FROM financial_market_migrations WHERE version = 4");
    if (marker.rows[0] === undefined) {
      const result = await this.database.query<LegacyRow>(
        "SELECT snapshot FROM financial_market_state WHERE state_key = $1",
        [LEGACY_STATE_KEY],
      );
      return result.rows[0] === undefined ? undefined : clone(result.rows[0].snapshot);
    }
    const [meta, runs, seals, hotSeals, receipts, registry, tombstones] = await Promise.all([
      this.database.query<MetaRow>("SELECT version FROM financial_market_meta WHERE singleton = TRUE"),
      this.database.query<RunRow>("SELECT run_id, run_state FROM financial_market_runs"),
      this.database.query<SealV4Row>(
        "SELECT run_id, round_id, header FROM financial_market_seal_headers_v4 ORDER BY run_id, round_id",
      ),
      this.database.query<SealV4Row>(
        `SELECT h.run_id, h.round_id, h.header, m.material
         FROM financial_market_seal_headers_v4 h
         JOIN financial_market_seal_materials_v4 m USING (run_id, round_id)
         JOIN financial_market_runs r ON r.run_id = h.run_id
         WHERE h.round_id = (r.run_state->>'publishedRound')::integer`,
      ),
      this.database.query<ReceiptRow>("SELECT receipt FROM financial_market_idempotency ORDER BY transition_id, step_id"),
      this.database.query<RegistryRow>("SELECT registry_kind, target, asset_key, payload FROM financial_market_registry_entries"),
      this.database.query<TombstoneRow>("SELECT registry_kind, tombstone FROM financial_market_registry_tombstones ORDER BY registry_kind, sequence"),
    ]);
    if (meta.rows[0] === undefined && runs.rows.length === 0) return undefined;
    if (meta.rows[0]?.version !== 2) throw new Error(`unsupported Financial Market state version: ${String(meta.rows[0]?.version)}`);
    const marketMakerRegistry: MarketMakerRegistry = { drafts: {}, versions: {}, tombstones: [] };
    const presetRegistry: FinancialInitialStatePresetRegistry = { drafts: {}, versions: {}, tombstones: [] };
    const snapshot: FinancialMarketSnapshot = {
      version: 2,
      runs: runs.rows.map((row) => ({ ...clone(row.run_state), sealed: [] })),
      idempotency: receipts.rows.map((row) => clone(row.receipt)),
      marketMakerRegistry,
      financialInitialStatePresetRegistry: presetRegistry,
    };
    const runById = new Map(snapshot.runs.map((run) => [run.runId, run]));
    for (const row of seals.rows) {
      const run = runById.get(row.run_id);
      if (run === undefined) throw new Error(`Financial seal has no owning run: ${row.run_id}`);
      run.sealed.push(clone(row.header) as PersistedSeal);
    }
    for (const row of hotSeals.rows) {
      const run = runById.get(row.run_id);
      if (run === undefined || row.material === undefined) continue;
      const seal = { ...clone(row.header), material: clone(row.material) } as PersistedSeal;
      const index = run.sealed.findIndex((candidate) => candidate.checkpoint.roundId === row.round_id);
      if (index >= 0) run.sealed[index] = seal;
      this.sealCache.set(sealKey(row.run_id, row.round_id), seal);
    }
    for (const row of registry.rows) {
      const destination = row.registry_kind === "market_maker" ? marketMakerRegistry : presetRegistry;
      const target = row.target === "draft" ? "drafts" : "versions";
      (destination[target] as Record<string, unknown>)[row.asset_key] = clone(row.payload);
    }
    for (const row of tombstones.rows) {
      const destination = row.registry_kind === "market_maker" ? marketMakerRegistry : presetRegistry;
      (destination.tombstones ??= []).push(clone(row.tombstone));
    }
    this.seedCache(snapshot);
    return snapshot;
  }

  async loadSeal(runId: string, roundId: number): Promise<PersistedSeal | undefined> {
    const key = sealKey(runId, roundId);
    return this.sealCache.getOrLoad(key, async () => {
      const result = await this.database.query<SealV4Row>(
        `SELECT h.run_id, h.round_id, h.header, m.material
         FROM financial_market_seal_headers_v4 h
         JOIN financial_market_seal_materials_v4 m USING (run_id, round_id)
         WHERE h.run_id = $1 AND h.round_id = $2`,
        [runId, roundId],
      );
      const row = result.rows[0];
      if (row === undefined || row.material === undefined) throw new MissingFinancialSealError(key);
      return { ...clone(row.header), material: clone(row.material) } as PersistedSeal;
    }).catch((error) => {
      if (error instanceof MissingFinancialSealError) return undefined;
      throw error;
    });
  }

  async save(snapshot: FinancialMarketSnapshot): Promise<void> {
    try {
      await this.database.transaction((client) => this.saveSnapshotV4(client, snapshot, true));
    } catch (error) {
      this.serialized.clear();
      throw error;
    }
  }

  private async saveSnapshotV4(client: SqlClient, snapshot: FinancialMarketSnapshot, useCache: boolean): Promise<void> {
    if (!useCache || this.changed("meta", snapshot.version)) {
      await client.query(
        `INSERT INTO financial_market_meta (singleton, version, updated_at) VALUES (TRUE, $1, now())
         ON CONFLICT (singleton) DO UPDATE SET version = EXCLUDED.version, updated_at = now()`,
        [snapshot.version],
      );
    }
    for (const run of snapshot.runs) {
      const runState = clone(run);
      delete (runState as Partial<PersistedMarketRun>).sealed;
      if (!useCache || this.changed(`run:${run.runId}`, runState)) {
        await client.query(
          `INSERT INTO financial_market_runs (run_id, run_state, updated_at) VALUES ($1, $2::jsonb, now())
           ON CONFLICT (run_id) DO UPDATE SET run_state = EXCLUDED.run_state, updated_at = now()`,
          [run.runId, JSON.stringify(runState)],
        );
      }
      for (const seal of run.sealed) {
        const key = `seal:${run.runId}:${seal.checkpoint.roundId}`;
        if (seal.material === undefined) continue;
        const { material, ...header } = seal;
        if (useCache && !this.changed(key, header)) continue;
        await client.query(
          `INSERT INTO financial_market_seal_headers_v4 (run_id, round_id, header) VALUES ($1, $2, $3::jsonb)
           ON CONFLICT (run_id, round_id) DO UPDATE SET header = EXCLUDED.header`,
          [run.runId, seal.checkpoint.roundId, JSON.stringify(header)],
        );
        await client.query(
          `INSERT INTO financial_market_seal_materials_v4 (run_id, round_id, material, material_size_bytes)
           VALUES ($1, $2, $3::jsonb, $4)
           ON CONFLICT (run_id, round_id) DO NOTHING`,
          [run.runId, seal.checkpoint.roundId, JSON.stringify(material), jsonByteSize(material)],
        );
        this.sealCache.set(sealKey(run.runId, seal.checkpoint.roundId), seal);
      }
    }
    for (const receipt of snapshot.idempotency) {
      const key = `receipt:${receipt.transitionId}:${receipt.stepId}`;
      if (useCache && !this.changed(key, receipt)) continue;
      await client.query(
        `INSERT INTO financial_market_idempotency (transition_id, step_id, receipt)
         VALUES ($1, $2, $3::jsonb) ON CONFLICT (transition_id, step_id) DO NOTHING`,
        [receipt.transitionId, receipt.stepId, JSON.stringify(receipt)],
      );
    }
    await this.saveRegistry(client, "market_maker", snapshot.marketMakerRegistry, useCache);
    await this.saveRegistry(client, "preset", snapshot.financialInitialStatePresetRegistry ?? { drafts: {}, versions: {}, tombstones: [] }, useCache);
  }

  private async saveSnapshotV3(client: SqlClient, snapshot: FinancialMarketSnapshot, useCache: boolean): Promise<void> {
    if (!useCache || this.changed("meta", snapshot.version)) {
      await client.query(
        `INSERT INTO financial_market_meta (singleton, version, updated_at) VALUES (TRUE, $1, now())
         ON CONFLICT (singleton) DO UPDATE SET version=EXCLUDED.version, updated_at=now()`,
        [snapshot.version],
      );
    }
    for (const run of snapshot.runs) {
      const runState = clone(run);
      delete (runState as Partial<PersistedMarketRun>).sealed;
      await client.query(
        `INSERT INTO financial_market_runs (run_id,run_state,updated_at) VALUES ($1,$2::jsonb,now())
         ON CONFLICT (run_id) DO UPDATE SET run_state=EXCLUDED.run_state, updated_at=now()`,
        [run.runId, JSON.stringify(runState)],
      );
      for (const seal of run.sealed) {
        await client.query(
          `INSERT INTO financial_market_seals (run_id,round_id,seal) VALUES ($1,$2,$3::jsonb)
           ON CONFLICT (run_id,round_id) DO UPDATE SET seal=EXCLUDED.seal`,
          [run.runId, seal.checkpoint.roundId, JSON.stringify(seal)],
        );
      }
    }
    for (const receipt of snapshot.idempotency) {
      await client.query(
        `INSERT INTO financial_market_idempotency (transition_id,step_id,receipt)
         VALUES ($1,$2,$3::jsonb) ON CONFLICT (transition_id,step_id) DO NOTHING`,
        [receipt.transitionId, receipt.stepId, JSON.stringify(receipt)],
      );
    }
    await this.saveRegistry(client, "market_maker", snapshot.marketMakerRegistry, useCache);
    await this.saveRegistry(client, "preset", snapshot.financialInitialStatePresetRegistry ?? { drafts: {}, versions: {}, tombstones: [] }, useCache);
  }

  private async saveRegistry(
    client: SqlClient,
    kind: "market_maker" | "preset",
    registry: MarketMakerRegistry | FinancialInitialStatePresetRegistry,
    useCache: boolean,
  ): Promise<void> {
    for (const [target, records] of [["draft", registry.drafts], ["version", registry.versions]] as const) {
      for (const [key, payload] of Object.entries(records)) {
        const cacheKey = `registry:${kind}:${target}:${key}`;
        if (useCache && !this.changed(cacheKey, payload)) continue;
        await client.query(
          `INSERT INTO financial_market_registry_entries (registry_kind, target, asset_key, payload, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, now())
           ON CONFLICT (registry_kind, target, asset_key)
           DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
          [kind, target, key, JSON.stringify(payload)],
        );
      }
    }
    for (const tombstone of registry.tombstones ?? []) {
      const cacheKey = `tombstone:${kind}:${tombstone.idempotencyKey}`;
      if (useCache && !this.changed(cacheKey, tombstone)) continue;
      await client.query(
        `INSERT INTO financial_market_registry_tombstones (registry_kind, idempotency_key, tombstone)
         VALUES ($1, $2, $3::jsonb) ON CONFLICT (registry_kind, idempotency_key) DO NOTHING`,
        [kind, tombstone.idempotencyKey, JSON.stringify(tombstone)],
      );
    }
  }

  private seedCache(snapshot: FinancialMarketSnapshot): void {
    this.serialized.clear();
    this.serialized.set("meta", JSON.stringify(snapshot.version));
    for (const run of snapshot.runs) {
      const runState = clone(run);
      delete (runState as Partial<PersistedMarketRun>).sealed;
      this.serialized.set(`run:${run.runId}`, JSON.stringify(runState));
      for (const seal of run.sealed) this.serialized.set(`seal:${run.runId}:${seal.checkpoint.roundId}`, JSON.stringify(seal));
    }
    for (const receipt of snapshot.idempotency) this.serialized.set(`receipt:${receipt.transitionId}:${receipt.stepId}`, JSON.stringify(receipt));
  }

  private changed(key: string, value: unknown): boolean {
    const next = JSON.stringify(value);
    if (this.serialized.get(key) === next) return false;
    this.serialized.set(key, next);
    return true;
  }
}

const LEGACY_STATE_KEY = "current";

export const CREATE_FINANCIAL_MARKET_V3_SQL = [
  `CREATE TABLE IF NOT EXISTS financial_market_state (
     state_key text PRIMARY KEY,
     snapshot jsonb NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS financial_market_migrations (
     version integer PRIMARY KEY,
     migrated_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS financial_market_meta (
     singleton boolean PRIMARY KEY DEFAULT TRUE CHECK (singleton),
     version integer NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS financial_market_runs (
     run_id text PRIMARY KEY,
     run_state jsonb NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS financial_market_seals (
     run_id text NOT NULL REFERENCES financial_market_runs(run_id) ON DELETE RESTRICT,
     round_id integer NOT NULL,
     seal jsonb NOT NULL,
     PRIMARY KEY (run_id, round_id)
   )`,
  `CREATE TABLE IF NOT EXISTS financial_market_idempotency (
     transition_id text NOT NULL,
     step_id text NOT NULL,
     receipt jsonb NOT NULL,
     PRIMARY KEY (transition_id, step_id)
   )`,
  `CREATE TABLE IF NOT EXISTS financial_market_registry_entries (
     registry_kind text NOT NULL,
     target text NOT NULL,
     asset_key text NOT NULL,
     payload jsonb NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (registry_kind, target, asset_key)
   )`,
  `CREATE TABLE IF NOT EXISTS financial_market_registry_tombstones (
     sequence bigserial UNIQUE,
     registry_kind text NOT NULL,
     idempotency_key text NOT NULL,
     tombstone jsonb NOT NULL,
     PRIMARY KEY (registry_kind, idempotency_key)
   )`,
] as const;

export const CREATE_FINANCIAL_MARKET_V4_SQL = [
  ...CREATE_FINANCIAL_MARKET_V3_SQL,
  `CREATE TABLE IF NOT EXISTS financial_market_seal_headers_v4 (
     run_id text NOT NULL REFERENCES financial_market_runs(run_id) ON DELETE RESTRICT,
     round_id integer NOT NULL,
     header jsonb NOT NULL,
     PRIMARY KEY (run_id, round_id)
   )`,
  `CREATE TABLE IF NOT EXISTS financial_market_seal_materials_v4 (
     run_id text NOT NULL,
     round_id integer NOT NULL,
     material jsonb NOT NULL,
     material_size_bytes bigint NOT NULL CHECK (material_size_bytes >= 0),
     PRIMARY KEY (run_id, round_id),
     FOREIGN KEY (run_id, round_id)
       REFERENCES financial_market_seal_headers_v4(run_id, round_id) ON DELETE RESTRICT
   )`,
] as const;

class MissingFinancialSealError extends Error {}

function sealKey(runId: string, roundId: number): string {
  return `${runId}\u0000${roundId}`;
}

function readCacheLimit(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
  return value;
}
