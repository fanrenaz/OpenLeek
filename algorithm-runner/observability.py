"""Small, payload-free OpenTelemetry boundary for the Algorithm Runner."""

from __future__ import annotations

import atexit
import os
import time
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Iterator, Mapping

from opentelemetry import metrics, trace
from opentelemetry.context import Context
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.metrics import Counter, Histogram
from opentelemetry.propagate import extract
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.trace import SpanKind, Status, StatusCode

_request_counter: Counter | None = None
_request_duration: Histogram | None = None


def setup_observability() -> None:
    global _request_counter, _request_duration
    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "").strip()
    if not endpoint or os.environ.get("OTEL_SDK_DISABLED") == "true":
        return

    resource = Resource.create(
        {
            "service.name": os.environ.get("OTEL_SERVICE_NAME", "openleek-algorithm-runner"),
            "service.namespace": "openleek",
            "service.instance.id": os.environ.get("HOSTNAME", "algorithm-runner"),
            "deployment.environment.name": os.environ.get("OPENLEEK_DEPLOYMENT_ENVIRONMENT", "production"),
        }
    )
    tracer_provider = TracerProvider(resource=resource)
    tracer_provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    trace.set_tracer_provider(tracer_provider)

    interval = int(os.environ.get("OTEL_METRIC_EXPORT_INTERVAL", "15000"))
    metric_reader = PeriodicExportingMetricReader(OTLPMetricExporter(), export_interval_millis=interval)
    meter_provider = MeterProvider(resource=resource, metric_readers=[metric_reader])
    metrics.set_meter_provider(meter_provider)
    meter = metrics.get_meter("openleek.algorithm-runner")
    _request_counter = meter.create_counter(
        "openleek.algorithm_runner.requests",
        unit="{request}",
        description="Completed Algorithm Runner requests.",
    )
    _request_duration = meter.create_histogram(
        "openleek.algorithm_runner.duration",
        unit="ms",
        description="Algorithm Runner request duration.",
    )

    atexit.register(meter_provider.shutdown)
    atexit.register(tracer_provider.shutdown)


@dataclass
class RequestObservation:
    route: str
    method: str
    started_at: float
    span: trace.Span
    status_code: int = 500
    algorithm_kind: str = "none"
    mode: str = "none"

    def finish(self, status_code: int, *, algorithm_kind: str = "none", mode: str = "none") -> None:
        self.status_code = status_code
        self.algorithm_kind = _safe_label(algorithm_kind)
        self.mode = _safe_label(mode)


@contextmanager
def observe_request(method: str, route: str, headers: Mapping[str, str]) -> Iterator[RequestObservation]:
    safe_route = route if route in {
        "/health",
        "/validate",
        "/execute",
        "/market-maker/validate",
        "/market-maker/execute",
        "/world-generator/population/validate",
        "/world-generator/population/execute",
        "/world-generator/network/validate",
        "/world-generator/network/execute",
    } else "/unmatched"
    parent: Context = extract(dict(headers))
    tracer = trace.get_tracer("openleek.algorithm-runner")
    with tracer.start_as_current_span(
        f"{method} {safe_route}",
        context=parent,
        kind=SpanKind.SERVER,
        attributes={"http.request.method": method, "http.route": safe_route},
    ) as span:
        observation = RequestObservation(safe_route, method, time.perf_counter(), span)
        try:
            yield observation
        except Exception:
            span.set_status(Status(StatusCode.ERROR))
            raise
        finally:
            span.set_attribute("http.response.status_code", observation.status_code)
            span.set_attribute("openleek.algorithm_kind", observation.algorithm_kind)
            span.set_attribute("openleek.mode", observation.mode)
            if observation.status_code >= 500:
                span.set_status(Status(StatusCode.ERROR))
            attributes = {
                "route": safe_route,
                "method": method,
                "status_code": observation.status_code,
                "algorithm_kind": observation.algorithm_kind,
                "mode": observation.mode,
                "outcome": "error" if observation.status_code >= 400 else "ok",
            }
            duration_ms = max(0.0, (time.perf_counter() - observation.started_at) * 1000)
            if safe_route != "/health" and _request_counter is not None:
                _request_counter.add(1, attributes)
            if safe_route != "/health" and _request_duration is not None:
                _request_duration.record(duration_ms, attributes)


def _safe_label(value: str) -> str:
    return value if value in {"none", "feed", "market_maker", "population", "network", "validate", "execute"} else "unknown"
