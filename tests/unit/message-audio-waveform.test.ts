import { describe, it, expect } from 'vitest'
import {
  encodeWaveformPeaksNormalized,
  decodeWaveformPeaksNormalized,
  assertValidWaveformPeaksNormalized,
} from '../../src/lib/message-audio-waveform'

describe('message-audio-waveform', () => {
  it('round-trips normalized peaks', () => {
    const peaks = [0, 0.5, 1]
    const enc = encodeWaveformPeaksNormalized(peaks)
    expect(enc.v).toBe(1)
    const back = decodeWaveformPeaksNormalized(enc)
    expect(back?.length).toBe(3)
    expect(back![0]).toBeCloseTo(0, 2)
    expect(back![1]).toBeCloseTo(0.5, 1)
    expect(back![2]).toBeCloseTo(1, 2)
  })

  it('rejects invalid peaks', () => {
    expect(() => assertValidWaveformPeaksNormalized([1.1])).toThrow()
  })
})
