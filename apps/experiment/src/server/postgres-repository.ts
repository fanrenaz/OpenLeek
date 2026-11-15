import { AsyncLocalStorage } from "node:async_hooks";
import type { AssetTombstone } from "@openleek/contracts/assets";
import { pluginManifestSchema, pluginSpecificationSchema, runStatusSchema, type PluginManifest, type RoundProgress } from "@openleek/contracts/experiment";
import { sha256Digest } from "@openleek/contracts/canonical";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import type {
  AgentJob,
  ClaimedJob,
  CommitWork,
  ExperimentRepository,
  JobFailure,
  Ledger,
  LedgerStep,
  RoundAttempt,
  RoundSnapshot,
  RunRelease,
  RunAgentRegistration,
  RunRecord,
  StoredReceipt,
  WorldGeneratorDraft,
  WorldGeneratorVersion,
  PopulationDraft,
  PopulationVersion,
  AgentBlueprintDraft,
  AgentBlueprintVersion,
  TurnPromptDraft,
  TurnPromptVersion,
} from "./model";

const cursor = (value: string) => Buffer.from(value, "utf8").toString("base64url");
const decodeCursor = (value: string | undefined) => value ? Buffer.from(value, "base64url").toString("utf8") : undefined;
const copy = <T>(value: T): T => structuredClone(value);
const nowText = (now = new Date()) => now.toISOString();

/**
 * The Experiment-owner PostgreSQL repository. Snapshot, queue, leases, and
 * commit recovery state live together so the HTTP control plane never needs a
 * broker or another Context's database credential.
 */
export class PostgresExperimentRepository implements ExperimentRepository {
  private readonly transactionClient = new AsyncLocalStorage<PoolClient>();

  constructor(private readonly pool: Pool) {}

  static fromEnvironment() {
    const connectionString = process.env.OPENLEEK_EXPERIMENT_DATABASE_URL;
    if (!connectionString) throw new Error("OPENLEEK_EXPERIMENT_DATABASE_URL is required outside explicit in-memory mode");
    return new PostgresExperimentRepository(new Pool({ connectionString, max: 20 }));
  }

  async migrate(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS experiment_runs (
        run_id text PRIMARY KEY,
        status jsonb NOT NULL,
        specification jsonb NOT NULL,
        specification_digest text NOT NULL,
        lineage_parent_manifest_ref text
      );
      ALTER TABLE experiment_runs ADD COLUMN IF NOT EXISTS resolved_world jsonb;
      ALTER TABLE experiment_runs ADD COLUMN IF NOT EXISTS turn_prompt jsonb;
      CREATE TABLE IF NOT EXISTS experiment_manifests (
        ref text PRIMARY KEY,
        run_id text NOT NULL REFERENCES experiment_runs(run_id) ON DELETE RESTRICT,
        round_id integer NOT NULL CHECK (round_id >= 0),
        state text NOT NULL CHECK (state IN ('pending','sealed','publishing','committed')),
        manifest jsonb NOT NULL,
        UNIQUE (run_id, round_id)
      );
      CREATE TABLE IF NOT EXISTS experiment_mutation_receipts (
        scope text NOT NULL,
        transition_id text NOT NULL,
        step_id text NOT NULL,
        request_digest text NOT NULL,
        result jsonb NOT NULL,
        PRIMARY KEY (scope, transition_id, step_id)
      );
      CREATE TABLE IF NOT EXISTS experiment_run_agent_registrations (
        run_id text NOT NULL REFERENCES experiment_runs(run_id) ON DELETE RESTRICT,
        agent_id text NOT NULL,
        principal_id text NOT NULL UNIQUE,
        credential_version integer NOT NULL CHECK (credential_version > 0),
        status text NOT NULL CHECK (status IN ('active','revoked')),
        registered_at timestamptz NOT NULL,
        revoked_at timestamptz,
        PRIMARY KEY (run_id, agent_id)
      );
      CREATE INDEX IF NOT EXISTS experiment_run_agent_registrations_run_idx
        ON experiment_run_agent_registrations (run_id, agent_id);
      CREATE TABLE IF NOT EXISTS experiment_round_snapshots (
        snapshot_id text PRIMARY KEY,
        run_id text NOT NULL REFERENCES experiment_runs(run_id) ON DELETE RESTRICT,
        round_id integer NOT NULL CHECK (round_id > 0),
        digest text NOT NULL,
        snapshot jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (run_id, round_id)
      );
      CREATE TABLE IF NOT EXISTS experiment_round_attempts (
        attempt_id text PRIMARY KEY,
        run_id text NOT NULL REFERENCES experiment_runs(run_id) ON DELETE RESTRICT,
        round_id integer NOT NULL CHECK (round_id > 0),
        snapshot_id text NOT NULL REFERENCES experiment_round_snapshots(snapshot_id) ON DELETE RESTRICT,
        attempt_no integer NOT NULL CHECK (attempt_no > 0),
        state text NOT NULL CHECK (state IN ('queued','running','committing','retry_wait','committed','cancelled')),
        commit_started boolean NOT NULL DEFAULT false,
        commit_lease_token text,
        commit_lease_expires_at timestamptz,
        attempt jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (snapshot_id, attempt_no)
      );
      ALTER TABLE experiment_round_attempts ADD COLUMN IF NOT EXISTS commit_lease_token text;
      ALTER TABLE experiment_round_attempts ADD COLUMN IF NOT EXISTS commit_lease_expires_at timestamptz;
      CREATE INDEX IF NOT EXISTS experiment_round_attempts_active_idx ON experiment_round_attempts (run_id, state, attempt_no DESC);
      CREATE TABLE IF NOT EXISTS experiment_agent_jobs (
        job_id text PRIMARY KEY,
        attempt_id text NOT NULL REFERENCES experiment_round_attempts(attempt_id) ON DELETE RESTRICT,
        run_id text NOT NULL REFERENCES experiment_runs(run_id) ON DELETE RESTRICT,
        declaration_index integer NOT NULL,
        state text NOT NULL CHECK (state IN ('queued','running','succeeded','failed','cancelled')),
        available_at timestamptz NOT NULL,
        lease_expires_at timestamptz,
        job jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (attempt_id, declaration_index)
      );
      CREATE INDEX IF NOT EXISTS experiment_agent_jobs_claim_idx ON experiment_agent_jobs (state, available_at, declaration_index);
      CREATE TABLE IF NOT EXISTS experiment_commit_ledger_steps (
        attempt_id text NOT NULL REFERENCES experiment_round_attempts(attempt_id) ON DELETE RESTRICT,
        step text NOT NULL,
        completed_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (attempt_id, step)
      );
      CREATE TABLE IF NOT EXISTS experiment_run_releases (
        run_id text PRIMARY KEY REFERENCES experiment_runs(run_id) ON DELETE RESTRICT,
        state text NOT NULL CHECK (state IN ('queued','running','released')),
        attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        available_at timestamptz NOT NULL DEFAULT now(),
        lease_token text,
        lease_expires_at timestamptz,
        recent_error jsonb,
        released_at timestamptz
      );
      CREATE INDEX IF NOT EXISTS experiment_run_releases_claim_idx
        ON experiment_run_releases (state, available_at);
      CREATE TABLE IF NOT EXISTS experiment_world_generator_drafts (
        generator_id text PRIMARY KEY,
        draft jsonb NOT NULL
      );
      CREATE TABLE IF NOT EXISTS experiment_world_generator_versions (
        version_ref text PRIMARY KEY,
        version jsonb NOT NULL
      );
      CREATE TABLE IF NOT EXISTS experiment_population_drafts (
        population_id text PRIMARY KEY,
        draft jsonb NOT NULL
      );
      CREATE TABLE IF NOT EXISTS experiment_population_versions (
        version_ref text PRIMARY KEY,
        version jsonb NOT NULL
      );
      CREATE TABLE IF NOT EXISTS experiment_agent_blueprint_drafts (
        blueprint_id text PRIMARY KEY,
        draft jsonb NOT NULL
      );
      CREATE TABLE IF NOT EXISTS experiment_agent_blueprint_versions (
        version_ref text PRIMARY KEY,
        version jsonb NOT NULL
      );
      CREATE TABLE IF NOT EXISTS experiment_turn_prompt_drafts (
        prompt_id text PRIMARY KEY,
        draft jsonb NOT NULL
      );
      CREATE TABLE IF NOT EXISTS experiment_turn_prompt_versions (
        version_ref text PRIMARY KEY,
        version jsonb NOT NULL
      );
      CREATE TABLE IF NOT EXISTS experiment_asset_tombstones (
        asset_kind text NOT NULL,
        target text NOT NULL CHECK (target IN ('draft','version')),
        asset_id text NOT NULL,
        idempotency_key text NOT NULL,
        tombstone jsonb NOT NULL,
        PRIMARY KEY (asset_kind, target, asset_id)
      );
    `);
  }

  async findRun(runId: string): Promise<RunRecord | undefined> {
    const result = await this.query("SELECT * FROM experiment_runs WHERE run_id = $1", [runId]);
    return result.rows[0] ? this.rowToRun(result.rows[0]) : undefined;
  }
  async createRun(run: RunRecord, registrations: readonly RunAgentRegistration[]) {
    await this.inTransaction(async () => {
      await this.query("INSERT INTO experiment_runs (run_id, status, specification, specification_digest, lineage_parent_manifest_ref, resolved_world, turn_prompt) VALUES ($1, $2::jsonb, $3::jsonb, $4, $5, $6::jsonb, $7::jsonb)", [run.status.runId, JSON.stringify(run.status), JSON.stringify(run.specification), run.specificationDigest, run.lineageParentManifestRef ?? null, run.resolvedWorld === undefined ? null : JSON.stringify(run.resolvedWorld), JSON.stringify(run.turnPrompt)]);
      for (const registration of registrations) {
        if (registration.runId !== run.status.runId) throw new Error("run Agent registration belongs to another run");
        await this.query(`INSERT INTO experiment_run_agent_registrations
          (run_id, agent_id, principal_id, credential_version, status, registered_at, revoked_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
          registration.runId,
          registration.agentId,
          registration.principalId,
          registration.credentialVersion,
          registration.status,
          registration.registeredAt,
          registration.revokedAt ?? null,
        ]);
      }
    });
  }
  async saveRun(run: RunRecord) {
    await this.query("UPDATE experiment_runs SET status = $2::jsonb, specification = $3::jsonb, specification_digest = $4, lineage_parent_manifest_ref = $5, resolved_world = $6::jsonb, turn_prompt = $7::jsonb WHERE run_id = $1", [run.status.runId, JSON.stringify(run.status), JSON.stringify(run.specification), run.specificationDigest, run.lineageParentManifestRef ?? null, run.resolvedWorld === undefined ? null : JSON.stringify(run.resolvedWorld), JSON.stringify(run.turnPrompt)]);
  }
  async listRuns(input: { cursor?: string; limit: number; lifecycle?: RunRecord["status"]["lifecycle"] }) {
    const after = decodeCursor(input.cursor);
    const params: unknown[] = [];
    const clauses: string[] = [];
    if (input.lifecycle) { params.push(input.lifecycle); clauses.push(`status->>'lifecycle' = $${params.length}`); }
    if (after) { params.push(after); clauses.push(`run_id > $${params.length}`); }
    params.push(input.limit + 1);
    const result = await this.query(`SELECT * FROM experiment_runs ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY run_id ASC LIMIT $${params.length}`, params);
    const items = result.rows.slice(0, input.limit).map((row) => this.rowToRun(row));
    return { items, nextCursor: result.rows.length > input.limit ? cursor(items.at(-1)!.status.runId) : undefined };
  }

  async withRunLock<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    if (this.transactionClient.getStore()) return operation();
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [runId]);
      return this.transactionClient.run(client, operation);
    });
  }
  async findActiveAttempt(runId: string) {
    const result = await this.query("SELECT attempt FROM experiment_round_attempts WHERE run_id = $1 AND state NOT IN ('committed', 'cancelled') ORDER BY attempt_no DESC LIMIT 1", [runId]);
    return result.rows[0] ? copy(result.rows[0].attempt as RoundAttempt) : undefined;
  }
  async findRunReadyForAutomaticAdvance() {
    const result = await this.query(`
      SELECT r.*
      FROM experiment_runs r
      WHERE r.specification #>> '{executionPolicy,roundAdvancement}' = 'automatic'
        AND r.status->>'lifecycle' IN ('queued', 'running')
        AND (r.status->>'committedRound')::integer < (r.status->>'configuredRounds')::integer
        AND (
          r.status->'advanceRetry' IS NULL
          OR (r.status #>> '{advanceRetry,nextRetryAt}')::timestamptz <= now()
        )
        AND NOT EXISTS (
          SELECT 1 FROM experiment_round_attempts a
          WHERE a.run_id = r.run_id AND a.state NOT IN ('committed', 'cancelled')
        )
      ORDER BY r.run_id ASC
      LIMIT 1`);
    return result.rows[0] ? this.rowToRun(result.rows[0]) : undefined;
  }
  async saveSnapshotAndAttempt(snapshot: RoundSnapshot, attempt: RoundAttempt, jobs: readonly AgentJob[]) {
    await this.inTransaction(async () => {
      await this.query("INSERT INTO experiment_round_snapshots (snapshot_id, run_id, round_id, digest, snapshot) VALUES ($1, $2, $3, $4, $5::jsonb)", [snapshot.snapshotId, snapshot.runId, snapshot.roundId, snapshot.digest, JSON.stringify(snapshot)]);
      await this.saveAttempt(attempt);
      for (const job of jobs) await this.saveJob(job, attempt.runId);
    });
  }
  async findSnapshot(snapshotId: string) {
    const result = await this.query("SELECT snapshot FROM experiment_round_snapshots WHERE snapshot_id = $1", [snapshotId]);
    return result.rows[0] ? copy(result.rows[0].snapshot as RoundSnapshot) : undefined;
  }
  async findAttempt(attemptId: string) {
    const result = await this.query("SELECT attempt FROM experiment_round_attempts WHERE attempt_id = $1", [attemptId]);
    return result.rows[0] ? copy(result.rows[0].attempt as RoundAttempt) : undefined;
  }
  async listAttemptJobs(attemptId: string) {
    const result = await this.query("SELECT job FROM experiment_agent_jobs WHERE attempt_id = $1 ORDER BY declaration_index ASC", [attemptId]);
    return result.rows.map((row) => copy(row.job as AgentJob));
  }
  async getRoundProgress(runId: string): Promise<RoundProgress | undefined> {
    const attemptResult = await this.query("SELECT attempt FROM experiment_round_attempts WHERE run_id = $1 ORDER BY round_id DESC, attempt_no DESC, updated_at DESC LIMIT 1", [runId]);
    if (!attemptResult.rows[0]) return undefined;
    const attempt = attemptResult.rows[0].attempt as RoundAttempt;
    const snapshot = await this.findSnapshot(attempt.snapshotId);
    if (!snapshot) throw new Error("attempt snapshot is missing");
    const jobs = await this.listAttemptJobs(attempt.attemptId);
    const counts = { queued: 0, running: 0, succeeded: 0, failed: 0 };
    const failureCategories: Record<string, number> = {};
    let error = attempt.recentError;
    for (const job of jobs) {
      if (job.state in counts) counts[job.state as keyof typeof counts] += 1;
      if (job.failure) {
        failureCategories[job.failure.category] = (failureCategories[job.failure.category] ?? 0) + 1;
        if (!error || error.occurredAt < job.failure.occurredAt) error = job.failure;
      }
    }
    return { runId, roundId: attempt.roundId, snapshotId: snapshot.snapshotId, snapshotDigest: snapshot.digest, attempt: attempt.attempt, state: attempt.state, total: jobs.length, ...counts, failureCategories, ...(error ? { recentError: `${error.category}: ${error.message}` } : {}) };
  }
  async createRetryAttempt(previous: RoundAttempt, retry: RoundAttempt, jobs: readonly AgentJob[]) {
    await this.inTransaction(async () => {
      const current = await this.findAttempt(previous.attemptId);
      if (!current || current.state !== "retry_wait" || current.commitStarted) throw new Error("attempt is not eligible for provider retry");
      await this.saveAttempt(retry);
      for (const job of jobs) await this.saveJob(job, retry.runId);
    });
  }
  async markAttemptQueued(attemptId: string) {
    return this.inTransaction(async () => {
      const attempt = await this.findAttempt(attemptId);
      if (!attempt || attempt.state !== "retry_wait" || !attempt.commitStarted) throw new Error("attempt is not eligible for commit retry");
      const next = { ...attempt, state: "queued" as const, updatedAt: nowText() };
      await this.saveAttempt(next);
      return next;
    });
  }
  async cancelActiveAttempt(runId: string) {
    await this.inTransaction(async () => {
      const result = await this.query("SELECT attempt FROM experiment_round_attempts WHERE run_id = $1 AND state NOT IN ('committed','cancelled') FOR UPDATE", [runId]);
      for (const row of result.rows) {
        const attempt = row.attempt as RoundAttempt;
        await this.saveAttempt({ ...attempt, state: "cancelled", updatedAt: nowText() });
        const jobs = await this.listAttemptJobs(attempt.attemptId);
        for (const job of jobs) if (job.state === "queued") await this.saveJob({ ...job, state: "cancelled", leaseToken: undefined, leaseExpiresAt: undefined, updatedAt: nowText() }, attempt.runId);
      }
    });
  }

  async claimNextJob(input: { workerId: string; leaseMs: number; now: Date }): Promise<ClaimedJob | undefined> {
    return this.inTransaction(async () => {
      // A short database-wide claim mutex makes the aggregate running count a
      // hard cap even when workers select different candidate rows at once.
      // It is held only for the claim transaction, never for provider work.
      await this.query("SELECT pg_advisory_xact_lock($1::bigint)", ["731942183"]);
      await this.expireLeases(input.now);
      const result = await this.query(`
        SELECT j.job, a.attempt, s.snapshot
        FROM experiment_agent_jobs j
        JOIN experiment_round_attempts a ON a.attempt_id = j.attempt_id
        JOIN experiment_round_snapshots s ON s.snapshot_id = a.snapshot_id
        WHERE j.state = 'queued' AND j.available_at <= $1
          AND a.state IN ('queued','running')
          AND (SELECT count(*) FROM experiment_agent_jobs r JOIN experiment_round_attempts ar ON ar.attempt_id = r.attempt_id WHERE ar.run_id = a.run_id AND r.state = 'running') < (s.snapshot->>'maxConcurrentAgents')::integer
        ORDER BY j.available_at, j.declaration_index, j.job_id
        FOR UPDATE OF j SKIP LOCKED LIMIT 1`, [input.now]);
      const row = result.rows[0];
      if (!row) return undefined;
      const job = row.job as AgentJob;
      const attempt = row.attempt as RoundAttempt;
      const snapshot = row.snapshot as RoundSnapshot;
      const token = `${input.workerId}:${job.jobId}:${job.attempts + 1}:${input.now.getTime()}`;
      const leased: AgentJob = { ...job, state: "running", attempts: job.attempts + 1, leaseToken: token, leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs).toISOString(), updatedAt: nowText(input.now) };
      await this.saveJob(leased, attempt.runId);
      const running = attempt.state === "queued" ? { ...attempt, state: "running" as const, updatedAt: nowText(input.now) } : attempt;
      if (running !== attempt) await this.saveAttempt(running);
      return { job: copy(leased), attempt: copy(running), snapshot: copy(snapshot) };
    });
  }
  async heartbeatJob(input: { jobId: string; leaseToken: string; leaseMs: number; now: Date }) {
    return this.inTransaction(async () => {
      const found = await this.query("SELECT job, run_id FROM experiment_agent_jobs WHERE job_id = $1 FOR UPDATE", [input.jobId]);
      const row = found.rows[0];
      if (!row) return false;
      const job = row.job as AgentJob;
      if (job.state !== "running" || job.leaseToken !== input.leaseToken) return false;
      await this.saveJob({ ...job, leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs).toISOString(), updatedAt: nowText(input.now) }, String(row.run_id));
      return true;
    });
  }
  async completeJob(input: { jobId: string; leaseToken: string; result: readonly import("@openleek/contracts/experiment").CandidateAction[]; resultDigest: string; now: Date }) {
    return this.inTransaction(async () => {
      const found = await this.query("SELECT job, run_id FROM experiment_agent_jobs WHERE job_id = $1 FOR UPDATE", [input.jobId]);
      const row = found.rows[0];
      if (!row) return false;
      const job = row.job as AgentJob;
      if (job.state !== "running" || job.leaseToken !== input.leaseToken) return false;
      const attemptRow = await this.query("SELECT attempt FROM experiment_round_attempts WHERE attempt_id = $1 FOR UPDATE", [job.attemptId]);
      const attempt = attemptRow.rows[0]?.attempt as RoundAttempt | undefined;
      if (!attempt) return false;
      if (attempt.state === "cancelled") {
        await this.saveJob({ ...job, state: "cancelled", leaseToken: undefined, leaseExpiresAt: undefined, updatedAt: nowText(input.now) }, String(row.run_id));
        return false;
      }
      await this.saveJob({ ...job, state: "succeeded", result: copy(input.result), resultDigest: input.resultDigest, failure: undefined, leaseToken: undefined, leaseExpiresAt: undefined, updatedAt: nowText(input.now) }, String(row.run_id));
      await this.markFailedAttemptRetryWait(attempt, input.now);
      return true;
    });
  }
  async failJob(input: { jobId: string; leaseToken: string; failure: JobFailure; now: Date }) {
    return this.inTransaction(async () => {
      const found = await this.query("SELECT job, run_id FROM experiment_agent_jobs WHERE job_id = $1 FOR UPDATE", [input.jobId]);
      const row = found.rows[0];
      if (!row) return { accepted: false, exhausted: false };
      const job = row.job as AgentJob;
      if (job.state !== "running" || job.leaseToken !== input.leaseToken) return { accepted: false, exhausted: false };
      // Serialize terminal outcomes for one attempt so the final transaction
      // observes every earlier success/failure before deciding whether the
      // round is eligible to commit.
      const attemptRow = await this.query("SELECT attempt FROM experiment_round_attempts WHERE attempt_id = $1 FOR UPDATE", [job.attemptId]);
      const attempt = attemptRow.rows[0]?.attempt as RoundAttempt | undefined;
      const snapshot = attempt && await this.findSnapshot(attempt.snapshotId);
      if (!attempt || !snapshot) return { accepted: false, exhausted: false };
      if (attempt.state === "cancelled") {
        await this.saveJob({ ...job, state: "cancelled", failure: copy(input.failure), leaseToken: undefined, leaseExpiresAt: undefined, updatedAt: nowText(input.now) }, String(row.run_id));
        return { accepted: false, exhausted: false };
      }
      const exhausted = job.attempts >= snapshot.automaticRetryMaxAttempts;
      if (!exhausted) {
        await this.saveJob({ ...job, state: "queued", availableAt: new Date(input.now.getTime() + snapshot.automaticRetryBackoffMs).toISOString(), failure: copy(input.failure), leaseToken: undefined, leaseExpiresAt: undefined, updatedAt: nowText(input.now) }, String(row.run_id));
        return { accepted: true, exhausted: false };
      }
      // Provider exhaustion final-fails only this logical turn.  Contexts
      // discard it during their own candidate-revision replay; peers continue.
      await this.saveJob({ ...job, state: "failed", failure: copy(input.failure), leaseToken: undefined, leaseExpiresAt: undefined, updatedAt: nowText(input.now) }, String(row.run_id));
      await this.markFailedAttemptRetryWait(attempt, input.now);
      return { accepted: true, exhausted: true };
    });
  }
  async claimCommittableAttempt(input: { workerId: string; leaseMs: number; now: Date }): Promise<CommitWork | undefined> {
    return this.inTransaction(async () => {
      const found = await this.query(`
        SELECT a.attempt, s.snapshot FROM experiment_round_attempts a
        JOIN experiment_round_snapshots s ON s.snapshot_id = a.snapshot_id
        WHERE (a.state IN ('queued','running') OR (a.state = 'retry_wait' AND a.commit_started = TRUE)
               OR (a.state = 'committing' AND a.commit_lease_expires_at <= $1))
          AND NOT EXISTS (SELECT 1 FROM experiment_agent_jobs j WHERE j.attempt_id = a.attempt_id AND j.state <> 'succeeded')
        ORDER BY a.updated_at ASC FOR UPDATE OF a SKIP LOCKED LIMIT 1`, [input.now]);
      const row = found.rows[0];
      if (!row) return undefined;
      const attempt = row.attempt as RoundAttempt;
      const committing = { ...attempt, state: "committing" as const, commitStarted: true, updatedAt: nowText(input.now) };
      const commitLeaseToken = `${input.workerId}:commit:${attempt.attemptId}:${input.now.getTime()}`;
      await this.saveAttempt(committing);
      await this.query(`UPDATE experiment_round_attempts SET commit_lease_token = $2,
        commit_lease_expires_at = $3 WHERE attempt_id = $1`, [attempt.attemptId, commitLeaseToken, new Date(input.now.getTime() + input.leaseMs)]);
      return { attempt: copy(committing), snapshot: copy(row.snapshot as RoundSnapshot), jobs: await this.listAttemptJobs(attempt.attemptId), commitLeaseToken };
    });
  }
  async heartbeatCommit(input: { attemptId: string; leaseToken: string; leaseMs: number; now: Date }): Promise<boolean> {
    const result = await this.query(`UPDATE experiment_round_attempts SET commit_lease_expires_at = $3
      WHERE attempt_id = $1 AND state = 'committing' AND commit_lease_token = $2 AND commit_lease_expires_at > $4 RETURNING 1`,
    [input.attemptId, input.leaseToken, new Date(input.now.getTime() + input.leaseMs), input.now]);
    return result.rowCount === 1;
  }
  async loadLedger(attemptId: string) {
    const result = await this.query("SELECT step FROM experiment_commit_ledger_steps WHERE attempt_id = $1", [attemptId]);
    return result.rowCount ? { attemptId, completed: new Set(result.rows.map((row) => row.step as LedgerStep)) } : undefined;
  }
  async startLedger(attemptId: string) { return (await this.loadLedger(attemptId)) ?? { attemptId, completed: new Set() }; }
  async completeLedgerStep(attemptId: string, step: LedgerStep) {
    await this.query("INSERT INTO experiment_commit_ledger_steps (attempt_id, step) VALUES ($1, $2) ON CONFLICT DO NOTHING", [attemptId, step]);
    return (await this.loadLedger(attemptId))!;
  }
  async markCommitRetry(attemptId: string, failure: JobFailure) {
    await this.inTransaction(async () => {
      const found = await this.query("SELECT attempt FROM experiment_round_attempts WHERE attempt_id = $1 FOR UPDATE", [attemptId]);
      const attempt = found.rows[0]?.attempt as RoundAttempt | undefined;
      if (!attempt) throw new Error("attempt not found");
      if (["committed", "cancelled"].includes(attempt.state)) return;
      await this.saveAttempt({ ...attempt, state: "retry_wait", commitStarted: true, recentError: copy(failure), updatedAt: nowText() });
      await this.query("UPDATE experiment_round_attempts SET commit_lease_token = NULL, commit_lease_expires_at = NULL WHERE attempt_id = $1", [attemptId]);
      const run = await this.findRun(attempt.runId);
      if (run && !["cancelled", "completed"].includes(run.status.lifecycle)) {
        await this.saveRun({ ...run, status: { ...run.status, lifecycle: "retry_wait" } });
      }
    });
  }
  async markCommitted(attemptId: string, manifest: PluginManifest, status: RunRecord["status"]) {
    await this.inTransaction(async () => {
      const attempt = await this.findAttempt(attemptId);
      if (!attempt || attempt.state !== "committing") throw new Error("attempt is not committing");
      await this.saveManifest(manifest);
      await this.saveAttempt({ ...attempt, state: "committed", updatedAt: nowText() });
      await this.query("UPDATE experiment_round_attempts SET commit_lease_token = NULL, commit_lease_expires_at = NULL WHERE attempt_id = $1", [attemptId]);
      const run = await this.findRun(attempt.runId);
      if (!run) throw new Error("attempt owner run is missing");
      await this.saveRun({ ...run, status: copy(status) });
      if (status.lifecycle === "completed") await this.upsertRunRelease(status.runId);
    });
  }

  async enqueueRunRelease(runId: string) {
    await this.inTransaction(async () => { await this.upsertRunRelease(runId); });
  }
  async claimRunRelease(input: { workerId: string; leaseMs: number; now: Date }) {
    return this.inTransaction(async () => {
      await this.query(`UPDATE experiment_run_releases
        SET state = 'queued', available_at = $1, lease_token = NULL, lease_expires_at = NULL
        WHERE state = 'running' AND lease_expires_at <= $1`, [input.now]);
      const result = await this.query(`SELECT run_id, state, attempts, available_at, lease_token, lease_expires_at, recent_error, released_at
        FROM experiment_run_releases
        WHERE state = 'queued' AND available_at <= $1
          AND NOT EXISTS (
            SELECT 1 FROM experiment_agent_jobs j
            WHERE j.run_id = experiment_run_releases.run_id AND j.state = 'running'
          )
        ORDER BY available_at ASC, run_id ASC
        FOR UPDATE SKIP LOCKED LIMIT 1`, [input.now]);
      const row = result.rows[0];
      if (!row) return undefined;
      const runId = String(row.run_id);
      const attempts = Number(row.attempts) + 1;
      const leaseToken = `${input.workerId}:release:${runId}:${attempts}:${input.now.getTime()}`;
      const leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs);
      await this.query(`UPDATE experiment_run_releases
        SET state = 'running', attempts = $2, lease_token = $3, lease_expires_at = $4
        WHERE run_id = $1`, [runId, attempts, leaseToken, leaseExpiresAt]);
      return {
        runId,
        state: "running" as const,
        attempts,
        availableAt: timestampText(row.available_at),
        leaseToken,
        leaseExpiresAt: leaseExpiresAt.toISOString(),
        ...(row.recent_error ? { recentError: copy(row.recent_error as JobFailure) } : {}),
      } satisfies RunRelease;
    });
  }
  async completeRunRelease(input: { runId: string; leaseToken: string; now: Date }) {
    const result = await this.query(`UPDATE experiment_run_releases
      SET state = 'released', lease_token = NULL, lease_expires_at = NULL, recent_error = NULL, released_at = $3
      WHERE run_id = $1 AND state = 'running' AND lease_token = $2`, [input.runId, input.leaseToken, input.now]);
    return (result.rowCount ?? 0) > 0;
  }
  async failRunRelease(input: { runId: string; leaseToken: string; failure: JobFailure; retryBackoffMs: number; now: Date }) {
    const availableAt = new Date(input.now.getTime() + input.retryBackoffMs);
    const result = await this.query(`UPDATE experiment_run_releases
      SET state = 'queued', available_at = $3, lease_token = NULL, lease_expires_at = NULL, recent_error = $4::jsonb
      WHERE run_id = $1 AND state = 'running' AND lease_token = $2`, [input.runId, input.leaseToken, availableAt, JSON.stringify(input.failure)]);
    return (result.rowCount ?? 0) > 0;
  }

  async saveManifest(manifest: PluginManifest) {
    await this.query(`INSERT INTO experiment_manifests (ref, run_id, round_id, state, manifest) VALUES ($1, $2, $3, $4, $5::jsonb)
      ON CONFLICT (ref) DO UPDATE SET state = EXCLUDED.state, manifest = EXCLUDED.manifest`, [manifest.ref, manifest.runId, manifest.roundId, manifest.state, JSON.stringify(manifest)]);
  }
  async findManifest(ref: string) {
    const result = await this.query("SELECT manifest FROM experiment_manifests WHERE ref = $1", [ref]);
    return result.rows[0] ? parseStoredManifest(result.rows[0].manifest) : undefined;
  }
  async findManifestForRound(runId: string, roundId: number) {
    const result = await this.query("SELECT manifest FROM experiment_manifests WHERE run_id = $1 AND round_id = $2 AND state = 'committed'", [runId, roundId]);
    return result.rows[0] ? parseStoredManifest(result.rows[0].manifest) : undefined;
  }
  async listCommittedManifests(runId: string, input: { cursor?: string; limit: number }) {
    const after = decodeCursor(input.cursor);
    const params: unknown[] = [runId];
    let where = "run_id = $1 AND state = 'committed'";
    if (after) {
      params.push(after);
      where += ` AND (round_id, ref) > ((SELECT round_id FROM experiment_manifests WHERE run_id = $1 AND ref = $${params.length}), $${params.length})`;
    }
    params.push(input.limit + 1);
    const result = await this.query(`SELECT manifest FROM experiment_manifests WHERE ${where} ORDER BY round_id ASC, ref ASC LIMIT $${params.length}`, params);
    const items = result.rows.slice(0, input.limit).map((row) => parseStoredManifest(row.manifest));
    return { items, nextCursor: result.rows.length > input.limit ? cursor(items.at(-1)!.ref) : undefined };
  }
  async findReceipt<T>(scope: string, transitionId: string, stepId: string) {
    const result = await this.query("SELECT request_digest, result FROM experiment_mutation_receipts WHERE scope = $1 AND transition_id = $2 AND step_id = $3", [scope, transitionId, stepId]);
    return result.rows[0] ? { requestDigest: String(result.rows[0].request_digest), result: result.rows[0].result as T } : undefined;
  }
  async saveReceipt<T>(scope: string, transitionId: string, stepId: string, receipt: StoredReceipt<T>) {
    await this.query("INSERT INTO experiment_mutation_receipts (scope, transition_id, step_id, request_digest, result) VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT DO NOTHING", [scope, transitionId, stepId, receipt.requestDigest, JSON.stringify(receipt.result)]);
  }
  async findRunAgentRegistration(input: { runId: string; agentId: string }) {
    const result = await this.query("SELECT * FROM experiment_run_agent_registrations WHERE run_id = $1 AND agent_id = $2", [input.runId, input.agentId]);
    return result.rows[0] ? registrationFromRow(result.rows[0]) : undefined;
  }
  async listRunAgentRegistrations(runId: string) {
    const result = await this.query("SELECT * FROM experiment_run_agent_registrations WHERE run_id = $1 ORDER BY agent_id ASC", [runId]);
    return result.rows.map(registrationFromRow);
  }
  async revokeRunAgentRegistrations(input: { runId: string; revokedAt: string }) {
    await this.query(`UPDATE experiment_run_agent_registrations
      SET status = 'revoked', revoked_at = COALESCE(revoked_at, $2::timestamptz)
      WHERE run_id = $1 AND status = 'active'`, [input.runId, input.revokedAt]);
  }
  async listWorldGenerators() {
    const [drafts, versions] = await Promise.all([
      this.query("SELECT draft FROM experiment_world_generator_drafts ORDER BY draft->>'name' ASC"),
      this.query("SELECT version FROM experiment_world_generator_versions ORDER BY version->>'publishedAt' DESC"),
    ]);
    return {
      drafts: drafts.rows.map((row) => copy(row.draft as WorldGeneratorDraft)),
      versions: versions.rows.map((row) => copy(row.version as WorldGeneratorVersion)),
    };
  }
  async findWorldGeneratorDraft(generatorId: string) {
    const result = await this.query("SELECT draft FROM experiment_world_generator_drafts WHERE generator_id = $1", [generatorId]);
    return result.rows[0] ? copy(result.rows[0].draft as WorldGeneratorDraft) : undefined;
  }
  async findWorldGeneratorVersion(versionRef: string) {
    const result = await this.query("SELECT version FROM experiment_world_generator_versions WHERE version_ref = $1", [versionRef]);
    return result.rows[0] ? copy(result.rows[0].version as WorldGeneratorVersion) : undefined;
  }
  async saveWorldGeneratorDraft(draft: WorldGeneratorDraft) {
    await this.query("INSERT INTO experiment_world_generator_drafts (generator_id, draft) VALUES ($1, $2::jsonb) ON CONFLICT (generator_id) DO UPDATE SET draft = EXCLUDED.draft", [draft.generatorId, JSON.stringify(draft)]);
  }
  async saveWorldGeneratorVersion(version: WorldGeneratorVersion) {
    await this.query("INSERT INTO experiment_world_generator_versions (version_ref, version) VALUES ($1, $2::jsonb) ON CONFLICT (version_ref) DO NOTHING", [version.versionRef, JSON.stringify(version)]);
  }
  async listPopulations() { const [drafts, versions] = await Promise.all([this.query("SELECT draft FROM experiment_population_drafts ORDER BY draft->>'name' ASC"), this.query("SELECT version FROM experiment_population_versions ORDER BY version->>'publishedAt' DESC")]); return { drafts: drafts.rows.map((row) => copy(row.draft as PopulationDraft)), versions: versions.rows.map((row) => copy(row.version as PopulationVersion)) }; }
  async findPopulationDraft(populationId: string) { const result = await this.query("SELECT draft FROM experiment_population_drafts WHERE population_id = $1", [populationId]); return result.rows[0] ? copy(result.rows[0].draft as PopulationDraft) : undefined; }
  async findPopulationVersion(versionRef: string) { const result = await this.query("SELECT version FROM experiment_population_versions WHERE version_ref = $1", [versionRef]); return result.rows[0] ? copy(result.rows[0].version as PopulationVersion) : undefined; }
  async savePopulationDraft(draft: PopulationDraft) { await this.query("INSERT INTO experiment_population_drafts (population_id, draft) VALUES ($1, $2::jsonb) ON CONFLICT (population_id) DO UPDATE SET draft = EXCLUDED.draft", [draft.populationId, JSON.stringify(draft)]); }
  async savePopulationVersion(version: PopulationVersion) { await this.query("INSERT INTO experiment_population_versions (version_ref, version) VALUES ($1, $2::jsonb) ON CONFLICT (version_ref) DO NOTHING", [version.versionRef, JSON.stringify(version)]); }
  async listAgentBlueprints() { const [drafts, versions] = await Promise.all([this.query("SELECT draft FROM experiment_agent_blueprint_drafts ORDER BY draft->>'name' ASC"), this.query("SELECT version FROM experiment_agent_blueprint_versions ORDER BY version->>'publishedAt' DESC")]); return { drafts: drafts.rows.map((row) => copy(row.draft as AgentBlueprintDraft)), versions: versions.rows.map((row) => copy(row.version as AgentBlueprintVersion)) }; }
  async findAgentBlueprintDraft(blueprintId: string) { const result = await this.query("SELECT draft FROM experiment_agent_blueprint_drafts WHERE blueprint_id = $1", [blueprintId]); return result.rows[0] ? copy(result.rows[0].draft as AgentBlueprintDraft) : undefined; }
  async findAgentBlueprintVersion(versionRef: string) { const result = await this.query("SELECT version FROM experiment_agent_blueprint_versions WHERE version_ref = $1", [versionRef]); return result.rows[0] ? copy(result.rows[0].version as AgentBlueprintVersion) : undefined; }
  async saveAgentBlueprintDraft(draft: AgentBlueprintDraft) { await this.query("INSERT INTO experiment_agent_blueprint_drafts (blueprint_id, draft) VALUES ($1, $2::jsonb) ON CONFLICT (blueprint_id) DO UPDATE SET draft = EXCLUDED.draft", [draft.blueprintId, JSON.stringify(draft)]); }
  async saveAgentBlueprintVersion(version: AgentBlueprintVersion) { await this.query("INSERT INTO experiment_agent_blueprint_versions (version_ref, version) VALUES ($1, $2::jsonb) ON CONFLICT (version_ref) DO NOTHING", [version.versionRef, JSON.stringify(version)]); }
  async listTurnPrompts() {
    const [drafts, versions] = await Promise.all([this.query("SELECT draft FROM experiment_turn_prompt_drafts ORDER BY draft->>'name' ASC"), this.query("SELECT version FROM experiment_turn_prompt_versions ORDER BY version->>'publishedAt' DESC")]);
    return { drafts: drafts.rows.map((row) => copy(row.draft as TurnPromptDraft)), versions: versions.rows.map((row) => copy(row.version as TurnPromptVersion)) };
  }
  async findTurnPromptDraft(promptId: string) { const result = await this.query("SELECT draft FROM experiment_turn_prompt_drafts WHERE prompt_id = $1", [promptId]); return result.rows[0] ? copy(result.rows[0].draft as TurnPromptDraft) : undefined; }
  async findTurnPromptVersion(versionRef: string) { const result = await this.query("SELECT version FROM experiment_turn_prompt_versions WHERE version_ref = $1", [versionRef]); return result.rows[0] ? copy(result.rows[0].version as TurnPromptVersion) : undefined; }
  async saveTurnPromptDraft(draft: TurnPromptDraft) { await this.query("INSERT INTO experiment_turn_prompt_drafts (prompt_id, draft) VALUES ($1, $2::jsonb) ON CONFLICT (prompt_id) DO UPDATE SET draft = EXCLUDED.draft", [draft.promptId, JSON.stringify(draft)]); }
  async saveTurnPromptVersion(version: TurnPromptVersion) { await this.query("INSERT INTO experiment_turn_prompt_versions (version_ref, version) VALUES ($1, $2::jsonb) ON CONFLICT (version_ref) DO NOTHING", [version.versionRef, JSON.stringify(version)]); }
  async findAssetTombstone(input: { assetKind: string; target: "draft" | "version"; assetId: string }) {
    const result = await this.query("SELECT tombstone FROM experiment_asset_tombstones WHERE asset_kind = $1 AND target = $2 AND asset_id = $3", [input.assetKind, input.target, input.assetId]);
    return result.rows[0] ? copy(result.rows[0].tombstone as AssetTombstone) : undefined;
  }
  async listAssetTombstones(assetKind: string) {
    const result = await this.query("SELECT tombstone FROM experiment_asset_tombstones WHERE asset_kind = $1 ORDER BY tombstone->>'deletedAt' DESC", [assetKind]);
    return result.rows.map((row) => copy(row.tombstone as AssetTombstone));
  }
  async saveAssetTombstone(tombstone: AssetTombstone) {
    await this.query("INSERT INTO experiment_asset_tombstones (asset_kind, target, asset_id, idempotency_key, tombstone) VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT DO NOTHING", [tombstone.assetKind, tombstone.target, tombstone.assetId, tombstone.idempotencyKey, JSON.stringify(tombstone)]);
  }
  async close() { await this.pool.end(); }

  private async expireLeases(now: Date): Promise<void> {
    const expired = await this.query(`SELECT j.job, j.run_id, a.attempt, s.snapshot FROM experiment_agent_jobs j
      JOIN experiment_round_attempts a ON a.attempt_id = j.attempt_id JOIN experiment_round_snapshots s ON s.snapshot_id = a.snapshot_id
      WHERE j.state = 'running' AND j.lease_expires_at <= $1 FOR UPDATE OF j, a`, [now]);
    const exhaustedAttempts = new Map<string, RoundAttempt>();
    for (const row of expired.rows) {
      const job = row.job as AgentJob;
      const attempt = row.attempt as RoundAttempt;
      const snapshot = row.snapshot as RoundSnapshot;
      const failure: JobFailure = { category: "lease_expired", message: "worker lease expired before job completion", occurredAt: nowText(now) };
      if (attempt.state === "cancelled") {
        await this.saveJob({ ...job, state: "cancelled", failure, leaseToken: undefined, leaseExpiresAt: undefined, updatedAt: nowText(now) }, String(row.run_id));
        continue;
      }
      if (job.attempts >= snapshot.automaticRetryMaxAttempts) {
        await this.saveJob({ ...job, state: "failed", failure, leaseToken: undefined, leaseExpiresAt: undefined, updatedAt: nowText(now) }, String(row.run_id));
        exhaustedAttempts.set(attempt.attemptId, attempt);
      } else {
        await this.saveJob({ ...job, state: "queued", availableAt: nowText(now), failure, leaseToken: undefined, leaseExpiresAt: undefined, updatedAt: nowText(now) }, String(row.run_id));
      }
    }
    for (const attempt of exhaustedAttempts.values()) {
      await this.markFailedAttemptRetryWait(attempt, now);
    }
  }
  private async markFailedAttemptRetryWait(attempt: RoundAttempt, now: Date): Promise<void> {
    const counts = await this.query(`SELECT
      count(*) FILTER (WHERE state NOT IN ('succeeded','failed'))::integer AS nonterminal,
      count(*) FILTER (WHERE state = 'succeeded')::integer AS succeeded,
      count(*)::integer AS total,
      max(job #>> '{failure,occurredAt}') FILTER (WHERE state = 'failed') AS latest_failure_at
      FROM experiment_agent_jobs WHERE attempt_id = $1`, [attempt.attemptId]);
    const summary = counts.rows[0] as { nonterminal: number; succeeded: number; total: number; latest_failure_at: string | null } | undefined;
    if (!summary || Number(summary.total) === 0 || Number(summary.nonterminal) !== 0 || Number(summary.succeeded) === Number(summary.total)) return;
    const failed = Number(summary.total) - Number(summary.succeeded);
    const failure: JobFailure = {
      category: "agent_jobs_failed",
      message: `${failed} of ${Number(summary.total)} Agent jobs failed; all Agent jobs must succeed before the round can commit`,
      occurredAt: summary.latest_failure_at ?? nowText(now),
    };
    await this.saveAttempt({ ...attempt, state: "retry_wait", commitStarted: false, recentError: failure, updatedAt: nowText(now) });
    await this.query("UPDATE experiment_round_attempts SET commit_lease_token = NULL, commit_lease_expires_at = NULL WHERE attempt_id = $1", [attempt.attemptId]);
    const run = await this.findRun(attempt.runId);
    if (run && !["cancelled", "completed"].includes(run.status.lifecycle)) {
      await this.saveRun({ ...run, status: { ...run.status, lifecycle: "retry_wait" } });
    }
  }
  private async saveAttempt(attempt: RoundAttempt): Promise<void> {
    await this.query(`INSERT INTO experiment_round_attempts (attempt_id, run_id, round_id, snapshot_id, attempt_no, state, commit_started, attempt, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,now())
      ON CONFLICT (attempt_id) DO UPDATE SET state = EXCLUDED.state, commit_started = EXCLUDED.commit_started, attempt = EXCLUDED.attempt, updated_at = now()`, [attempt.attemptId, attempt.runId, attempt.roundId, attempt.snapshotId, attempt.attempt, attempt.state, attempt.commitStarted, JSON.stringify(attempt)]);
  }
  private async saveJob(job: AgentJob, runId: string): Promise<void> {
    await this.query(`INSERT INTO experiment_agent_jobs (job_id, attempt_id, run_id, declaration_index, state, available_at, lease_expires_at, job, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,now())
      ON CONFLICT (job_id) DO UPDATE SET state = EXCLUDED.state, available_at = EXCLUDED.available_at, lease_expires_at = EXCLUDED.lease_expires_at, job = EXCLUDED.job, updated_at = now()`, [job.jobId, job.attemptId, runId, job.declarationIndex, job.state, job.availableAt, job.leaseExpiresAt ?? null, JSON.stringify(job)]);
  }
  private async upsertRunRelease(runId: string): Promise<void> {
    await this.query(`INSERT INTO experiment_run_releases (run_id, state, attempts, available_at)
      VALUES ($1, 'queued', 0, now())
      ON CONFLICT (run_id) DO NOTHING`, [runId]);
  }
  private async query<Row extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]) {
    const client = this.transactionClient.getStore();
    return client ? client.query<Row>(text, values as unknown[] | undefined) : this.pool.query<Row>(text, values as unknown[] | undefined);
  }
  private async inTransaction<T>(operation: () => Promise<T>): Promise<T> {
    if (this.transactionClient.getStore()) return operation();
    return this.transaction((client) => this.transactionClient.run(client, operation));
  }
  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query("BEGIN"); const result = await operation(client); await client.query("COMMIT"); return result; }
    catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  private rowToRun(row: Record<string, unknown>): RunRecord {
    const status = row.status as Record<string, unknown>;
    const specification = row.specification;
    if (row.turn_prompt === null || row.turn_prompt === undefined) throw new Error("current Experiment run is missing its frozen Turn Prompt");
    return { status: runStatusSchema.parse(status), specification: pluginSpecificationSchema.parse(specification), specificationDigest: String(row.specification_digest), lineageParentManifestRef: row.lineage_parent_manifest_ref ? String(row.lineage_parent_manifest_ref) : undefined, turnPrompt: copy(row.turn_prompt as import("@openleek/contracts/turn-prompt").FrozenTurnPrompt), ...(row.resolved_world === null || row.resolved_world === undefined ? {} : { resolvedWorld: copy(row.resolved_world as import("./model").ResolvedWorldRecord) }) };
  }
}

function registrationFromRow(row: Record<string, unknown>): RunAgentRegistration {
  const status = row.status;
  if (status !== "active" && status !== "revoked") throw new Error("stored run Agent registration has an invalid status");
  const credentialVersion = Number(row.credential_version);
  if (!Number.isSafeInteger(credentialVersion) || credentialVersion < 1) throw new Error("stored run Agent registration has an invalid credential version");
  return {
    principalId: String(row.principal_id),
    runId: String(row.run_id),
    agentId: String(row.agent_id),
    credentialVersion,
    status,
    registeredAt: timestampText(row.registered_at),
    ...(row.revoked_at ? { revokedAt: timestampText(row.revoked_at) } : {}),
  };
}

function timestampText(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  throw new Error("stored timestamp is invalid");
}

/**
 * v2 manifest rows remain Console-readable after their run is stopped.  The
 * stored digest is historical evidence, so this adapter preserves it while
 * giving the read model explicit Context revision identities.
 */
function parseStoredManifest(value: unknown): PluginManifest { return pluginManifestSchema.parse(value); }
