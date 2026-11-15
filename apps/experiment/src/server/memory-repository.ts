import { type PluginManifest, type RoundProgress } from "@openleek/contracts/experiment";
import type { AssetTombstone } from "@openleek/contracts/assets";
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

const copy = <T>(value: T): T => structuredClone(value);
const nowText = (now = new Date()) => now.toISOString();

/**
 * In-memory test double for the Postgres work pool. It intentionally models
 * leases, the run-wide concurrency cap, and attempt transitions rather than
 * shortcutting a round into a synchronous service call.
 */
export class InMemoryExperimentRepository implements ExperimentRepository {
  readonly runs = new Map<string, RunRecord>();
  readonly ledgers = new Map<string, Ledger>();
  readonly manifests = new Map<string, PluginManifest>();
  readonly receipts = new Map<string, StoredReceipt<unknown>>();
  readonly snapshots = new Map<string, RoundSnapshot>();
  readonly attempts = new Map<string, RoundAttempt>();
  readonly jobs = new Map<string, AgentJob>();
  /** Durable in-memory counterpart of the terminal Agent Execution cleanup queue. */
  readonly runReleases = new Map<string, import("./model").RunRelease>();
  /** Durable in-memory stand-in for Experiment-owned run-local principals. */
  readonly runAgentRegistrations = new Map<string, RunAgentRegistration>();
  readonly worldGeneratorDrafts = new Map<string, WorldGeneratorDraft>();
  readonly worldGeneratorVersions = new Map<string, WorldGeneratorVersion>();
  readonly populationDrafts = new Map<string, PopulationDraft>();
  readonly populationVersions = new Map<string, PopulationVersion>();
  readonly agentBlueprintDrafts = new Map<string, AgentBlueprintDraft>();
  readonly agentBlueprintVersions = new Map<string, AgentBlueprintVersion>();
  readonly turnPromptDrafts = new Map<string, TurnPromptDraft>();
  readonly turnPromptVersions = new Map<string, TurnPromptVersion>();
  readonly assetTombstones = new Map<string, AssetTombstone>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly commitLeases = new Map<string, { token: string; expiresAt: number }>();

  async findRun(runId: string) {
    const run = this.runs.get(runId);
    return run && copy(run);
  }
  async createRun(run: RunRecord, registrations: readonly RunAgentRegistration[]) {
    await this.withLock(`run:${run.status.runId}`, async () => {
      if (this.runs.has(run.status.runId)) throw new Error(`run ${run.status.runId} already exists`);
      for (const registration of registrations) {
        if (registration.runId !== run.status.runId || this.runAgentRegistrations.has(registrationKey(registration.runId, registration.agentId))) {
          throw new Error(`run Agent registration already exists for ${registration.agentId}`);
        }
      }
      this.runs.set(run.status.runId, copy(run));
      for (const registration of registrations) this.runAgentRegistrations.set(registrationKey(registration.runId, registration.agentId), copy(registration));
    });
  }
  async saveRun(run: RunRecord) { this.runs.set(run.status.runId, copy(run)); }
  async listRuns(input: { cursor?: string; limit: number; lifecycle?: RunRecord["status"]["lifecycle"] }) {
    const records = [...this.runs.values()]
      .filter((run) => !input.lifecycle || run.status.lifecycle === input.lifecycle)
      .sort((left, right) => left.status.runId.localeCompare(right.status.runId));
    const start = input.cursor ? Math.max(0, records.findIndex((run) => run.status.runId === input.cursor) + 1) : 0;
    const items = records.slice(start, start + input.limit).map(copy);
    return { items, nextCursor: records.length > start + input.limit ? items.at(-1)?.status.runId : undefined };
  }

  async withRunLock<T>(runId: string, operation: () => Promise<T>): Promise<T> { return this.withLock(`run:${runId}`, operation); }

  async findActiveAttempt(runId: string) {
    return [...this.attempts.values()]
      .filter((attempt) => attempt.runId === runId && !["committed", "cancelled"].includes(attempt.state))
      .sort((left, right) => right.attempt - left.attempt)[0] && copy([...this.attempts.values()]
        .filter((attempt) => attempt.runId === runId && !["committed", "cancelled"].includes(attempt.state))
        .sort((left, right) => right.attempt - left.attempt)[0]!);
  }

  async findRunReadyForAutomaticAdvance() {
    for (const run of [...this.runs.values()].sort((left, right) => left.status.runId.localeCompare(right.status.runId))) {
      if (
        run.specification.executionPolicy.roundAdvancement === "automatic"
        && ["queued", "running"].includes(run.status.lifecycle)
        && run.status.committedRound < run.status.configuredRounds
        && (run.status.advanceRetry === undefined || new Date(run.status.advanceRetry.nextRetryAt) <= new Date())
        && await this.findActiveAttempt(run.status.runId) === undefined
      ) return copy(run);
    }
    return undefined;
  }

  async saveSnapshotAndAttempt(snapshot: RoundSnapshot, attempt: RoundAttempt, jobs: readonly AgentJob[]) {
    await this.withLock("pool", async () => {
      if (this.snapshots.has(snapshot.snapshotId) || this.attempts.has(attempt.attemptId)) throw new Error("snapshot or attempt already exists");
      this.snapshots.set(snapshot.snapshotId, copy(snapshot));
      this.attempts.set(attempt.attemptId, copy(attempt));
      for (const job of jobs) {
        if (this.jobs.has(job.jobId)) throw new Error(`job ${job.jobId} already exists`);
        this.jobs.set(job.jobId, copy(job));
      }
    });
  }
  async findSnapshot(snapshotId: string) { return this.snapshots.get(snapshotId) && copy(this.snapshots.get(snapshotId)!); }
  async findAttempt(attemptId: string) { return this.attempts.get(attemptId) && copy(this.attempts.get(attemptId)!); }
  async listAttemptJobs(attemptId: string) {
    return [...this.jobs.values()].filter((job) => job.attemptId === attemptId).sort((left, right) => left.declarationIndex - right.declarationIndex).map(copy);
  }
  async getRoundProgress(runId: string): Promise<RoundProgress | undefined> {
    const attempt = [...this.attempts.values()]
      .filter((item) => item.runId === runId)
      .sort((a, b) => b.roundId - a.roundId || b.attempt - a.attempt || b.updatedAt.localeCompare(a.updatedAt))[0];
    if (!attempt) return undefined;
    const snapshot = this.snapshots.get(attempt.snapshotId);
    if (!snapshot) throw new Error("attempt snapshot is missing");
    const jobs = [...this.jobs.values()].filter((job) => job.attemptId === attempt.attemptId);
    const counts = { queued: 0, running: 0, succeeded: 0, failed: 0 };
    const failureCategories: Record<string, number> = {};
    let recentError = attempt.recentError;
    for (const job of jobs) {
      if (job.state in counts) counts[job.state as keyof typeof counts] += 1;
      if (job.failure) {
        failureCategories[job.failure.category] = (failureCategories[job.failure.category] ?? 0) + 1;
        if (!recentError || job.failure.occurredAt > recentError.occurredAt) recentError = job.failure;
      }
    }
    return {
      runId,
      roundId: attempt.roundId,
      snapshotId: snapshot.snapshotId,
      snapshotDigest: snapshot.digest,
      attempt: attempt.attempt,
      state: attempt.state,
      total: jobs.length,
      ...counts,
      failureCategories,
      ...(recentError ? { recentError: `${recentError.category}: ${recentError.message}` } : {}),
    };
  }
  async createRetryAttempt(previous: RoundAttempt, retry: RoundAttempt, jobs: readonly AgentJob[]) {
    await this.withLock("pool", async () => {
      const current = this.attempts.get(previous.attemptId);
      if (!current || current.state !== "retry_wait" || current.commitStarted) throw new Error("attempt is not eligible for provider retry");
      if (this.attempts.has(retry.attemptId)) throw new Error("retry attempt already exists");
      this.attempts.set(retry.attemptId, copy(retry));
      for (const job of jobs) this.jobs.set(job.jobId, copy(job));
    });
  }
  async markAttemptQueued(attemptId: string) {
    return this.withLock("pool", async () => {
      const attempt = this.requireAttempt(attemptId);
      if (attempt.state !== "retry_wait" || !attempt.commitStarted) throw new Error("attempt is not eligible for commit retry");
      const next = { ...attempt, state: "queued" as const, updatedAt: nowText() };
      this.attempts.set(attemptId, next);
      return copy(next);
    });
  }
  async cancelActiveAttempt(runId: string) {
    await this.withLock("pool", async () => {
      for (const attempt of this.attempts.values()) {
        if (attempt.runId !== runId || ["committed", "cancelled"].includes(attempt.state)) continue;
        this.attempts.set(attempt.attemptId, { ...attempt, state: "cancelled", updatedAt: nowText() });
        for (const job of this.jobs.values()) {
          if (job.attemptId !== attempt.attemptId || ["succeeded", "failed", "cancelled"].includes(job.state)) continue;
          if (job.state === "queued") this.jobs.set(job.jobId, { ...job, state: "cancelled", leaseToken: undefined, leaseExpiresAt: undefined, updatedAt: nowText() });
        }
      }
    });
  }

  async claimNextJob(input: { workerId: string; leaseMs: number; now: Date }): Promise<ClaimedJob | undefined> {
    return this.withLock("pool", async () => {
      this.expireLeases(input.now);
      const candidates = [...this.jobs.values()]
        .filter((job) => job.state === "queued" && new Date(job.availableAt) <= input.now)
        .sort((a, b) => a.availableAt.localeCompare(b.availableAt) || a.declarationIndex - b.declarationIndex || a.jobId.localeCompare(b.jobId));
      for (const candidate of candidates) {
        const attempt = this.requireAttempt(candidate.attemptId);
        if (!["queued", "running"].includes(attempt.state)) continue;
        const snapshot = this.requireSnapshot(attempt.snapshotId);
        const running = [...this.jobs.values()].filter((job) => {
          if (job.state !== "running") return false;
          const owner = this.attempts.get(job.attemptId);
          return owner?.runId === attempt.runId;
        }).length;
        if (running >= snapshot.maxConcurrentAgents) continue;
        const token = `${input.workerId}:${candidate.jobId}:${candidate.attempts + 1}:${input.now.getTime()}`;
        const leased: AgentJob = {
          ...candidate,
          state: "running",
          attempts: candidate.attempts + 1,
          leaseToken: token,
          leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs).toISOString(),
          updatedAt: nowText(input.now),
        };
        this.jobs.set(leased.jobId, leased);
        if (attempt.state === "queued") this.attempts.set(attempt.attemptId, { ...attempt, state: "running", updatedAt: nowText(input.now) });
        return { job: copy(leased), attempt: copy(this.requireAttempt(leased.attemptId)), snapshot: copy(snapshot) };
      }
      return undefined;
    });
  }
  async heartbeatJob(input: { jobId: string; leaseToken: string; leaseMs: number; now: Date }) {
    return this.withLock("pool", async () => {
      const job = this.jobs.get(input.jobId);
      if (!job || job.state !== "running" || job.leaseToken !== input.leaseToken) return false;
      this.jobs.set(job.jobId, { ...job, leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs).toISOString(), updatedAt: nowText(input.now) });
      return true;
    });
  }
  async completeJob(input: { jobId: string; leaseToken: string; result: readonly import("@openleek/contracts/experiment").CandidateAction[]; resultDigest: string; now: Date }) {
    return this.withLock("pool", async () => {
      const job = this.jobs.get(input.jobId);
      if (!job || job.state !== "running" || job.leaseToken !== input.leaseToken) return false;
      const attempt = this.requireAttempt(job.attemptId);
      if (attempt.state === "cancelled") {
        this.jobs.set(job.jobId, { ...job, state: "cancelled", leaseToken: undefined, leaseExpiresAt: undefined, updatedAt: nowText(input.now) });
        return false;
      }
      this.jobs.set(job.jobId, { ...job, state: "succeeded", result: copy(input.result), resultDigest: input.resultDigest, failure: undefined, leaseToken: undefined, leaseExpiresAt: undefined, updatedAt: nowText(input.now) });
      this.markFailedAttemptRetryWait(attempt, input.now);
      return true;
    });
  }
  async failJob(input: { jobId: string; leaseToken: string; failure: JobFailure; now: Date }) {
    return this.withLock("pool", async () => {
      const job = this.jobs.get(input.jobId);
      if (!job || job.state !== "running" || job.leaseToken !== input.leaseToken) return { accepted: false, exhausted: false };
      const attempt = this.requireAttempt(job.attemptId);
      const snapshot = this.requireSnapshot(attempt.snapshotId);
      if (attempt.state === "cancelled") {
        this.jobs.set(job.jobId, { ...job, state: "cancelled", failure: copy(input.failure), leaseToken: undefined, leaseExpiresAt: undefined, updatedAt: nowText(input.now) });
        return { accepted: false, exhausted: false };
      }
      const exhausted = job.attempts >= snapshot.automaticRetryMaxAttempts;
      if (!exhausted) {
        this.jobs.set(job.jobId, {
          ...job,
          state: "queued",
          availableAt: new Date(input.now.getTime() + snapshot.automaticRetryBackoffMs).toISOString(),
          failure: copy(input.failure),
          leaseToken: undefined,
          leaseExpiresAt: undefined,
          updatedAt: nowText(input.now),
        });
        return { accepted: true, exhausted: false };
      }
      // An exhausted provider retry is local to one Agent turn.  The Context
      // worktrees will discard this turn during candidate-revision replay;
      // other jobs in the frozen round continue normally.
      this.jobs.set(job.jobId, { ...job, state: "failed", failure: copy(input.failure), leaseToken: undefined, leaseExpiresAt: undefined, updatedAt: nowText(input.now) });
      this.markFailedAttemptRetryWait(attempt, input.now);
      return { accepted: true, exhausted: true };
    });
  }
  async claimCommittableAttempt(input: { workerId: string; leaseMs: number; now: Date }): Promise<CommitWork | undefined> {
    return this.withLock("pool", async () => {
      const candidate = [...this.attempts.values()]
        .filter((attempt) =>
          ["queued", "running"].includes(attempt.state)
          || (attempt.state === "retry_wait" && attempt.commitStarted)
          || (attempt.state === "committing" && (this.commitLeases.get(attempt.attemptId)?.expiresAt ?? 0) <= input.now.getTime()),
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (!candidate) return undefined;
      const jobs = [...this.jobs.values()].filter((job) => job.attemptId === candidate.attemptId);
      if (!jobs.length || !jobs.every((job) => job.state === "succeeded")) return undefined;
      const committing = { ...candidate, state: "committing" as const, commitStarted: true, updatedAt: nowText(input.now) };
      const commitLeaseToken = `${input.workerId}:commit:${candidate.attemptId}:${input.now.getTime()}`;
      this.attempts.set(committing.attemptId, committing);
      this.commitLeases.set(committing.attemptId, { token: commitLeaseToken, expiresAt: input.now.getTime() + input.leaseMs });
      return { attempt: copy(committing), snapshot: copy(this.requireSnapshot(committing.snapshotId)), jobs: jobs.sort((a, b) => a.declarationIndex - b.declarationIndex).map(copy), commitLeaseToken };
    });
  }
  async heartbeatCommit(input: { attemptId: string; leaseToken: string; leaseMs: number; now: Date }): Promise<boolean> {
    const lease = this.commitLeases.get(input.attemptId);
    if (!lease || lease.token !== input.leaseToken || lease.expiresAt <= input.now.getTime()) return false;
    this.commitLeases.set(input.attemptId, { token: lease.token, expiresAt: input.now.getTime() + input.leaseMs });
    return true;
  }
  async loadLedger(attemptId: string) { return this.ledgers.get(attemptId) && copy(this.ledgers.get(attemptId)!); }
  async startLedger(attemptId: string) {
    const existing = this.ledgers.get(attemptId);
    if (existing) return copy(existing);
    const ledger: Ledger = { attemptId, completed: new Set() };
    this.ledgers.set(attemptId, copy(ledger));
    return ledger;
  }
  async completeLedgerStep(attemptId: string, step: LedgerStep) {
    const ledger = this.ledgers.get(attemptId);
    if (!ledger) throw new Error(`ledger ${attemptId} does not exist`);
    const next: Ledger = { attemptId, completed: new Set([...ledger.completed, step]) };
    this.ledgers.set(attemptId, copy(next));
    return copy(next);
  }
  async markCommitRetry(attemptId: string, failure: JobFailure) {
    await this.withLock("pool", async () => {
      const attempt = this.requireAttempt(attemptId);
      if (["committed", "cancelled"].includes(attempt.state)) return;
      this.attempts.set(attemptId, { ...attempt, state: "retry_wait", commitStarted: true, recentError: copy(failure), updatedAt: nowText() });
      this.commitLeases.delete(attemptId);
      const run = this.requireRun(attempt.runId);
      if (!["cancelled", "completed"].includes(run.status.lifecycle)) {
        this.runs.set(run.status.runId, { ...run, status: { ...run.status, lifecycle: "retry_wait" } });
      }
    });
  }
  async markCommitted(attemptId: string, manifest: PluginManifest, status: RunRecord["status"]) {
    await this.withLock("pool", async () => {
      const attempt = this.requireAttempt(attemptId);
      if (attempt.state !== "committing") throw new Error("attempt is not committing");
      this.manifests.set(manifest.ref, copy(manifest));
      this.attempts.set(attemptId, { ...attempt, state: "committed", updatedAt: nowText() });
      this.commitLeases.delete(attemptId);
      const run = this.requireRun(attempt.runId);
      this.runs.set(run.status.runId, { ...run, status: copy(status) });
      if (status.lifecycle === "completed") this.ensureRunRelease(status.runId);
    });
  }

  async enqueueRunRelease(runId: string) {
    await this.withLock("pool", async () => { this.ensureRunRelease(runId); });
  }
  async claimRunRelease(input: { workerId: string; leaseMs: number; now: Date }) {
    return this.withLock("pool", async () => {
      for (const [runId, release] of this.runReleases) {
        if (release.state !== "running" || !release.leaseExpiresAt || new Date(release.leaseExpiresAt) > input.now) continue;
        this.runReleases.set(runId, {
          ...release,
          state: "queued",
          availableAt: nowText(input.now),
          leaseToken: undefined,
          leaseExpiresAt: undefined,
        });
      }
      const candidate = [...this.runReleases.values()]
        .filter((release) => release.state === "queued"
          && new Date(release.availableAt) <= input.now
          && ![...this.jobs.values()].some((job) => job.state === "running" && this.attempts.get(job.attemptId)?.runId === release.runId))
        .sort((left, right) => left.availableAt.localeCompare(right.availableAt) || left.runId.localeCompare(right.runId))[0];
      if (!candidate) return undefined;
      const leaseToken = `${input.workerId}:release:${candidate.runId}:${candidate.attempts + 1}:${input.now.getTime()}`;
      const claimed = {
        ...candidate,
        state: "running" as const,
        attempts: candidate.attempts + 1,
        leaseToken,
        leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs).toISOString(),
      };
      this.runReleases.set(claimed.runId, claimed);
      return copy(claimed);
    });
  }
  async completeRunRelease(input: { runId: string; leaseToken: string; now: Date }) {
    return this.withLock("pool", async () => {
      const release = this.runReleases.get(input.runId);
      if (!release || release.state !== "running" || release.leaseToken !== input.leaseToken) return false;
      this.runReleases.set(input.runId, {
        ...release,
        state: "released",
        leaseToken: undefined,
        leaseExpiresAt: undefined,
        recentError: undefined,
        releasedAt: nowText(input.now),
      });
      return true;
    });
  }
  async failRunRelease(input: { runId: string; leaseToken: string; failure: JobFailure; retryBackoffMs: number; now: Date }) {
    return this.withLock("pool", async () => {
      const release = this.runReleases.get(input.runId);
      if (!release || release.state !== "running" || release.leaseToken !== input.leaseToken) return false;
      this.runReleases.set(input.runId, {
        ...release,
        state: "queued",
        availableAt: new Date(input.now.getTime() + input.retryBackoffMs).toISOString(),
        leaseToken: undefined,
        leaseExpiresAt: undefined,
        recentError: copy(input.failure),
      });
      return true;
    });
  }

  async saveManifest(manifest: PluginManifest) { this.manifests.set(manifest.ref, copy(manifest)); }
  async findManifest(ref: string) { return this.manifests.get(ref) && copy(this.manifests.get(ref)!); }
  async findManifestForRound(runId: string, roundId: number) {
    const value = [...this.manifests.values()].find((manifest) => manifest.runId === runId && manifest.roundId === roundId && manifest.state === "committed");
    return value && copy(value);
  }
  async listCommittedManifests(runId: string, input: { cursor?: string; limit: number }) {
    const records = [...this.manifests.values()].filter((manifest) => manifest.runId === runId && manifest.state === "committed").sort((a, b) => a.roundId - b.roundId);
    const start = input.cursor ? Math.max(0, records.findIndex((manifest) => manifest.ref === input.cursor) + 1) : 0;
    const items = records.slice(start, start + input.limit).map(copy);
    return { items, nextCursor: records.length > start + input.limit ? items.at(-1)?.ref : undefined };
  }
  async findReceipt<T>(scope: string, transitionId: string, stepId: string) { return this.receipts.get(JSON.stringify([scope, transitionId, stepId])) as StoredReceipt<T> | undefined; }
  async saveReceipt<T>(scope: string, transitionId: string, stepId: string, receipt: StoredReceipt<T>) { this.receipts.set(JSON.stringify([scope, transitionId, stepId]), copy(receipt)); }
  async findRunAgentRegistration(input: { runId: string; agentId: string }) {
    const registration = this.runAgentRegistrations.get(registrationKey(input.runId, input.agentId));
    return registration && copy(registration);
  }
  async listRunAgentRegistrations(runId: string) {
    return [...this.runAgentRegistrations.values()]
      .filter((registration) => registration.runId === runId)
      .sort((left, right) => left.agentId.localeCompare(right.agentId))
      .map(copy);
  }
  async revokeRunAgentRegistrations(input: { runId: string; revokedAt: string }) {
    // Callers normally already hold the run lock (cancellation). Avoid a
    // non-reentrant lock acquisition while preserving atomic run ownership.
    for (const [key, registration] of this.runAgentRegistrations) {
      if (registration.runId !== input.runId || registration.status === "revoked") continue;
      this.runAgentRegistrations.set(key, { ...registration, status: "revoked", revokedAt: input.revokedAt });
    }
  }

  async listWorldGenerators() {
    return {
      drafts: [...this.worldGeneratorDrafts.values()].sort((left, right) => left.name.localeCompare(right.name)).map(copy),
      versions: [...this.worldGeneratorVersions.values()].sort((left, right) => right.publishedAt.localeCompare(left.publishedAt)).map(copy),
    };
  }
  async findWorldGeneratorDraft(generatorId: string) { const value = this.worldGeneratorDrafts.get(generatorId); return value && copy(value); }
  async findWorldGeneratorVersion(versionRef: string) { const value = this.worldGeneratorVersions.get(versionRef); return value && copy(value); }
  async saveWorldGeneratorDraft(draft: WorldGeneratorDraft) { this.worldGeneratorDrafts.set(draft.generatorId, copy(draft)); }
  async saveWorldGeneratorVersion(version: WorldGeneratorVersion) { this.worldGeneratorVersions.set(version.versionRef, copy(version)); }
  async listPopulations() { return { drafts: [...this.populationDrafts.values()].sort((a, b) => a.name.localeCompare(b.name)).map(copy), versions: [...this.populationVersions.values()].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).map(copy) }; }
  async findPopulationDraft(populationId: string) { const value = this.populationDrafts.get(populationId); return value && copy(value); }
  async findPopulationVersion(versionRef: string) { const value = this.populationVersions.get(versionRef); return value && copy(value); }
  async savePopulationDraft(draft: PopulationDraft) { this.populationDrafts.set(draft.populationId, copy(draft)); }
  async savePopulationVersion(version: PopulationVersion) { this.populationVersions.set(version.versionRef, copy(version)); }
  async listAgentBlueprints() { return { drafts: [...this.agentBlueprintDrafts.values()].sort((a, b) => a.name.localeCompare(b.name)).map(copy), versions: [...this.agentBlueprintVersions.values()].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).map(copy) }; }
  async findAgentBlueprintDraft(blueprintId: string) { const value = this.agentBlueprintDrafts.get(blueprintId); return value && copy(value); }
  async findAgentBlueprintVersion(versionRef: string) { const value = this.agentBlueprintVersions.get(versionRef); return value && copy(value); }
  async saveAgentBlueprintDraft(draft: AgentBlueprintDraft) { this.agentBlueprintDrafts.set(draft.blueprintId, copy(draft)); }
  async saveAgentBlueprintVersion(version: AgentBlueprintVersion) { this.agentBlueprintVersions.set(version.versionRef, copy(version)); }
  async listTurnPrompts() { return { drafts: [...this.turnPromptDrafts.values()].sort((a, b) => a.name.localeCompare(b.name)).map(copy), versions: [...this.turnPromptVersions.values()].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).map(copy) }; }
  async findTurnPromptDraft(promptId: string) { const value = this.turnPromptDrafts.get(promptId); return value && copy(value); }
  async findTurnPromptVersion(versionRef: string) { const value = this.turnPromptVersions.get(versionRef); return value && copy(value); }
  async saveTurnPromptDraft(draft: TurnPromptDraft) { this.turnPromptDrafts.set(draft.promptId, copy(draft)); }
  async saveTurnPromptVersion(version: TurnPromptVersion) { this.turnPromptVersions.set(version.versionRef, copy(version)); }
  async findAssetTombstone(input: { assetKind: string; target: "draft" | "version"; assetId: string }) { const value = this.assetTombstones.get(assetTombstoneKey(input.assetKind, input.target, input.assetId)); return value && copy(value); }
  async listAssetTombstones(assetKind: string) { return [...this.assetTombstones.values()].filter((item) => item.assetKind === assetKind).map(copy); }
  async saveAssetTombstone(tombstone: AssetTombstone) { this.assetTombstones.set(assetTombstoneKey(tombstone.assetKind, tombstone.target, tombstone.assetId), copy(tombstone)); }

  private expireLeases(now: Date): void {
    const exhaustedAttempts = new Map<string, RoundAttempt>();
    for (const job of this.jobs.values()) {
      if (job.state !== "running" || !job.leaseExpiresAt || new Date(job.leaseExpiresAt) > now) continue;
      const attempt = this.requireAttempt(job.attemptId);
      const snapshot = this.requireSnapshot(attempt.snapshotId);
      const failure: JobFailure = { category: "lease_expired", message: "worker lease expired before job completion", occurredAt: nowText(now) };
      if (attempt.state === "cancelled") {
        this.jobs.set(job.jobId, { ...job, state: "cancelled", failure, leaseToken: undefined, leaseExpiresAt: undefined, updatedAt: nowText(now) });
        continue;
      }
      if (job.attempts >= snapshot.automaticRetryMaxAttempts) {
        this.jobs.set(job.jobId, { ...job, state: "failed", failure, leaseToken: undefined, leaseExpiresAt: undefined, updatedAt: nowText(now) });
        exhaustedAttempts.set(attempt.attemptId, attempt);
      } else {
        this.jobs.set(job.jobId, { ...job, state: "queued", availableAt: nowText(now), failure, leaseToken: undefined, leaseExpiresAt: undefined, updatedAt: nowText(now) });
      }
    }
    for (const attempt of exhaustedAttempts.values()) {
      this.markFailedAttemptRetryWait(attempt, now);
    }
  }
  private markFailedAttemptRetryWait(attempt: RoundAttempt, now: Date): void {
    const attemptJobs = [...this.jobs.values()].filter((candidate) => candidate.attemptId === attempt.attemptId);
    const allTerminal = attemptJobs.length > 0 && attemptJobs.every((candidate) => ["succeeded", "failed"].includes(candidate.state));
    const failedJobs = attemptJobs.filter((candidate) => candidate.state === "failed");
    if (!allTerminal || failedJobs.length === 0) return;
    const failure: JobFailure = {
      category: "agent_jobs_failed",
      message: `${failedJobs.length} of ${attemptJobs.length} Agent jobs failed; all Agent jobs must succeed before the round can commit`,
      occurredAt: failedJobs.map((job) => job.failure?.occurredAt ?? nowText(now)).sort().at(-1)!,
    };
    this.attempts.set(attempt.attemptId, { ...attempt, state: "retry_wait", commitStarted: false, recentError: failure, updatedAt: nowText(now) });
    const run = this.runs.get(attempt.runId);
    if (run && !["cancelled", "completed"].includes(run.status.lifecycle)) {
      this.runs.set(run.status.runId, { ...run, status: { ...run.status, lifecycle: "retry_wait" } });
    }
  }
  private requireAttempt(attemptId: string) { const value = this.attempts.get(attemptId); if (!value) throw new Error(`attempt ${attemptId} does not exist`); return value; }
  private requireSnapshot(snapshotId: string) { const value = this.snapshots.get(snapshotId); if (!value) throw new Error(`snapshot ${snapshotId} does not exist`); return value; }
  private requireRun(runId: string) { const value = this.runs.get(runId); if (!value) throw new Error(`run ${runId} does not exist`); return value; }
  private ensureRunRelease(runId: string): void {
    const existing = this.runReleases.get(runId);
    if (existing) return;
    this.runReleases.set(runId, {
      runId,
      state: "queued",
      attempts: 0,
      availableAt: nowText(),
    });
  }
  private async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.locks.set(key, queued);
    await previous;
    try { return await operation(); } finally { release(); if (this.locks.get(key) === queued) this.locks.delete(key); }
  }
}

const registrationKey = (runId: string, agentId: string) => `${runId}\u0000${agentId}`;
const assetTombstoneKey = (assetKind: string, target: string, assetId: string) => `${assetKind}\u0000${target}\u0000${assetId}`;
