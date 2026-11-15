import { SpanStatusCode, trace } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";

type SafeValue = string | number | boolean | null | undefined;

const allowedAttributes = new Set([
  "code",
  "event",
  "http.response.status_code",
  "openleek.agent_id",
  "openleek.algorithm_kind",
  "openleek.mode",
  "openleek.operation",
  "openleek.procedure",
  "openleek.round_id",
  "openleek.run_id",
  "openleek.tool",
  "openleek.target_type",
  "openleek.target_id",
  "openleek.idempotency_key",
  "openleek.duration_ms",
  "openleek.error_category",
  "openleek.worker",
  "outcome",
  "retryable",
  "rpc.method",
]);

export function emitObservabilityLog(
  event: string,
  attributes: Record<string, SafeValue> = {},
  severity: SeverityNumber = SeverityNumber.INFO,
): void {
  const safe: Record<string, string | number | boolean> = { event };
  for (const [key, value] of Object.entries(attributes)) {
    if (allowedAttributes.has(key) && value !== null && value !== undefined) safe[key] = value;
  }
  logs.getLogger("openleek").emit({
    eventName: event,
    severityNumber: severity,
    body: event,
    attributes: safe,
  });
}

export function recordActiveSpanError(code: string): void {
  const span = trace.getActiveSpan();
  span?.setAttribute("code", code);
  span?.setStatus({ code: SpanStatusCode.ERROR });
}

export function recordRpcMethod(method: string): void {
  if (!/^[A-Za-z0-9_./:-]{1,160}$/u.test(method)) return;
  trace.getActiveSpan()?.setAttribute("rpc.method", method);
}

export { SeverityNumber };
