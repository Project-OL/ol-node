import { describe, expect, it } from 'vitest'
import { evaluateNudityLabels } from './face-registration-moderation.service'

describe('evaluateNudityLabels', () => {
  const opts = { strictMode: false, threshold: 50 }

  it('rejects Explicit Nudity and Explicit parent labels', () => {
    expect(
      evaluateNudityLabels([{ label: 'Explicit Nudity', confidence: 80 }], opts).isNudityDetected,
    ).toBe(true)
    expect(
      evaluateNudityLabels([{ label: 'Explicit', confidence: 91 }], opts).isNudityDetected,
    ).toBe(true)
  })

  it('rejects Suggestive at or above threshold', () => {
    expect(
      evaluateNudityLabels([{ label: 'Suggestive', confidence: 50 }], opts).isNudityDetected,
    ).toBe(true)
  })

  it('ignores Partial Nudity unless strict mode', () => {
    const partial = [{ label: 'Partial Nudity', confidence: 99 }]
    expect(evaluateNudityLabels(partial, opts).isNudityDetected).toBe(false)
    expect(evaluateNudityLabels(partial, { ...opts, strictMode: true }).isNudityDetected).toBe(true)
  })

  it('treats Non-Explicit Nudity like Partial Nudity', () => {
    const labels = [{ label: 'Non-Explicit Nudity', confidence: 70 }]
    expect(evaluateNudityLabels(labels, opts).isNudityDetected).toBe(false)
    expect(evaluateNudityLabels(labels, { ...opts, strictMode: true }).isNudityDetected).toBe(true)
  })

  it('ignores labels below the confidence threshold', () => {
    expect(
      evaluateNudityLabels([{ label: 'Explicit Nudity', confidence: 49 }], opts).isNudityDetected,
    ).toBe(false)
  })

  it('ignores unrelated labels', () => {
    expect(
      evaluateNudityLabels([{ label: 'Alcohol', confidence: 99 }], opts).isNudityDetected,
    ).toBe(false)
  })
})
