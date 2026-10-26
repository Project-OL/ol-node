/**
 * C1/G2: detect nested global-Prisma use inside a lucky money interactive transaction.
 *
 * Mode is fixed once at module load via `LUCKY_NESTED_PRISMA_GUARD`:
 *   - `off`   — no Proxy on exported clients (default when NODE_ENV=production)
 *   - `log`   — Proxy logs a structured warning and continues (default staging/dev)
 *   - `throw` — Proxy throws LUCKY_NESTED_PRISMA (default when NODE_ENV=test)
 *
 * Legacy aliases: `1`/`true` → throw, `0`/`false` → off.
 */
import { AsyncLocalStorage } from 'async_hooks'
import { env } from '../../config/env'

export type NestedPrismaGuardMode = 'off' | 'log' | 'throw'

type Store = { active: true; label: string }

const als = new AsyncLocalStorage<Store>()

function resolveGuardMode(): NestedPrismaGuardMode {
  const raw = (process.env.LUCKY_NESTED_PRISMA_GUARD ?? '').trim().toLowerCase()
  if (raw === 'off' || raw === '0' || raw === 'false') return 'off'
  if (raw === 'log') return 'log'
  if (raw === 'throw' || raw === '1' || raw === 'true') return 'throw'
  if (env.NODE_ENV === 'production') return 'off'
  if (env.NODE_ENV === 'test') return 'throw'
  // development and any non-production staging-like host
  return 'log'
}

/** Resolved once — callers must not expect runtime flips after import. */
export const LUCKY_NESTED_PRISMA_GUARD_MODE: NestedPrismaGuardMode = resolveGuardMode()

export function luckyMoneyTxGuardEnabled(): boolean {
  return LUCKY_NESTED_PRISMA_GUARD_MODE !== 'off'
}

export function runInLuckyMoneyTx<T>(label: string, fn: () => Promise<T>): Promise<T> {
  return als.run({ active: true, label }, fn)
}

export function isInsideLuckyMoneyTx(): boolean {
  return als.getStore()?.active === true
}

/**
 * Called from the nested-prisma Proxy when global client model/$ops are touched under ALS.
 * `operation` may be empty when only the model property was accessed.
 */
export function reportNestedPrismaUse(site: {
  label?: string
  model: string
  operation: string
}): void {
  if (LUCKY_NESTED_PRISMA_GUARD_MODE === 'off') return
  const store = als.getStore()
  if (!store?.active) return

  const label = site.label ?? store.label
  const stack = new Error('LUCKY_NESTED_PRISMA stack').stack ?? ''
  const payload = {
    event: 'LUCKY_NESTED_PRISMA',
    label,
    model: site.model,
    operation: site.operation || '(property-access)',
    stack,
  }

  if (LUCKY_NESTED_PRISMA_GUARD_MODE === 'log') {
    // Structured warn without importing pino/rootLogger (keeps database.ts import graph free of LOG_LEVEL).
    console.warn(JSON.stringify(payload))
    return
  }

  throw new Error(
    `LUCKY_NESTED_PRISMA: global prisma used while lucky money tx "${label}" is active at prisma.${site.model}${
      site.operation ? `.${site.operation}` : ''
    }`,
  )
}

/** @deprecated Prefer reportNestedPrismaUse — kept for call sites that only have a site string. */
export function assertNotInsideLuckyMoneyTx(site: string): void {
  if (!luckyMoneyTxGuardEnabled()) return
  const store = als.getStore()
  if (!store?.active) return
  const m = /^prisma\.([^.]+)(?:\.(.+))?$/.exec(site)
  reportNestedPrismaUse({
    label: store.label,
    model: m?.[1] ?? site,
    operation: m?.[2] ?? '',
  })
}
