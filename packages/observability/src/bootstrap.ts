import os from "node:os";

import { metrics } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

import { SanitizingSpanProcessor } from "./sanitizing-span-processor";

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();

if (endpoint && process.env.OTEL_SDK_DISABLED !== "true") {
  const resource = resourceFromAttributes({
    "service.name": process.env.OTEL_SERVICE_NAME?.trim() || "openleek-unknown",
    "service.namespace": "openleek",
    "service.instance.id": process.env.HOSTNAME?.trim() || os.hostname(),
    "deployment.environment.name": process.env.OPENLEEK_DEPLOYMENT_ENVIRONMENT?.trim() || "production",
  });
  const tracerProvider = new NodeTracerProvider({
    resource,
    spanProcessors: [new SanitizingSpanProcessor()],
  });
  tracerProvider.register();

  const meterProvider = new MeterProvider({
    resource,
    readers: [new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(),
      exportIntervalMillis: Number(process.env.OTEL_METRIC_EXPORT_INTERVAL) || 15_000,
    })],
  });
  metrics.setGlobalMeterProvider(meterProvider);

  const loggerProvider = new LoggerProvider({
    resource,
    processors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],
  });
  logs.setGlobalLoggerProvider(loggerProvider);

  registerInstrumentations({
    tracerProvider,
    meterProvider,
    instrumentations: [new HttpInstrumentation()],
  });

  const shutdown = () => {
    void Promise.all([
      tracerProvider.shutdown(),
      meterProvider.shutdown(),
      loggerProvider.shutdown(),
    ]);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
