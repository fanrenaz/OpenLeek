import type { AgentExecutionSnapshot, AgentExecutionStateStore, SqlExecutor } from "./ports";
import { agentSessionTranscriptSchema } from "@openleek/contracts/observability";
import type { AgentSessionTranscript } from "./types";

export class InMemoryAgentExecutionStateStore implements AgentExecutionStateStore {
  private snapshot: AgentExecutionSnapshot | null = null;
  private readonly transcripts = new Map<string, AgentSessionTranscript>();

  async load(): Promise<AgentExecutionSnapshot | null> {
    return this.snapshot === null ? null : structuredClone(this.snapshot);
  }

  async save(snapshot: AgentExecutionSnapshot): Promise<void> {
    this.snapshot = structuredClone(snapshot);
  }

  async commitExecution(snapshot: AgentExecutionSnapshot, transcript: AgentSessionTranscript): Promise<void> {
    const existing = this.transcripts.get(transcript.transcriptRef);
    if (existing && existing.digest !== transcript.digest) throw new Error("Agent transcript idempotency conflict");
    this.transcripts.set(transcript.transcriptRef, structuredClone(transcript));
    this.snapshot = structuredClone(snapshot);
  }

  async appendTranscript(transcript: AgentSessionTranscript): Promise<void> {
    const existing = this.transcripts.get(transcript.transcriptRef);
    if (existing && existing.digest !== transcript.digest) throw new Error("Agent transcript idempotency conflict");
    this.transcripts.set(transcript.transcriptRef, structuredClone(transcript));
  }

  async listTranscripts(runId: string): Promise<readonly AgentSessionTranscript[]> {
    return [...this.transcripts.values()]
      .filter((item) => item.runId === runId)
      .sort(compareTranscripts)
      .map((item) => structuredClone(item));
  }
}

/**
 * PostgreSQL state owner. It takes an injected pool/client so this package does
 * not couple itself to a Python adapter or a shared runtime singleton.
 */
export class PostgresAgentExecutionStateStore implements AgentExecutionStateStore {
  private initialized = false;

  constructor(private readonly db: SqlExecutor) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.db.query(`
      create table if not exists agent_execution_runtime_state (
        state_key text primary key,
        snapshot jsonb not null,
        updated_at timestamptz not null default now()
      )
    `);
    await this.db.query(`
      create table if not exists agent_execution_transcripts (
        transcript_ref text primary key,
        run_id text not null,
        round_id integer not null check (round_id >= 0),
        agent_id text not null,
        attempt_id text not null,
        orchestration_turn_id text not null,
        thread_id text not null,
        turn_id text not null,
        digest text not null,
        transcript jsonb not null,
        created_at timestamptz not null default now(),
        unique (run_id, agent_id, turn_id)
      )
    `);
    await this.db.query(`create index if not exists agent_execution_transcripts_run_order_idx on agent_execution_transcripts (run_id, round_id, agent_id, created_at, turn_id)`);
    this.initialized = true;
  }

  async load(): Promise<AgentExecutionSnapshot | null> {
    await this.initialize();
    const result = await this.db.query<{ snapshot: AgentExecutionSnapshot }>(
      "select snapshot from agent_execution_runtime_state where state_key = $1",
      ["current"],
    );
    return result.rows[0]?.snapshot ? structuredClone(result.rows[0].snapshot) : null;
  }

  async save(snapshot: AgentExecutionSnapshot): Promise<void> {
    await this.initialize();
    await this.saveWith(this.db, snapshot);
  }

  async commitExecution(snapshot: AgentExecutionSnapshot, transcript: AgentSessionTranscript): Promise<void> {
    await this.initialize();
    const operation = async (db: SqlExecutor) => {
      await this.insertTranscript(db, transcript);
      await this.saveWith(db, snapshot);
    };
    if (this.db.transaction) await this.db.transaction(operation);
    else await operation(this.db);
  }

  async appendTranscript(transcript: AgentSessionTranscript): Promise<void> {
    await this.initialize();
    await this.insertTranscript(this.db, transcript);
  }

  async listTranscripts(runId: string): Promise<readonly AgentSessionTranscript[]> {
    await this.initialize();
    const result = await this.db.query<{ transcript: unknown }>(
      `select transcript from agent_execution_transcripts
       where run_id = $1
       order by round_id asc, agent_id asc, created_at asc, turn_id asc`,
      [runId],
    );
    return result.rows.map((row) => agentSessionTranscriptSchema.parse(row.transcript));
  }

  private async saveWith(db: SqlExecutor, snapshot: AgentExecutionSnapshot): Promise<void> {
    await db.query(
      `insert into agent_execution_runtime_state (state_key, snapshot)
       values ($1, $2::jsonb)
       on conflict (state_key) do update
       set snapshot = excluded.snapshot, updated_at = now()`,
      ["current", JSON.stringify(snapshot)],
    );
  }

  private async insertTranscript(db: SqlExecutor, transcript: AgentSessionTranscript): Promise<void> {
    const existing = await db.query<{ digest: string }>(
      "select digest from agent_execution_transcripts where transcript_ref = $1 or (run_id = $2 and agent_id = $3 and turn_id = $4)",
      [transcript.transcriptRef, transcript.runId, transcript.agentId, transcript.turnId],
    );
    if (existing.rows.some((row) => row.digest !== transcript.digest)) throw new Error("Agent transcript idempotency conflict");
    if (existing.rows.length === 0) {
      await db.query(
        `insert into agent_execution_transcripts
         (transcript_ref, run_id, round_id, agent_id, attempt_id, orchestration_turn_id, thread_id, turn_id, digest, transcript)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
        [transcript.transcriptRef, transcript.runId, transcript.roundId, transcript.agentId, transcript.attemptId, transcript.orchestrationTurnId, transcript.threadId, transcript.turnId, transcript.digest, JSON.stringify(transcript)],
      );
    }
  }
}

function compareTranscripts(left: AgentSessionTranscript, right: AgentSessionTranscript): number {
  return left.roundId - right.roundId
    || left.agentId.localeCompare(right.agentId)
    || (left.startedAt ?? left.recordedAt).localeCompare(right.startedAt ?? right.recordedAt)
    || left.turnId.localeCompare(right.turnId);
}
