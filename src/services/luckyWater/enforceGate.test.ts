import { describe, expect, it } from 'vitest'
import { AppError } from '../../middlewares/errorHandler'
import { assertEnforceF10Gate } from './enforceGate'

describe('luckyWater enforce F10 gate', () => {
  it('blocks enforce without any seed decision', () => {
    expect(() =>
      assertEnforceF10Gate({
        hasSeedDecision: false,
        hadShadowConfig: true,
        hadShadowAudit: true,
      }),
    ).toThrow(AppError)
    try {
      assertEnforceF10Gate({
        hasSeedDecision: false,
        hadShadowConfig: true,
        hadShadowAudit: true,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(AppError)
      expect((e as AppError).code).toBe('LUCKY_TIER_ENFORCE_NO_SEED')
    }
  })

  it('allows enforce with seed + shadow history', () => {
    expect(() =>
      assertEnforceF10Gate({
        hasSeedDecision: true,
        hadShadowConfig: true,
        hadShadowAudit: false,
      }),
    ).not.toThrow()
  })

  it('blocks enforce with seed but no shadow unless override reason', () => {
    expect(() =>
      assertEnforceF10Gate({
        hasSeedDecision: true,
        hadShadowConfig: false,
        hadShadowAudit: false,
      }),
    ).toThrow(AppError)
  })

  it('allows enforce with seed and override reason when shadow skipped', () => {
    expect(() =>
      assertEnforceF10Gate({
        hasSeedDecision: true,
        hadShadowConfig: false,
        hadShadowAudit: false,
        enforceOverrideReason: 'Owner accepted sim-only gate for T10K',
      }),
    ).not.toThrow()
  })
})
