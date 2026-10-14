import { describe, it, expect, vi } from 'vitest'

// The job module pulls in Prisma/Redis-backed modules; the helpers under test are pure.
vi.mock('../../src/config/database', () => ({ prisma: {} }))
vi.mock('../../src/repositories/systemAdmin.repository', () => ({ systemAdminRepository: {} }))
vi.mock('../../src/services/providers/email.provider', () => ({ emailProvider: {} }))

const { evaluateLowUsage, evaluateThresholds, LOW_USAGE_MIN_SNAPSHOTS_PER_DAY } = await import(
  '../../src/services/gcp-usage-monitor.service'
)
const { infraAlertRecipients } = await import('../../src/jobs/gcp-infra-monitor.job')

const hourly = (days: number, value: number) =>
  Array.from({ length: days * LOW_USAGE_MIN_SNAPSHOTS_PER_DAY }, () => value)

describe('INF-22 low-usage ("consider downgrading") rule', () => {
  it('flags when memory stayed at or below the low threshold for the whole window', () => {
    const c = evaluateLowUsage([...hourly(7, 12), 18], { memLowPct: 20, memLowDays: 7 })
    expect(c).toMatchObject({ metric: 'memLowPct', value: 18, threshold: 20, severity: 'WARNING' })
    expect(c?.message).toContain('Consider downgrading')
  })

  it('does not flag when one sample in the window went above the threshold', () => {
    expect(evaluateLowUsage([...hourly(7, 10), 35], { memLowPct: 20, memLowDays: 7 })).toBeNull()
  })

  it('waits for enough history before trusting a quiet window', () => {
    expect(evaluateLowUsage(hourly(3, 5), { memLowPct: 20, memLowDays: 7 })).toBeNull()
  })

  it('is off unless memLowPct is configured, and ignores missing samples', () => {
    expect(evaluateLowUsage(hourly(7, 5), {})).toBeNull()
    const withGaps = [...hourly(7, 5), null, undefined]
    expect(evaluateLowUsage(withGaps, { memLowPct: 20 })?.value).toBe(5)
  })

  it('high thresholds keep working alongside it (memWarn 75 / memCrit 90)', () => {
    const metrics = { memPct: 80 } as Parameters<typeof evaluateThresholds>[0]
    expect(evaluateThresholds(metrics, { memWarn: 75, memCrit: 90, memLowPct: 20 })).toEqual([
      expect.objectContaining({ metric: 'memPct', severity: 'WARNING', threshold: 75 }),
    ])
  })
})

describe('INF-22 alert recipients', () => {
  it('adds the extra inbox to the SUPER_ADMINs, deduplicated and lower-cased', () => {
    expect(
      infraAlertRecipients(['Admin@Example.com'], ['offooliveinfo@gmail.com', 'admin@example.com']),
    ).toEqual(['admin@example.com', 'offooliveinfo@gmail.com'])
  })

  it('still mails the extra inbox when no SUPER_ADMIN is active', () => {
    expect(infraAlertRecipients([], ['offooliveinfo@gmail.com'])).toEqual(['offooliveinfo@gmail.com'])
  })
})
