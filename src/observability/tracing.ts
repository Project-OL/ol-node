/**
 * OBS-06: request tracing (HTTP, Prisma queries, Redis), exported over OTLP.
 *
 * Off unless OTEL_TRACING=on. When off nothing below is even required, so the process is exactly
 * what it was before. It must be the first import of an entry point: the HTTP and ioredis
 * instrumentations patch those modules as they load.
 *
 *   OTEL_TRACING=on                                  enable
 *   OTEL_SAMPLE_RATIO=0.05                           share of new traces kept (parent-based; default 5 %)
 *   OTEL_SERVICE_NAME=ol-api                         service name shown in Cloud Trace
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4317  OTLP gRPC collector
 *
 * On GCP the collector is the Ops Agent on the same VM (`combined.receivers.otlp`), which forwards
 * to Cloud Trace as the VM's service account (needs roles/cloudtrace.agent). The app itself holds no
 * GCP credentials. Export failures are logged by the SDK and never reach a request.
 */
import * as dotenv from 'dotenv'

dotenv.config()

const IGNORED_PATHS = new Set(['/health', '/live-health', '/metrics'])

const sampleRatio = (): number => {
  const n = Number(process.env.OTEL_SAMPLE_RATIO ?? '0.05')
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.05
}

export const tracingEnabled = (): boolean => process.env.OTEL_TRACING === 'on'

if (tracingEnabled()) {
  try {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node')
    const {
      BatchSpanProcessor,
      ParentBasedSampler,
      TraceIdRatioBasedSampler,
    } = require('@opentelemetry/sdk-trace-base')
    const { resourceFromAttributes } = require('@opentelemetry/resources')
    const { registerInstrumentations } = require('@opentelemetry/instrumentation')
    const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http')
    const { IORedisInstrumentation } = require('@opentelemetry/instrumentation-ioredis')
    const { PrismaInstrumentation } = require('@prisma/instrumentation')
    const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-grpc')
    /* eslint-enable @typescript-eslint/no-var-requires */

    const provider = new NodeTracerProvider({
      resource: resourceFromAttributes({
        'service.name': process.env.OTEL_SERVICE_NAME || 'ol-api',
      }),
      sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(sampleRatio()) }),
      spanProcessors: [
        new BatchSpanProcessor(
          new OTLPTraceExporter({
            url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://127.0.0.1:4317',
          }),
        ),
      ],
    })
    provider.register()

    registerInstrumentations({
      instrumentations: [
        new HttpInstrumentation({
          ignoreIncomingRequestHook: (req: { url?: string }) =>
            IGNORED_PATHS.has((req.url ?? '').split('?')[0]),
        }),
        new IORedisInstrumentation({ requireParentSpan: true }),
        new PrismaInstrumentation(),
      ],
    })

    const flush = () => {
      void provider.shutdown().catch(() => {})
    }
    process.once('SIGTERM', flush)
    process.once('SIGINT', flush)
    console.log(`[tracing] on: OTLP, sample ratio ${sampleRatio()}`)
  } catch (err) {
    console.error('[tracing] failed to start; continuing without tracing', err)
  }
}
