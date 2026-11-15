import { Pool, type PoolClient } from "pg";
import type { SocialOutboxRecord } from "../application/revision-model";

export interface SocialStreamPartition {
  runId: string;
  roundId: number;
  streamKey: string;
}

interface PartitionRow { run_id: string; round_id: number; stream_key: string }
interface OutboxRow { outbox: SocialOutboxRecord }

/** Atomic queue metadata operations used by the dedicated Redis worker. */
export class PostgresSocialStreamCoordinator {
  constructor(private readonly pool: Pool) {}

  static fromEnvironment(): PostgresSocialStreamCoordinator {
    const connectionString = process.env.OPENLEEK_SOCIAL_ENVIRONMENT_DATABASE_URL;
    if (!connectionString) throw new Error("OPENLEEK_SOCIAL_ENVIRONMENT_DATABASE_URL is required");
    return new PostgresSocialStreamCoordinator(new Pool({ connectionString, max: 6 }));
  }

  async close(): Promise<void> { await this.pool.end(); }

  async listPartitions(limit = 8): Promise<SocialStreamPartition[]> {
    const result = await this.pool.query<PartitionRow>(`
      WITH active AS (
        SELECT DISTINCT o.run_id, o.round_id, o.outbox->>'streamKey' AS stream_key
        FROM social_round_outbox o
        JOIN social_round_intents i USING (command_id)
        JOIN social_round_workspaces w ON w.run_id = o.run_id AND w.round_id = o.round_id
        JOIN social_runs r ON r.run_id = o.run_id
        WHERE i.status = 'pending' AND COALESCE((w.workspace->>'closed')::boolean, false) = false
          AND r.run_state->'mcp'->>'accessRevokedAt' IS NULL
      ), registered AS (
        INSERT INTO social_stream_partitions (run_id, round_id, stream_key)
        SELECT run_id, round_id, stream_key FROM active WHERE stream_key IS NOT NULL
        ON CONFLICT (run_id, round_id) DO UPDATE SET stream_key = EXCLUDED.stream_key
        RETURNING run_id, round_id, stream_key
      )
      SELECT run_id, round_id, stream_key FROM registered ORDER BY run_id, round_id LIMIT $1`, [limit]);
    return result.rows.map((row) => ({ runId: row.run_id, roundId: row.round_id, streamKey: row.stream_key }));
  }

  async listCleanupPartitions(limit = 32): Promise<SocialStreamPartition[]> {
    const result = await this.pool.query<PartitionRow>(`
      SELECT p.run_id, p.round_id, p.stream_key FROM social_stream_partitions p
      JOIN social_round_workspaces w USING (run_id, round_id)
      JOIN social_runs r USING (run_id)
      WHERE COALESCE((w.workspace->>'closed')::boolean, false) = true
        AND w.workspace->>'candidateRevisionRef' = r.run_state->>'revisionHeadRef'
        AND NOT EXISTS (SELECT 1 FROM social_round_intents i
          WHERE i.run_id = p.run_id AND i.round_id = p.round_id AND i.status = 'pending')
      ORDER BY p.run_id, p.round_id LIMIT $1`, [limit]);
    return result.rows.map((row) => ({ runId: row.run_id, roundId: row.round_id, streamKey: row.stream_key }));
  }

  async forgetPartition(partition: SocialStreamPartition): Promise<void> {
    await this.pool.query("DELETE FROM social_stream_partitions WHERE run_id = $1 AND round_id = $2", [partition.runId, partition.roundId]);
  }

  async acquireLease(partition: SocialStreamPartition, owner: string, leaseMs = 30_000): Promise<boolean> {
    const result = await this.pool.query(`
      UPDATE social_stream_partitions SET lease_owner = $4, lease_expires_at = now() + ($5 * interval '1 millisecond')
      WHERE run_id = $1 AND round_id = $2 AND stream_key = $3
        AND (lease_owner = $4 OR lease_expires_at IS NULL OR lease_expires_at <= now())
      RETURNING 1`, [partition.runId, partition.roundId, partition.streamKey, owner, leaseMs]);
    return result.rowCount === 1;
  }

  async renewLease(partition: SocialStreamPartition, owner: string, leaseMs = 30_000): Promise<boolean> {
    const result = await this.pool.query(`
      UPDATE social_stream_partitions SET lease_expires_at = now() + ($4 * interval '1 millisecond')
      WHERE run_id = $1 AND round_id = $2 AND lease_owner = $3 AND lease_expires_at > now() RETURNING 1`,
    [partition.runId, partition.roundId, owner, leaseMs]);
    return result.rowCount === 1;
  }

  async releaseLease(partition: SocialStreamPartition, owner: string): Promise<void> {
    await this.pool.query(`UPDATE social_stream_partitions SET lease_owner = NULL, lease_expires_at = NULL
      WHERE run_id = $1 AND round_id = $2 AND lease_owner = $3`, [partition.runId, partition.roundId, owner]);
  }

  /** Claims a bounded microbatch. Published rows are replayed after 60s without terminal progress. */
  async claimPublishable(partition: SocialStreamPartition, limit = 256): Promise<SocialOutboxRecord[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<OutboxRow>(`
        SELECT o.outbox FROM social_round_outbox o
        JOIN social_round_intents i USING (command_id)
        WHERE o.run_id = $1 AND o.round_id = $2 AND i.status = 'pending'
          AND o.next_attempt_at <= now()
          AND (o.status = 'pending' OR (o.status = 'published' AND o.published_at < now() - interval '60 seconds'))
        ORDER BY i.accepted_sequence FOR UPDATE OF o SKIP LOCKED LIMIT $3`,
      [partition.runId, partition.roundId, limit]);
      const commandIds = result.rows.map((row) => row.outbox.commandId);
      if (commandIds.length > 0) {
        await client.query(`UPDATE social_round_outbox SET last_publish_attempt_at = now(), retry_count = retry_count + 1,
          next_attempt_at = now() + (LEAST(10000, 100 * power(2, LEAST(retry_count, 7))) * interval '1 millisecond')
          WHERE command_id = ANY($1::text[])`, [commandIds]);
      }
      await client.query("COMMIT");
      return result.rows.map((row) => structuredClone(row.outbox));
    } catch (error) {
      await rollback(client);
      throw error;
    } finally { client.release(); }
  }

  async recordPublished(commandId: string, streamId: string): Promise<void> {
    await this.pool.query(`
      UPDATE social_round_outbox SET
        status = CASE WHEN status = 'applied' THEN status ELSE 'published' END,
        published_stream_id = CASE
          WHEN published_stream_id IS NULL OR NOT openleek_stream_id_gte($2, published_stream_id) THEN $2
          ELSE published_stream_id END,
        published_at = COALESCE(published_at, now()),
        next_attempt_at = now() + interval '60 seconds',
        outbox = jsonb_set(
          jsonb_set(outbox, '{status}', to_jsonb(CASE WHEN status = 'applied' THEN status ELSE 'published' END)),
          '{publishedStreamId}', to_jsonb(CASE
            WHEN published_stream_id IS NULL OR NOT openleek_stream_id_gte($2, published_stream_id) THEN $2
            ELSE published_stream_id END)
        )
      WHERE command_id = $1`, [commandId, streamId]);
    await this.pool.query(`UPDATE social_round_intents SET
      stream_id = CASE WHEN stream_id IS NULL OR NOT openleek_stream_id_gte($2, stream_id) THEN $2 ELSE stream_id END,
      delivered_at = COALESCE(delivered_at, now()),
      intent = jsonb_set(intent, '{streamId}', to_jsonb(CASE
        WHEN stream_id IS NULL OR NOT openleek_stream_id_gte($2, stream_id) THEN $2 ELSE stream_id END))
      WHERE command_id = $1 AND status = 'pending'`, [commandId, streamId]);
  }

  /** Repairs the owner projection when a terminal intent survived an old stale outbox write. */
  async reconcile(partition: SocialStreamPartition): Promise<number> {
    const result = await this.pool.query(`
      UPDATE social_round_outbox o SET status = 'applied',
        outbox = jsonb_set(o.outbox, '{status}', '"applied"'::jsonb)
      FROM social_round_intents i
      WHERE o.command_id = i.command_id AND o.run_id = $1 AND o.round_id = $2
        AND i.status IN ('applied','rejected','discarded') AND o.status <> 'applied'`,
    [partition.runId, partition.roundId]);
    await this.pool.query(`UPDATE social_stream_partitions SET last_reconciled_at = now()
      WHERE run_id = $1 AND round_id = $2`, [partition.runId, partition.roundId]);
    return result.rowCount ?? 0;
  }
}

async function rollback(client: PoolClient): Promise<void> {
  try { await client.query("ROLLBACK"); } catch { /* original failure wins */ }
}
