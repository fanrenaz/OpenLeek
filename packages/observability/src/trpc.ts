import { SpanStatusCode, metrics, trace } from "@opentelemetry/api";

import { emitObservabilityLog, SeverityNumber } from "./events";

type ProcedureResult = {
  ok: boolean;
  error?: {
    code?: string;
  };
};

type ProcedureInput = {
  path: string;
  type: string;
  rawInput: unknown;
};

const meter = metrics.getMeter("openleek.trpc");
const requestCounter = meter.createCounter("openleek.trpc.server.requests", {
  description: "Completed OpenLeek tRPC procedures.",
  unit: "{request}",
});
const requestDuration = meter.createHistogram("openleek.trpc.server.duration", {
  description: "OpenLeek tRPC procedure duration.",
  unit: "ms",
});

export async function observeProcedure<T extends ProcedureResult>(
  input: ProcedureInput,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  const tracer = trace.getTracer("openleek.trpc");
  return tracer.startActiveSpan(`trpc.${input.path}`, {
    attributes: {
      "openleek.procedure": input.path,
      "openleek.operation": input.type,
      ...safeBusinessIdentifiers(input.rawInput),
    },
  }, async (span) => {
    let outcome = "ok";
    try {
      const result = await operation();
      if (!result.ok) {
        outcome = "error";
        const code = safeCode(result.error?.code);
        span.setStatus({ code: SpanStatusCode.ERROR });
        if (code) span.setAttribute("code", code);
        emitObservabilityLog("trpc.request.failed", {
          "openleek.procedure": input.path,
          code,
          outcome,
          ...safeBusinessIdentifiers(input.rawInput),
        }, SeverityNumber.ERROR);
      }
      return result;
    } catch (error) {
      outcome = "error";
      span.setStatus({ code: SpanStatusCode.ERROR });
      emitObservabilityLog("trpc.request.failed", {
        "openleek.procedure": input.path,
        code: safeCode(error instanceof Error ? error.name : "unknown"),
        outcome,
        ...safeBusinessIdentifiers(input.rawInput),
      }, SeverityNumber.ERROR);
      throw error;
    } finally {
      const attributes = {
        procedure: input.path,
        type: input.type,
        outcome,
      };
      requestCounter.add(1, attributes);
      requestDuration.record(Math.max(0, performance.now() - startedAt), attributes);
      span.end();
    }
  });
}

export function safeBusinessIdentifiers(input: unknown): Record<string, string | number> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const candidate = input as Record<string, unknown>;
  const attributes: Record<string, string | number> = {};
  safeIdentifier(candidate.runId, "openleek.run_id", attributes);
  safeIdentifier(candidate.agentId, "openleek.agent_id", attributes);
  if (typeof candidate.roundId === "number" && Number.isSafeInteger(candidate.roundId) && candidate.roundId >= 0) {
    attributes["openleek.round_id"] = candidate.roundId;
  }
  return attributes;
}

function safeIdentifier(value: unknown, key: string, target: Record<string, string | number>): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 240) return;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) return;
  target[key] = value;
}

function safeCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,120}$/u.test(value) ? value : undefined;
}
