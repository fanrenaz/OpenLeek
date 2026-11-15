import type { Context } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type Span,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";

const allowedAttributes = new Set([
  "db.operation.name",
  "db.system.name",
  "error.type",
  "http.request.method",
  "http.response.status_code",
  "http.route",
  "network.protocol.name",
  "network.protocol.version",
  "next.page",
  "next.route",
  "next.rsc",
  "next.span_name",
  "next.span_type",
  "openleek.agent_id",
  "openleek.algorithm_kind",
  "openleek.event",
  "openleek.mode",
  "openleek.operation",
  "openleek.procedure",
  "openleek.round_id",
  "openleek.run_id",
  "openleek.worker",
  "rpc.method",
  "rpc.service",
  "rpc.system",
  "server.address",
  "server.port",
  "url.scheme",
]);

/**
 * Automatic instrumentation is useful for timing and parentage, but its raw
 * URL, SQL, exception, request, and response attributes are not exportable.
 */
export class SanitizingSpanProcessor implements SpanProcessor {
  private readonly delegate: SpanProcessor;

  constructor(delegate: SpanProcessor = new BatchSpanProcessor(new OTLPTraceExporter())) {
    this.delegate = delegate;
  }

  onStart(span: Span, parentContext: Context): void {
    sanitizeSpan(span);
    this.delegate.onStart(span, parentContext);
  }

  onEnding(span: Span): void {
    sanitizeSpan(span);
    this.delegate.onEnding?.(span);
  }

  onEnd(span: ReadableSpan): void {
    sanitizeSpan(span);
    this.delegate.onEnd(span);
  }

  forceFlush(): Promise<void> {
    return this.delegate.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }
}

export function sanitizeSpan(span: Pick<ReadableSpan, "attributes" | "events" | "status">): void {
  const mutable = span as unknown as {
    attributes: Record<string, unknown>;
    events: unknown[];
    status: { code: number; message?: string };
  };
  for (const key of Object.keys(mutable.attributes)) {
    if (!allowedAttributes.has(key)) delete mutable.attributes[key];
  }
  mutable.events.length = 0;
  mutable.status = { code: mutable.status.code };
}
