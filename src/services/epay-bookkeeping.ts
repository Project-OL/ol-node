import { CompanyCashDirection, CompanyCashReason, Prisma, WalletCurrencyType } from '@prisma/client'
import { companyCashRepository } from '../repositories/companyCash.repository'

/**
 * Company cash bookings for Epay money (master ledger P&L reads `company_cash_entries`):
 *  - trading top-up paid   → IN  AGENCY_TRADING_PURCHASE (the sale) + OUT EPAY_FEE (if any)
 *  - payout succeeded      → OUT EPAY_FEE (the transfer itself is booked as EPAY_PAYOUT by
 *                            withdrawalService when the withdrawal settles)
 *  - pay-in refunded       → OUT EPAY_REFUND
 * Always called INSIDE the transaction whose exactly-once claim already won (the order claim,
 * the payment_transactions insert), so a booking can never be written twice.
 */

const SYSTEM = 'system'

function positive(d: Prisma.Decimal | null | undefined): d is Prisma.Decimal {
  return d != null && d.isFinite() && d.gt(0)
}

export const epayBookkeeping = {
  async tradingTopupPaid(
    tx: Prisma.TransactionClient,
    p: {
      agentUserId: string
      merchantOrderNo: string
      paidAmount: Prisma.Decimal
      tradingCoins: bigint
      fee?: Prisma.Decimal | null
    },
  ): Promise<void> {
    await companyCashRepository.create(
      {
        direction: CompanyCashDirection.IN,
        reason: CompanyCashReason.AGENCY_TRADING_PURCHASE,
        amountUsd: p.paidAmount,
        unitsAmount: p.tradingCoins,
        currencyType: WalletCurrencyType.TRADING_COIN,
        counterpartyUserId: p.agentUserId,
        ledgerRefId: p.merchantOrderNo,
        description: 'Epay trading top-up',
        adminUserId: SYSTEM,
      },
      tx,
    )
    await epayBookkeeping.fee(tx, {
      fee: p.fee,
      counterpartyUserId: p.agentUserId,
      ledgerRefId: p.merchantOrderNo,
      description: 'Epay pay-in fee (trading top-up)',
    })
  },

  async fee(
    tx: Prisma.TransactionClient,
    p: {
      fee: Prisma.Decimal | null | undefined
      counterpartyUserId: string
      ledgerRefId: string
      withdrawalId?: string | null
      description: string
    },
  ): Promise<void> {
    if (!positive(p.fee)) return
    await companyCashRepository.create(
      {
        direction: CompanyCashDirection.OUT,
        reason: CompanyCashReason.EPAY_FEE,
        amountUsd: p.fee,
        counterpartyUserId: p.counterpartyUserId,
        ledgerRefId: p.ledgerRefId,
        withdrawalId: p.withdrawalId ?? null,
        description: p.description,
        adminUserId: SYSTEM,
      },
      tx,
    )
  },

  async refund(
    tx: Prisma.TransactionClient,
    p: { amount: Prisma.Decimal; counterpartyUserId: string; ledgerRefId: string },
  ): Promise<void> {
    if (!positive(p.amount)) return
    await companyCashRepository.create(
      {
        direction: CompanyCashDirection.OUT,
        reason: CompanyCashReason.EPAY_REFUND,
        amountUsd: p.amount,
        counterpartyUserId: p.counterpartyUserId,
        ledgerRefId: p.ledgerRefId,
        description: 'Epay refund to payer',
        adminUserId: SYSTEM,
      },
      tx,
    )
  },
}
