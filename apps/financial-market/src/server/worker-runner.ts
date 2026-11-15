import { createRedisStreamsClient, RedisServerError, type RedisStreamEntry, type RedisStreamsClient } from "@openleek/redis-streams";
import { emitObservabilityLog, observeWorkerOperation, recordContextStreamBatch, SeverityNumber } from "@openleek/observability";
import { FinancialMarketWorktreeWorker } from "../application/revision-worker";
import { PostgresFinancialStreamCoordinator, type FinancialStreamPartition } from "../infrastructure/postgres-stream-coordinator";
import { financialMarketRevisionService } from "./runtime";

declare global { var __openleekFinancialMarketWorker: WorkerLifecycle | undefined }
interface WorkerLifecycle { ready: Promise<void>; failure?: Error }
const GROUP = "financial-market-workers";
const LEASE_MS = 30_000;

export async function runFinancialMarketWorker(
  clientOrClients: RedisStreamsClient | readonly RedisStreamsClient[],
  coordinator: PostgresFinancialStreamCoordinator,
  options: { consumer: string; signal: AbortSignal },
): Promise<void> {
  const clients = Array.isArray(clientOrClients) ? clientOrClients : [clientOrClients];
  const revisions = await financialMarketRevisionService();
  const worker = new FinancialMarketWorktreeWorker(revisions);
  const lastReconcile = new Map<string, number>();
  while (!options.signal.aborted) {
    await cleanupCommittedPartitions(clients[0]!, coordinator);
    const partitions = await coordinator.listPartitions(8);
    if (partitions.length === 0) { await wait(100); continue; }
    await Promise.all(partitions.map(async (partition, index) => {
      const client = clients[index % clients.length]!;
      if (!await coordinator.acquireLease(partition, options.consumer, LEASE_MS)) return;
      const renewal = setInterval(() => { void coordinator.renewLease(partition, options.consumer, LEASE_MS); }, 10_000);
      try {
        await processPartition(client, coordinator, revisions, worker, partition, options.consumer);
        const now = Date.now();
        if (now - (lastReconcile.get(partition.streamKey) ?? 0) >= 10_000) {
          await coordinator.reconcile(partition); lastReconcile.set(partition.streamKey, now);
        }
      } finally { clearInterval(renewal); await coordinator.releaseLease(partition, options.consumer); }
    }));
  }
}

async function cleanupCommittedPartitions(client: RedisStreamsClient, coordinator: PostgresFinancialStreamCoordinator): Promise<void> {
  for (const partition of await coordinator.listCleanupPartitions()) {
    try {
      const pending = await client.xpending(partition.streamKey, GROUP);
      if (pending.count !== 0) continue;
      await client.destroyConsumerGroup(partition.streamKey, GROUP);
    } catch (error) {
      if (!(error instanceof RedisServerError) || error.code !== "NOGROUP") throw error;
    }
    await client.del(partition.streamKey);
    await coordinator.forgetPartition(partition);
  }
}

async function processPartition(
  client: RedisStreamsClient,
  coordinator: PostgresFinancialStreamCoordinator,
  revisions: Awaited<ReturnType<typeof financialMarketRevisionService>>,
  worker: FinancialMarketWorktreeWorker,
  partition: FinancialStreamPartition,
  consumer: string,
): Promise<void> {
  await client.ensureConsumerGroup(partition.streamKey, GROUP, "0");
  let published = 0;
  for (const outbox of await coordinator.claimPublishable(partition, 256)) {
    const streamId = await client.xadd(partition.streamKey, {
      runId: partition.runId, roundId: String(partition.roundId), commandId: outbox.commandId,
    });
    await coordinator.recordPublished(outbox.commandId, streamId);
    published += 1;
  }
  const reclaimed = await client.xautoclaim({
    streamKey: partition.streamKey, group: GROUP, consumer, minIdleMs: 30_000, count: 100,
  });
  let entries = reclaimed.entries;
  if (entries.length === 0) entries = await client.xreadgroup({
    streamKey: partition.streamKey, group: GROUP, consumer, id: ">", count: 100, blockMs: 100,
  });
  entries = await accumulateMicrobatch(client, partition.streamKey, consumer, entries);
  entries.sort((left, right) => compareStreamIds(left.streamId, right.streamId));
  for (const entry of entries) {
    validateEntry(partition, entry);
    await coordinator.recordPublished(entry.fields.commandId!, entry.streamId);
  }

  // Stream IDs were checkpointed into owner intents by the publisher. Financial
  // applies the whole microbatch sequentially to preserve price-time priority.
  await revisions.refreshFromStore();
  await observeWorkerOperation({
    worker: "financial-market", operation: "consume", runId: partition.runId, roundId: partition.roundId,
  }, async () => {
    while (await worker.runOnce({ runId: partition.runId, roundId: partition.roundId })) { /* drain ordered microbatch */ }
  });
  await revisions.refreshFromStore();
  const worktree = revisions.getWorktree(partition.runId, partition.roundId);
  const acknowledged = entries.filter((entry) => {
    const commandId = entry.fields.commandId!;
    const status = worktree.intents[commandId]?.status;
    return status === "applied" || status === "rejected" || status === "discarded";
  }).map((entry) => entry.streamId);
  if (acknowledged.length > 0) await client.xack(partition.streamKey, GROUP, acknowledged);
  const pending = await client.xpending(partition.streamKey, GROUP);
  recordContextStreamBatch({ worker: "financial-market", published, consumed: acknowledged.length,
    reclaimed: reclaimed.entries.length, reconciled: 0, redisPending: pending.count });
}

async function accumulateMicrobatch(client: RedisStreamsClient, streamKey: string, consumer: string, initial: RedisStreamEntry[]) {
  const result = [...initial]; const deadline = Date.now() + 25;
  while (result.length < 100 && Date.now() < deadline) {
    const more = await client.xreadgroup({ streamKey, group: GROUP, consumer, id: ">", count: 100 - result.length });
    if (more.length === 0) break; result.push(...more);
  }
  return result;
}

export function startFinancialMarketWorker(): Promise<void> {
  if (globalThis.__openleekFinancialMarketWorker) return globalThis.__openleekFinancialMarketWorker.ready;
  let resolveReady!: () => void; let rejectReady!: (error: Error) => void;
  const lifecycle: WorkerLifecycle = { ready: new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; }) };
  globalThis.__openleekFinancialMarketWorker = lifecycle;
  void (async () => {
    const redisUrl = process.env.OPENLEEK_REDIS_URL;
    if (!redisUrl) throw new Error("OPENLEEK_REDIS_URL is required for the Financial Market worker");
    const clients = Array.from({ length: 8 }, () => createRedisStreamsClient({ url: redisUrl }));
    const coordinator = PostgresFinancialStreamCoordinator.fromEnvironment();
    const controller = new AbortController(); const stop = () => controller.abort();
    process.once("SIGTERM", stop); process.once("SIGINT", stop);
    try {
      await Promise.all(clients.map((client) => client.connect())); await financialMarketRevisionService(); resolveReady();
      await runFinancialMarketWorker(clients, coordinator, {
        consumer: process.env.OPENLEEK_WORKER_ID ?? `financial-market-worker:${process.pid}`, signal: controller.signal,
      });
    } finally { await Promise.all([...clients.map((client) => client.close()), coordinator.close()]); }
  })().catch((unknownError: unknown) => {
    const error = unknownError instanceof Error ? unknownError : new Error(String(unknownError));
    lifecycle.failure = error; rejectReady(error);
    emitObservabilityLog("worker.terminated", { "openleek.worker": "financial-market", code: error.name, outcome: "error" }, SeverityNumber.FATAL);
    console.error("financial market worker terminated"); process.exitCode = 1; setImmediate(() => process.exit(1));
  });
  return lifecycle.ready;
}

export async function requireFinancialMarketWorkerReady(): Promise<void> {
  if (process.env.OPENLEEK_FINANCIAL_MARKET_WORKER !== "true") return;
  const lifecycle = globalThis.__openleekFinancialMarketWorker;
  if (!lifecycle) throw new Error("Financial Market worker has not started");
  await lifecycle.ready; if (lifecycle.failure) throw lifecycle.failure;
}

function validateEntry(partition: FinancialStreamPartition, entry: RedisStreamEntry): void {
  if (entry.streamKey !== partition.streamKey || entry.fields.runId !== partition.runId
    || Number(entry.fields.roundId) !== partition.roundId || !entry.fields.commandId) {
    throw new Error(`invalid Financial stream message ${entry.streamId}`);
  }
}
function compareStreamIds(left: string, right: string): number {
  const [leftMs, leftSequence] = left.split("-").map((value) => BigInt(value));
  const [rightMs, rightSequence] = right.split("-").map((value) => BigInt(value));
  return leftMs === rightMs ? Number(leftSequence! - rightSequence!) : leftMs! < rightMs! ? -1 : 1;
}
function wait(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
