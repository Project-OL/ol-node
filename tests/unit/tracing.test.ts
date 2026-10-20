import { describe, it, expect, afterEach, vi } from 'vitest'

describe('observability/tracing (OBS-06)', () => {
  afterEach(() => {
    delete process.env.OTEL_TRACING
    vi.resetModules()
  })

  it('is off unless OTEL_TRACING=on, and loads no OpenTelemetry module', async () => {
    delete process.env.OTEL_TRACING
    const before = Object.keys(require.cache).filter((k) => k.includes('@opentelemetry')).length
    const mod = await import('../../src/observability/tracing')
    expect(mod.tracingEnabled()).toBe(false)
    const after = Object.keys(require.cache).filter((k) => k.includes('@opentelemetry')).length
    expect(after).toBe(before)
  })

  it('reads the flag literally', async () => {
    const mod = await import('../../src/observability/tracing')
    process.env.OTEL_TRACING = 'true'
    expect(mod.tracingEnabled()).toBe(false)
    process.env.OTEL_TRACING = 'on'
    expect(mod.tracingEnabled()).toBe(true)
  })
})
