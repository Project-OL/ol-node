import type { PointLedgerEntry, PointTxType, WithdrawalStatus } from '@prisma/client'
import { PointTxType as PointTxTypeEnum } from '@prisma/client'
import type { PaymentMethodLike } from './payment-method-mask'
import { mapPaymentMethodMaskedForHost } from './payment-method-mask'
import { formatPointTransactionOrderNumber } from './point-transaction-order'

export const POINT_TRANSFER_TX_TYPES = new Set<PointTxType>([
  PointTxTypeEnum.AGENT_POINT_TRANSFER,
  PointTxTypeEnum.TRANSFER_IN,
  PointTxTypeEnum.TRANSFER_OUT,
])

export const POINT_WITHDRAWAL_TX_TYPES = new Set<PointTxType>([
  PointTxTypeEnum.WITHDRAWAL,
  PointTxTypeEnum.WITHDRAWAL_REFUND,
  PointTxTypeEnum.WITHDRAWAL_ESCROW,
  PointTxTypeEnum.WITHDRAWAL_ESCROW_SETTLED,
  PointTxTypeEnum.PAYROLL_HOST_PAYOUT,
  PointTxTypeEnum.PAYROLL_PROCESSING_REWARD,
])

export type PointTransactionKind = 'POINT_TRANSFER' | 'WITHDRAWAL'

export type PointTransactionStatus =
  | 'SUCCESS'
  | 'PENDING'
  | 'FAILED'
  | 'REFUNDED'
  | 'DISPUTED'
  | 'REJECTED'

export type PointTransactionPaymentDetails = {
  method: string
  accountLabel: string
  accountInfo: string
  paymentMethod: ReturnType<typeof mapPaymentMethodMaskedForHost> | null
}

export type PointTransactionReportHint = {
  orderNumber: string
  allowed: boolean
  supportType: 'REPORT_COMPLAINTS'
  supportSubType: 'POINT_TRANSFER_CONFLICT' | 'WITHDRAWAL_DISPUTE'
  transactionRef: {
    refType: 'POINT_TRANSFER' | 'WITHDRAWAL'
    refId: string
  }
}

type CounterpartyLike = {
  publicId: string
  displayName: string
}

function paymentMethodLabel(method: PaymentMethodLike | null | undefined): string {
  if (!method) return 'Bank Transfer'
  return method.methodType === 'EPAY' ? 'Epay' : 'Bank Transfer'
}

function formatTransferAccount(counterparty: CounterpartyLike | null): string | null {
  if (!counterparty) return null
  return `Agent ID ${counterparty.publicId} — ${counterparty.displayName}`
}

function formatWithdrawalAccount(method: PaymentMethodLike | null | undefined): string | null {
  if (!method) return null
  const masked = mapPaymentMethodMaskedForHost(method)
  if (masked.methodType === 'EPAY') {
    return masked.epayEmail ?? null
  }
  const parts = [masked.bankName, masked.accountNumber].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : null
}

export function resolvePointTransactionKind(txType: PointTxType): PointTransactionKind | null {
  if (POINT_TRANSFER_TX_TYPES.has(txType)) return 'POINT_TRANSFER'
  if (POINT_WITHDRAWAL_TX_TYPES.has(txType)) return 'WITHDRAWAL'
  return null
}

export function resolvePointTransactionStatus(
  txType: PointTxType,
  withdrawalStatus?: WithdrawalStatus | null,
): { status: PointTransactionStatus; statusLabel: string } {
  if (POINT_TRANSFER_TX_TYPES.has(txType)) {
    return { status: 'SUCCESS', statusLabel: 'Transfer Successful' }
  }

  if (txType === PointTxTypeEnum.WITHDRAWAL_REFUND) {
    return { status: 'REFUNDED', statusLabel: 'Withdrawal Refunded' }
  }

  if (!withdrawalStatus) {
    if (
      txType === PointTxTypeEnum.WITHDRAWAL_ESCROW ||
      txType === PointTxTypeEnum.WITHDRAWAL
    ) {
      return { status: 'PENDING', statusLabel: 'Withdrawal Processing' }
    }
    if (
      txType === PointTxTypeEnum.WITHDRAWAL_ESCROW_SETTLED ||
      txType === PointTxTypeEnum.PAYROLL_HOST_PAYOUT
    ) {
      return { status: 'SUCCESS', statusLabel: 'Withdrawal Successful' }
    }
    return { status: 'SUCCESS', statusLabel: 'Withdrawal Successful' }
  }

  switch (withdrawalStatus) {
    case 'PAID':
      return { status: 'SUCCESS', statusLabel: 'Withdrawal Successful' }
    case 'WAITING':
      return { status: 'PENDING', statusLabel: 'Awaiting Confirmation' }
    case 'PENDING':
    case 'PROCESSING':
    case 'PENDING_PLATFORM':
      return { status: 'PENDING', statusLabel: 'Withdrawal Processing' }
    case 'FAILED':
      return { status: 'FAILED', statusLabel: 'Withdrawal Failed' }
    case 'REJECTED':
      return { status: 'REJECTED', statusLabel: 'Withdrawal Rejected' }
    case 'DISPUTED':
      return { status: 'DISPUTED', statusLabel: 'Withdrawal Disputed' }
    case 'KYC_CHECK':
    case 'APPROVED':
      return { status: 'PENDING', statusLabel: 'Withdrawal Processing' }
    default:
      return { status: 'PENDING', statusLabel: 'Withdrawal Processing' }
  }
}

export function buildPointTransactionPaymentDetails(params: {
  txType: PointTxType
  counterparty: CounterpartyLike | null
  paymentMethod: PaymentMethodLike | null | undefined
}): PointTransactionPaymentDetails | null {
  const kind = resolvePointTransactionKind(params.txType)
  if (!kind) return null

  if (kind === 'POINT_TRANSFER') {
    return {
      method: 'Point Transfer',
      accountLabel: 'Account',
      accountInfo: formatTransferAccount(params.counterparty) ?? 'Agent',
      paymentMethod: null,
    }
  }

  const masked = params.paymentMethod ? mapPaymentMethodMaskedForHost(params.paymentMethod) : null
  return {
    method: paymentMethodLabel(params.paymentMethod),
    accountLabel: 'Account',
    accountInfo: formatWithdrawalAccount(params.paymentMethod) ?? '—',
    paymentMethod: masked,
  }
}

export function buildPointTransactionReportHint(params: {
  entry: Pick<PointLedgerEntry, 'id' | 'createdAt' | 'txType'>
  businessRefId: string | null
}): PointTransactionReportHint | null {
  const kind = resolvePointTransactionKind(params.entry.txType)
  if (!kind || !params.businessRefId) return null

  const orderNumber = formatPointTransactionOrderNumber(params.entry.id, params.entry.createdAt)

  if (kind === 'POINT_TRANSFER') {
    return {
      orderNumber,
      allowed: true,
      supportType: 'REPORT_COMPLAINTS',
      supportSubType: 'POINT_TRANSFER_CONFLICT',
      transactionRef: {
        refType: 'POINT_TRANSFER',
        refId: params.businessRefId,
      },
    }
  }

  return {
    orderNumber,
    allowed: true,
    supportType: 'REPORT_COMPLAINTS',
    supportSubType: 'WITHDRAWAL_DISPUTE',
    transactionRef: {
      refType: 'WITHDRAWAL',
      refId: params.businessRefId,
    },
  }
}
