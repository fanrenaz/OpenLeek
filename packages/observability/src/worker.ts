import { SpanStatusCode, metrics, trace } from "@opentelemetry/api";

import { emitObservabilityLog, SeverityNumber } from "./events";
import { safeBusinessIdentifiers } from "./trpc";

type WorkerOperation = {
  worker: string;
  operation: string;
  runId?: string;
  roundId?: number;
  agentId?: string;
};

const meter = metrics.getMeter("openleek.worker");
const operationCounter = meter.createCounter("openleek.worker.operations", {
  description: "Completed OpenLeek worker operations.",
  unit: "{operation}",
});
const operationDuration = meter.createHistogram("openleek.worker.operation.duration", {
  description: "OpenLeek worker operation duration.",
  unit: "ms",
});
const activeOperations = meter.createUpDownCounter("openleek.worker.active", {
  description: "Active OpenLeek worker operations.",
  unit: "{operation}",
});
const streamEntries = meter.createCounter("openleek.context_stream.entries", {
  description: "Published, consumed, reclaimed, and reconciled Context Stream entries.",
  unit: "{entry}",
});
const streamBatchSize = meter.createHistogram("openleek.context_stream.batch.size", {
  description: "Context Stream publisher and consumer microbatch sizes.",
  unit: "{entry}",
});
const streamPending = meter.createHistogram("openleek.context_stream.pending", {
  description: "Observed Redis pending-entry-list depth after a worker batch.",
  unit: "{entry}",
});

export function recordContextStreamBatch(input: {
  worker: string;
  published: number;
  consumed: number;
  reclaimed: number;
  reconciled: number;
  redisPending: number;
}): void {
  const attributes = { worker: input.worker };
  for (const [operation, count] of [
    ["published", input.published], ["consumed", input.consumed],
    ["reclaimed", input.reclaimed], ["reconciled", input.reconciled],
  ] as const) {
    if (count > 0) streamEntries.add(count, { ...attributes, operation });
  }
  streamBatchSize.record(input.consumed, { ...attributes, operation: "consume" });
  streamPending.record(input.redisPending, attributes);
}

export async function observeWorkerOperation<T>(
  input: WorkerOperation,
  operation: () => Promise<T>,
): Promise<T> {
  const identifiers = safeBusinessIdentifiers(input);
  const attributes = {
    worker: input.worker,
    operation: input.operation,
  };
  const startedAt = performance.now();
  activeOperations.add(1, attributes);
  return trace.getTracer("openleek.worker").startActiveSpan(`worker.${input.worker}.${input.operation}`, {
    attributes: {
      "openleek.worker": input.worker,
      "openleek.operation": input.operation,
      ...identifiers,
    },
  }, async (span) => {
    let outcome = "ok";
    try {
      return await operation();
    } catch (error) {
      outcome = "error";
      span.setStatus({ code: SpanStatusCode.ERROR });
      emitObservabilityLog("worker.operation.failed", {
        "openleek.worker": input.worker,
        "openleek.operation": input.operation,
        code: safeErrorCode(error),
        outcome,
        ...identifiers,
      }, SeverityNumber.ERROR);
      throw error;
    } finally {
      const metricAttributes = { ...attributes, outcome };
      activeOperations.add(-1, attributes);
      operationCounter.add(1, metricAttributes);
      operationDuration.record(Math.max(0, performance.now() - startedAt), metricAttributes);
      span.end();
    }
  });
}

function safeErrorCode(error: unknown): string {
  const name = error instanceof Error ? error.name : "unknown";
  return /^[A-Za-z0-9_.:-]{1,120}$/u.test(name) ? name : "unknown";
}
