import { Pool, type PoolClient } from "pg";
import type { FinancialOutboxRecord } from "../application/revision-model";

export interface FinancialStreamPartition { runId: string; roundId: number; streamKey: string }
interface PartitionRow { run_id: string; round_id: number; stream_key: string }
interface OutboxRow { outbox: FinancialOutboxRecord }

/** PostgreSQL checkpoint/lease side of the Financial Redis Stream worker. */
export class PostgresFinancialStreamCoordinator {
  constructor(private readonly pool: Pool) {}
  static fromEnvironment(): PostgresFinancialStreamCoordinator {
    const connectionString = process.env.OPENLEEK_FINANCIAL_MARKET_DATABASE_URL;
    if (!connectionString) throw new Error("OPENLEEK_FINANCIAL_MARKET_DATABASE_URL is required");
    return new PostgresFinancialStreamCoordinator(new Pool({ connectionString, max: 6 }));
  }
  async close(): Promise<void> { await this.pool.end(); }

  async listPartitions(limit = 8): Promise<FinancialStreamPartition[]> {
    const result = await this.pool.query<PartitionRow>(`
      WITH active AS (
        SELECT DISTINCT o.run_id, o.round_id, o.outbox->>'streamKey' AS stream_key
        FROM financial_round_outbox o JOIN financial_round_intents i USING (command_id)
        JOIN financial_round_workspaces w ON w.run_id = o.run_id AND w.round_id = o.round_id
        JOIN financial_revision_runs r ON r.run_id = o.run_id
        WHERE i.status = 'pending' AND COALESCE((w.workspace->>'closed')::boolean, false) = false
          AND r.mcp->>'accessRevokedAt' IS NULL
      ), registered AS (
        INSERT INTO financial_stream_partitions (run_id, round_id, stream_key)
        SELECT run_id, round_id, stream_key FROM active WHERE stream_key IS NOT NULL
        ON CONFLICT (run_id, round_id) DO UPDATE SET stream_key = EXCLUDED.stream_key
        RETURNING run_id, round_id, stream_key
      ) SELECT run_id, round_id, stream_key FROM registered ORDER BY run_id, round_id LIMIT $1`, [limit]);
    return result.rows.map((row) => ({ runId: row.run_id, roundId: row.round_id, streamKey: row.stream_key }));
  }

  async listCleanupPartitions(limit = 32): Promise<FinancialStreamPartition[]> {
    const result = await this.pool.query<PartitionRow>(`
      SELECT p.run_id, p.round_id, p.stream_key FROM financial_stream_partitions p
      JOIN financial_round_workspaces w USING (run_id, round_id)
      JOIN financial_revision_runs r USING (run_id)
      WHERE COALESCE((w.workspace->>'closed')::boolean, false) = true
        AND w.workspace->>'candidateRevisionRef' = r.revision_head_ref
        AND NOT EXISTS (SELECT 1 FROM financial_round_intents i
          WHERE i.run_id = p.run_id AND i.round_id = p.round_id AND i.status = 'pending')
      ORDER BY p.run_id, p.round_id LIMIT $1`, [limit]);
    return result.rows.map((row) => ({ runId: row.run_id, roundId: row.round_id, streamKey: row.stream_key }));
  }

  async forgetPartition(partition: FinancialStreamPartition): Promise<void> {
    await this.pool.query("DELETE FROM financial_stream_partitions WHERE run_id = $1 AND round_id = $2", [partition.runId, partition.roundId]);
  }

  async acquireLease(partition: FinancialStreamPartition, owner: string, leaseMs = 30_000): Promise<boolean> {
    const result = await this.pool.query(`UPDATE financial_stream_partitions
      SET lease_owner = $4, lease_expires_at = now() + ($5 * interval '1 millisecond')
      WHERE run_id = $1 AND round_id = $2 AND stream_key = $3
        AND (lease_owner = $4 OR lease_expires_at IS NULL OR lease_expires_at <= now()) RETURNING 1`,
    [partition.runId, partition.roundId, partition.streamKey, owner, leaseMs]);
    return result.rowCount === 1;
  }
  async renewLease(partition: FinancialStreamPartition, owner: string, leaseMs = 30_000): Promise<boolean> {
    const result = await this.pool.query(`UPDATE financial_stream_partitions
      SET lease_expires_at = now() + ($4 * interval '1 millisecond')
      WHERE run_id = $1 AND round_id = $2 AND lease_owner = $3 AND lease_expires_at > now() RETURNING 1`,
    [partition.runId, partition.roundId, owner, leaseMs]);
    return result.rowCount === 1;
  }
  async releaseLease(partition: FinancialStreamPartition, owner: string): Promise<void> {
    await this.pool.query(`UPDATE financial_stream_partitions SET lease_owner = NULL, lease_expires_at = NULL
      WHERE run_id = $1 AND round_id = $2 AND lease_owner = $3`, [partition.runId, partition.roundId, owner]);
  }

  async claimPublishable(partition: FinancialStreamPartition, limit = 256): Promise<FinancialOutboxRecord[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<OutboxRow>(`
        SELECT o.outbox FROM financial_round_outbox o JOIN financial_round_intents i USING (command_id)
        WHERE o.run_id = $1 AND o.round_id = $2 AND i.status = 'pending' AND o.next_attempt_at <= now()
          AND (o.status = 'pending' OR (o.status = 'published' AND o.published_at < now() - interval '60 seconds'))
        ORDER BY i.accepted_sequence FOR UPDATE OF o SKIP LOCKED LIMIT $3`,
      [partition.runId, partition.roundId, limit]);
      const commandIds = result.rows.map((row) => row.outbox.commandId);
      if (commandIds.length > 0) await client.query(`UPDATE financial_round_outbox
        SET last_publish_attempt_at = now(), retry_count = retry_count + 1,
            next_attempt_at = now() + (LEAST(10000, 100 * power(2, LEAST(retry_count, 7))) * interval '1 millisecond')
        WHERE command_id = ANY($1::text[])`, [commandIds]);
      await client.query("COMMIT");
      return result.rows.map((row) => structuredClone(row.outbox));
    } catch (error) {
      await rollback(client);
      throw error;
    } finally { client.release(); }
  }

  async recordPublished(commandId: string, streamId: string): Promise<void> {
    await this.pool.query(`UPDATE financial_round_outbox SET
      status = CASE WHEN status = 'applied' THEN status ELSE 'published' END,
      published_stream_id = CASE
        WHEN published_stream_id IS NULL OR NOT openleek_stream_id_gte($2, published_stream_id) THEN $2
        ELSE published_stream_id END,
      published_at = COALESCE(published_at, now()), next_attempt_at = now() + interval '60 seconds',
      outbox = jsonb_set(
        jsonb_set(outbox, '{status}', to_jsonb(CASE WHEN status = 'applied' THEN status ELSE 'published' END)),
        '{publishedStreamId}', to_jsonb(CASE
          WHEN published_stream_id IS NULL OR NOT openleek_stream_id_gte($2, published_stream_id) THEN $2
          ELSE published_stream_id END))
      WHERE command_id = $1`, [commandId, streamId]);
    await this.pool.query(`UPDATE financial_round_intents SET
      stream_id = CASE WHEN stream_id IS NULL OR NOT openleek_stream_id_gte($2, stream_id) THEN $2 ELSE stream_id END,
      delivered_at = COALESCE(delivered_at, now()),
      intent = jsonb_set(intent, '{streamId}', to_jsonb(CASE
        WHEN stream_id IS NULL OR NOT openleek_stream_id_gte($2, stream_id) THEN $2 ELSE stream_id END))
      WHERE command_id = $1 AND status = 'pending'`, [commandId, streamId]);
  }

  async reconcile(partition: FinancialStreamPartition): Promise<number> {
    const result = await this.pool.query(`UPDATE financial_round_outbox o SET status = 'applied',
      outbox = jsonb_set(o.outbox, '{status}', '"applied"'::jsonb)
      FROM financial_round_intents i WHERE o.command_id = i.command_id AND o.run_id = $1 AND o.round_id = $2
        AND i.status IN ('applied','rejected','discarded') AND o.status <> 'applied'`,
    [partition.runId, partition.roundId]);
    await this.pool.query(`UPDATE financial_stream_partitions SET last_reconciled_at = now()
      WHERE run_id = $1 AND round_id = $2`, [partition.runId, partition.roundId]);
    return result.rowCount ?? 0;
  }
}

async function rollback(client: PoolClient): Promise<void> {
  try { await client.query("ROLLBACK"); } catch { /* preserve original */ }
}
