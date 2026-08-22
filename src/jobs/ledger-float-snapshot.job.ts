import type { Job } from 'bullmq'
import { ledgerFloatSnapshotRepository } from '../repositories/ledgerFloatSnapshot.repository'
import { ledgerAccountRoleService } from '../services/ledgerAccountRole.service'
import { computeFloatAt } from '../services/masterLedger.service'

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0))
}

/**
 * Materialize unit float at UTC midnight so period-start balances reuse a snapshot
 * instead of re-scanning every wallet on each dashboard load.
 */
export async function processLedgerFloatSnapshotJob(_job: Job): Promise<void> {
  const snapshotAt = startOfUtcDay(new Date())
  const house = await ledgerAccountRoleService.getHouseAccounts()
  const buckets = await computeFloatAt(snapshotAt, house)

  await ledgerFloatSnapshotRepository.upsert({
    snapshotAt,
    customerCoins: buckets.customerCoins,
    customerTradingCoins: buckets.customerTradingCoins,
    customerHostPoints: buckets.customerHostPoints,
    customerAgencyPoints: buckets.customerAgencyPoints,
    customerTotal: buckets.customerTotal,
    houseCoins: buckets.houseCoins,
    houseTradingCoins: buckets.houseTradingCoins,
    housePoints: buckets.housePoints,
    houseTotal: buckets.houseTotal,
    ledgerNet: buckets.ledgerNet,
    identityDelta: buckets.identityDelta,
  })

  console.info('[ledger-float-snapshot] stored', {
    snapshotAt: snapshotAt.toISOString(),
    customerTotal: buckets.customerTotal.toString(),
    houseTotal: buckets.houseTotal.toString(),
    identityDelta: buckets.identityDelta.toString(),
  })
}
