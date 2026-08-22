import { ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  LoggerProvider,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

const DEFAULT_ENDPOINT = 'http://localhost:4318';

function parseHeaders(value = '') {
  return Object.fromEntries(value.split(',').filter(Boolean).map((entry) => {
    const separator = entry.indexOf('=');
    if (separator < 1) throw new Error('OTEL_EXPORTER_OTLP_HEADERS must contain key=value pairs');
    return [decodeURIComponent(entry.slice(0, separator).trim()), decodeURIComponent(entry.slice(separator + 1).trim())];
  }));
}

function signalUrl(base, signal) {
  const normalized = base.replace(/\/$/, '');
  return normalized.endsWith(`/v1/${signal}`) ? normalized : `${normalized}/v1/${signal}`;
}

export function createTelemetry(options = {}) {
  const endpoint = options.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? DEFAULT_ENDPOINT;
  const headers = options.headers ?? parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS);
  const serviceName = options.serviceName ?? process.env.OTEL_SERVICE_NAME ?? 'mend';
  const resource = resourceFromAttributes({
    'service.name': serviceName,
    'service.version': '0.1.0',
    'deployment.environment.name': process.env.OTEL_ENVIRONMENT ?? 'local',
  });

  const spanExporter = options.spanExporter ?? new OTLPTraceExporter({ url: signalUrl(endpoint, 'traces'), headers });
  const logExporter = options.logExporter ?? new OTLPLogExporter({ url: signalUrl(endpoint, 'logs'), headers });
  const metricExporter = options.metricExporter ?? new OTLPMetricExporter({ url: signalUrl(endpoint, 'metrics'), headers });

  const tracerProvider = new BasicTracerProvider({
    resource,
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  });
  const loggerProvider = new LoggerProvider({
    resource,
    processors: [new SimpleLogRecordProcessor({ exporter: logExporter })],
  });
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: options.metricExportIntervalMillis ?? 1_000,
  });
  const meterProvider = new MeterProvider({ resource, readers: [metricReader] });
  const tracer = tracerProvider.getTracer('zero-downtime');
  const logger = loggerProvider.getLogger('zero-downtime');
  const meter = meterProvider.getMeter('zero-downtime');

  const metrics = {
    runs: meter.createCounter('zero_downtime_runs_total', { description: 'Completed workflow fixture runs' }),
    duration: meter.createHistogram('zero_downtime_run_duration_ms', { unit: 'ms', description: 'End-to-end workflow duration' }),
    stages: meter.createCounter('zero_downtime_stage_executions_total', { description: 'Pipeline stage executions' }),
    failures: meter.createCounter('zero_downtime_stage_failures_total', { description: 'Controlled and real pipeline failures' }),
    factoryRuns: meter.createCounter('mend_factory_runs_total', { description: 'Completed Mend X/Y/Z factory runs' }),
    factoryDuration: meter.createHistogram('mend_factory_run_duration_ms', { unit: 'ms', description: 'Mend X/Y/Z runtime duration' }),
    axisRecords: {
      X: meter.createHistogram('mend_x_records', { description: 'X pipeline records produced per run' }),
      Y: meter.createHistogram('mend_y_records', { description: 'Y structure records produced per run' }),
      Z: meter.createHistogram('mend_z_records', { description: 'Z IP activity records produced per run' }),
    },
    validationFailures: meter.createCounter('mend_validation_failures_total', { description: 'Mend validation failures by axis' }),
    repairAttempts: meter.createCounter('mend_repair_attempts_total', { description: 'Mend X integration repair attempts' }),
    repairSuccess: meter.createCounter('mend_repair_success_total', { description: 'Successful Mend X integration repairs' }),

    // The metric names mend/contracts/telemetry.md freezes. Dotted, because the SigNoz
    // dashboard and the three alert rules key off these exact strings — renaming one is
    // a breaking change to the dashboard, the alerts and the agent's prompt at once.
    //
    // Every one of them is a gauge except run duration, and field_null_rate is a metric
    // rather than a span attribute on purpose: it is per-field, and putting twenty
    // fields on every scrape span would explode the attribute set for no gain.
    meridian: {
      rows: meter.createGauge('mend.rows_returned', { description: 'Row elements matched, before validation' }),
      conformance: meter.createGauge('mend.schema_conformance', { description: 'Records passing the record schema, 0-1' }),
      fieldNullRate: meter.createGauge('mend.field_null_rate', { description: 'Null rate for one mapped field, 0-1' }),
      unmappedFields: meter.createGauge('mend.unmapped_fields', { description: 'Observed attribute keys not declared in the schema' }),
      runDuration: meter.createHistogram('mend.run_duration_ms', { unit: 'ms', description: 'Scrape-to-signals duration' }),
      mttr: meter.createGauge('mend.mttr_seconds', { unit: 's', description: 'Detection to verified repair' }),
    },
  };

  function contextFor(span) {
    return span ? trace.setSpan(ROOT_CONTEXT, span) : ROOT_CONTEXT;
  }

  function startSpan(name, attributes = {}, parentSpan) {
    return tracer.startSpan(name, { attributes }, contextFor(parentSpan));
  }

  function log(severityText, body, attributes = {}, span) {
    const severityNumber = SeverityNumber[severityText] ?? SeverityNumber.INFO;
    const record = { severityText, severityNumber, body, attributes, context: contextFor(span) };
    logger.emit(record);
    if (options.console !== false) {
      const spanContext = span?.spanContext();
      console.log(JSON.stringify({
        timestamp: new Date().toISOString(), severity: severityText, message: body,
        trace_id: spanContext?.traceId, span_id: spanContext?.spanId, ...attributes,
      }));
    }
  }

  function failSpan(span, error) {
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  }

  async function flush() {
    // Telemetry must never turn a repair result into a failed repair. In the
    // credential-free demo there may be no local collector; live SigNoz still
    // receives the same exports when the endpoint is configured.
    await Promise.allSettled([
      tracerProvider.forceFlush(), loggerProvider.forceFlush(), meterProvider.forceFlush(),
    ]);
  }

  async function shutdown() {
    await flush();
    await Promise.allSettled([
      tracerProvider.shutdown(), loggerProvider.shutdown(), meterProvider.shutdown(),
    ]);
  }

  return { serviceName, tracer, metrics, startSpan, log, failSpan, flush, shutdown };
}
