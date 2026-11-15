import { createRedisStreamsClient, RedisServerError, type RedisStreamEntry, type RedisStreamsClient } from "@openleek/redis-streams";
import { emitObservabilityLog, observeWorkerOperation, recordContextStreamBatch, SeverityNumber } from "@openleek/observability";
import { PostgresSocialStreamCoordinator, type SocialStreamPartition } from "../infrastructure/postgres-stream-coordinator";
import { socialEnvironmentService } from "./runtime";

declare global { var __openleekSocialEnvironmentWorker: WorkerLifecycle | undefined }
interface WorkerLifecycle { ready: Promise<void>; failure?: Error }

const GROUP = "social-environment-workers";
const RECLAIM_IDLE_MS = 30_000;
const LEASE_MS = 30_000;

export async function runSocialEnvironmentWorker(
  clientOrClients: RedisStreamsClient | readonly RedisStreamsClient[],
  coordinator: PostgresSocialStreamCoordinator,
  options: { consumer: string; signal: AbortSignal },
): Promise<void> {
  const clients = Array.isArray(clientOrClients) ? clientOrClients : [clientOrClients];
  const social = await socialEnvironmentService();
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
        await processPartition(client, coordinator, social, partition, options.consumer);
        const now = Date.now();
        if (now - (lastReconcile.get(partition.streamKey) ?? 0) >= 10_000) {
          await coordinator.reconcile(partition);
          lastReconcile.set(partition.streamKey, now);
        }
      } finally {
        clearInterval(renewal);
        await coordinator.releaseLease(partition, options.consumer);
      }
    }));
  }
}

async function cleanupCommittedPartitions(client: RedisStreamsClient, coordinator: PostgresSocialStreamCoordinator): Promise<void> {
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
  coordinator: PostgresSocialStreamCoordinator,
  social: Awaited<ReturnType<typeof socialEnvironmentService>>,
  partition: SocialStreamPartition,
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
    streamKey: partition.streamKey, group: GROUP, consumer, minIdleMs: RECLAIM_IDLE_MS, count: 100,
  });
  let entries = reclaimed.entries;
  if (entries.length === 0) entries = await client.xreadgroup({
    streamKey: partition.streamKey, group: GROUP, consumer, id: ">", count: 100, blockMs: 100,
  });
  entries = await accumulateMicrobatch(client, partition.streamKey, consumer, entries);
  entries.sort((left, right) => compareStreamIds(left.streamId, right.streamId));
  const acknowledged: string[] = [];
  for (const entry of entries) {
    const message = parseEntry(partition, entry);
    await observeWorkerOperation({
      worker: "social-environment", operation: "consume", runId: message.runId, roundId: message.roundId,
    }, async () => {
      // The delivered ID repairs the XADD-before-checkpoint crash window and
      // always wins over a later reconciliation duplicate.
      await coordinator.recordPublished(message.commandId, message.streamId);
      await social.applyQueuedIntent(message);
      acknowledged.push(entry.streamId);
    });
  }
  // Owner facts and cursor are committed before this batch leaves the PEL.
  if (acknowledged.length > 0) await client.xack(partition.streamKey, GROUP, acknowledged);
  const pending = await client.xpending(partition.streamKey, GROUP);
  recordContextStreamBatch({ worker: "social-environment", published, consumed: acknowledged.length,
    reclaimed: reclaimed.entries.length, reconciled: 0, redisPending: pending.count });
}

async function accumulateMicrobatch(
  client: RedisStreamsClient,
  streamKey: string,
  consumer: string,
  initial: RedisStreamEntry[],
): Promise<RedisStreamEntry[]> {
  const result = [...initial];
  const deadline = Date.now() + 25;
  while (result.length < 100 && Date.now() < deadline) {
    const more = await client.xreadgroup({ streamKey, group: GROUP, consumer, id: ">", count: 100 - result.length });
    if (more.length === 0) break;
    result.push(...more);
  }
  return result;
}

export function startSocialEnvironmentWorker(): Promise<void> {
  if (globalThis.__openleekSocialEnvironmentWorker) return globalThis.__openleekSocialEnvironmentWorker.ready;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const lifecycle: WorkerLifecycle = { ready: new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; }) };
  globalThis.__openleekSocialEnvironmentWorker = lifecycle;
  void (async () => {
    const redisUrl = process.env.OPENLEEK_REDIS_URL;
    if (!redisUrl) throw new Error("OPENLEEK_REDIS_URL is required for the Social Environment worker");
    const clients = Array.from({ length: 8 }, () => createRedisStreamsClient({ url: redisUrl }));
    const coordinator = PostgresSocialStreamCoordinator.fromEnvironment();
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGTERM", stop); process.once("SIGINT", stop);
    try {
      await Promise.all(clients.map((client) => client.connect())); await socialEnvironmentService(); resolveReady();
      await runSocialEnvironmentWorker(clients, coordinator, {
        consumer: process.env.OPENLEEK_WORKER_ID ?? `social-environment-worker:${process.pid}`, signal: controller.signal,
      });
    } finally { await Promise.all([...clients.map((client) => client.close()), coordinator.close()]); }
  })().catch((unknownError: unknown) => {
    const error = unknownError instanceof Error ? unknownError : new Error(String(unknownError));
    lifecycle.failure = error; rejectReady(error);
    emitObservabilityLog("worker.terminated", { "openleek.worker": "social-environment", code: error.name, outcome: "error" }, SeverityNumber.FATAL);
    console.error("social environment worker terminated"); process.exitCode = 1; setImmediate(() => process.exit(1));
  });
  return lifecycle.ready;
}

export async function requireSocialEnvironmentWorkerReady(): Promise<void> {
  if (process.env.OPENLEEK_SOCIAL_ENVIRONMENT_WORKER !== "true") return;
  const lifecycle = globalThis.__openleekSocialEnvironmentWorker;
  if (!lifecycle) throw new Error("Social Environment worker has not started");
  await lifecycle.ready; if (lifecycle.failure) throw lifecycle.failure;
}

function parseEntry(partition: SocialStreamPartition, entry: RedisStreamEntry) {
  const runId = entry.fields.runId; const commandId = entry.fields.commandId; const roundId = Number(entry.fields.roundId);
  if (entry.streamKey !== partition.streamKey || runId !== partition.runId || roundId !== partition.roundId || !commandId) {
    throw new Error(`invalid Social stream message ${entry.streamId}`);
  }
  return { streamId: entry.streamId, runId, roundId, commandId };
}
function compareStreamIds(left: string, right: string): number {
  const [leftMs, leftSequence] = left.split("-").map(BigInt); const [rightMs, rightSequence] = right.split("-").map(BigInt);
  return leftMs === rightMs ? Number(leftSequence! - rightSequence!) : leftMs! < rightMs! ? -1 : 1;
}
function wait(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
