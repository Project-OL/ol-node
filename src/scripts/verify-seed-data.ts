/**
 * Reconcile seeded reference data against the defaults the code ships with.
 *
 * Written for the GCP cutover, where the database arrives as a restored dump
 * and nobody can be sure which reference tables came with it. A dump audit on
 * 2026-09-08 found every seeded table intact except `admin_views`, which was
 * empty while the code defines ~26 views — so this both proves the rest and
 * fixes that one.
 *
 * Deliberately lives under `src/scripts/` rather than `scripts/`: only `src/**`
 * is compiled into `dist/`, and neither `tsx` nor the root `scripts/` directory
 * is shipped to the servers. A cutover step that cannot run on the box it is
 * needed on is worse than no step at all.
 *
 *   npm run seed:verify              # report only, exits 1 if anything is off
 *   npm run seed:verify -- --repair  # additionally fix what is safe to fix
 *
 * Repair policy — deliberately narrow:
 *   - `admin_views` is repaired always. Creating a missing view, and merging
 *     missing endpoints into an existing one, is purely additive: it cannot
 *     remove a custom endpoint an operator added.
 *   - Every other table is repaired ONLY when completely empty, and even then
 *     only by reporting the seeder to run. Non-empty means an admin has tuned
 *     those values (rates, fee tiers, price caps) and silently overwriting
 *     them during a cutover would be a financial change nobody asked for.
 */
import 'dotenv/config'
import { prisma } from '../config/database'
import { DEFAULT_ADMIN_VIEWS } from '../config/admin-default-views'
import {
  DEFAULT_COIN_TRADING_TOPUP_RATES,
  DEFAULT_AGENT_EXCHANGE_RATES,
} from '../config/coin-trading-rates.defaults'
import { DEFAULT_COIN_TRADING_TOPUP_PACKAGES } from '../config/coin-trading-topup-packages.defaults'
import { DEFAULT_PAYROLL_FEE_TIERS } from '../config/payroll-fee-tiers.defaults'
import { DEFAULT_VIDEO_CALL_PRICE_CAPS } from '../config/video-call-price-caps.defaults'
import {
  DEFAULT_WEALTH_LEVEL_THRESHOLDS,
  DEFAULT_LIVESTREAM_LEVEL_THRESHOLDS,
} from '../config/wallet-level-thresholds.defaults'
import { rootLogger } from '../utils/rootLogger'

const log = rootLogger.child({ script: 'verify-seed-data' })
const REPAIR = process.argv.includes('--repair')

type Check = {
  label: string
  /** How many rows the shipped defaults imply. 0 means "just expect some". */
  expected: number
  count: () => Promise<number>
  /** Command that would populate it, surfaced when the table is empty. */
  seeder?: string
}

const checks: Check[] = [
  {
    label: 'coin_trading_topup_rates (active)',
    expected: DEFAULT_COIN_TRADING_TOPUP_RATES.length,
    count: () => prisma.coinTradingTopupRate.count({ where: { isActive: true } }),
    seeder: 'npm run seed:coin-trading-rates',
  },
  {
    label: 'agent_exchange_rates (active)',
    expected: DEFAULT_AGENT_EXCHANGE_RATES.length,
    count: () => prisma.agentExchangeRate.count({ where: { isActive: true } }),
    seeder: 'npm run seed:coin-trading-rates',
  },
  {
    label: 'coin_trading_topup_packages',
    expected: DEFAULT_COIN_TRADING_TOPUP_PACKAGES.length,
    count: () => prisma.coinTradingTopupPackage.count(),
    seeder: 'npm run seed:coin-trading-topup-packages',
  },
  {
    label: 'wallet_level_configs',
    expected: DEFAULT_WEALTH_LEVEL_THRESHOLDS.length + DEFAULT_LIVESTREAM_LEVEL_THRESHOLDS.length,
    count: () => prisma.walletLevelConfig.count(),
    seeder: 'npm run db:seed (fresh database only)',
  },
  {
    label: 'payroll_fee_tiers',
    expected: DEFAULT_PAYROLL_FEE_TIERS.length,
    count: () => prisma.payrollFeeTier.count(),
  },
  {
    label: 'video_call_price_caps',
    expected: DEFAULT_VIDEO_CALL_PRICE_CAPS.length,
    count: () => prisma.videoCallPriceCap.count(),
  },
  { label: 'rich_tier_configs', expected: 0, count: () => prisma.richTierConfig.count() },
  { label: 'coin_packages', expected: 0, count: () => prisma.coinPackage.count() },
  { label: 'gifts', expected: 0, count: () => prisma.gift.count() },
  { label: 'system_admins', expected: 0, count: () => prisma.systemAdmin.count() },
]

/** Mirrors scripts/seed-admin-views.ts: create missing, merge endpoints, never remove. */
async function reconcileAdminViews(): Promise<{ missing: number; short: number; fixed: number }> {
  let missing = 0
  let short = 0
  let fixed = 0

  for (const [name, endpoints] of Object.entries(DEFAULT_ADMIN_VIEWS)) {
    const existing = await prisma.adminView.findUnique({ where: { name } })

    if (!existing) {
      missing++
      log.warn({ view: name, endpoints: endpoints.length }, 'view missing')
      if (REPAIR) {
        await prisma.adminView.create({ data: { name, endpoints } })
        fixed++
      }
      continue
    }

    const have = new Set(existing.endpoints)
    const absent = endpoints.filter((e) => !have.has(e))
    if (absent.length === 0) continue

    short++
    log.warn(
      { view: name, missingEndpoints: absent.length, sample: absent.slice(0, 3) },
      'view incomplete',
    )
    if (REPAIR) {
      await prisma.adminView.update({
        where: { id: existing.id },
        data: { endpoints: [...existing.endpoints, ...absent] },
      })
      fixed++
    }
  }

  return { missing, short, fixed }
}

async function main() {
  log.info({ repair: REPAIR }, REPAIR ? 'verifying and repairing' : 'verifying (read-only)')

  let problems = 0

  log.info('--- admin views ---')
  const views = await reconcileAdminViews()
  const totalViews = Object.keys(DEFAULT_ADMIN_VIEWS).length
  const nowInDb = await prisma.adminView.count()
  log.info(
    {
      defined: totalViews,
      inDb: nowInDb,
      missing: views.missing,
      incomplete: views.short,
      repaired: views.fixed,
    },
    'admin views',
  )
  if (!REPAIR && (views.missing > 0 || views.short > 0)) problems++

  log.info('--- seeded reference tables ---')
  const empties: string[] = []
  for (const c of checks) {
    const actual = await c.count()
    const ok = c.expected === 0 ? actual > 0 : actual >= c.expected
    log.info({ table: c.label, expected: c.expected || '>0', actual, ok }, ok ? 'ok' : 'MISMATCH')
    if (!ok) {
      problems++
      if (actual === 0 && c.seeder) empties.push(`${c.label} -> ${c.seeder}`)
    }
  }

  // The 2026-09-06 bug: re-running a createMany seed against populated tables
  // duplicated whole rate ladders. Same sort_order twice while active is the
  // signature, and it makes the rate charged depend on row order.
  const dupes = await prisma.$queryRawUnsafe<{ t: string; sort_order: number; n: number }[]>(`
    select 'coin_trading_topup_rates' t, sort_order, count(*)::int n
      from coin_trading_topup_rates where is_active group by 1,2 having count(*) > 1
    union all
    select 'agent_exchange_rates', sort_order, count(*)::int
      from agent_exchange_rates where is_active group by 1,2 having count(*) > 1`)
  if (dupes.length > 0) {
    problems++
    log.error({ dupes }, 'DUPLICATE active rate tiers — run npm run fix:dedupe-coin-trading-rates')
  } else {
    log.info('no duplicate active rate tiers')
  }

  if (empties.length > 0) {
    log.warn(
      { empties },
      'empty tables are NOT auto-filled: non-empty values may be admin-tuned, and overwriting rates mid-cutover is a financial change nobody asked for',
    )
  }

  log.info(
    { problems, repaired: views.fixed },
    problems === 0 ? 'all seed data present' : 'issues found',
  )
  if (problems > 0) process.exitCode = 1

  await prisma.$disconnect()
}

main().catch(async (err) => {
  log.error({ err }, 'fatal')
  await prisma.$disconnect().catch(() => {})
  process.exit(1)
})
