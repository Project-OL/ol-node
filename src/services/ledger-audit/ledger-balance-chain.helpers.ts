import { LedgerDirection, PointTxType } from '@prisma/client'

/**
 * Soft point markers that record an amount but leave the running `balanceAfter` unchanged
 * (available points are tracked via unconfirmed / escrow totals separately).
 */
export function pointLedgerBalanceCarriesForward(txType: string): boolean {
  return txType === PointTxType.WITHDRAWAL_ESCROW
}

export function expectedBalanceAfter(args: {
  balanceBefore: bigint
  direction: LedgerDirection | 'CREDIT' | 'DEBIT'
  amount: bigint
  balanceCarriesForward?: boolean
}): bigint {
  if (args.balanceCarriesForward) return args.balanceBefore
  const isCredit =
    args.direction === LedgerDirection.CREDIT || (args.direction as string) === 'CREDIT'
  if (isCredit) return args.balanceBefore + args.amount
  return args.balanceBefore - args.amount
}

export type BalanceChainCheck = {
  ok: boolean
  balanceBefore: bigint
  expectedBalanceAfter: bigint
  actualBalanceAfter: bigint
  balanceCarriesForward: boolean
}

export function checkLedgerBalanceChain(args: {
  balanceBefore: bigint
  direction: LedgerDirection | 'CREDIT' | 'DEBIT'
  amount: bigint
  balanceAfter: bigint
  balanceCarriesForward?: boolean
}): BalanceChainCheck {
  const balanceCarriesForward = args.balanceCarriesForward === true
  const expected = expectedBalanceAfter({
    balanceBefore: args.balanceBefore,
    direction: args.direction,
    amount: args.amount,
    balanceCarriesForward,
  })
  return {
    ok: expected === args.balanceAfter,
    balanceBefore: args.balanceBefore,
    expectedBalanceAfter: expected,
    actualBalanceAfter: args.balanceAfter,
    balanceCarriesForward,
  }
}
