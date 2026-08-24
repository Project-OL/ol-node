import { CoinTxType, LedgerDirection, PointTxType, WalletCurrencyType } from '@prisma/client'
import { prismaRead } from '../config/database'
import { getTransactionName } from '../config/transaction-display-names'
import {
  COUNTERPARTY_USER_SELECT,
  buildCounterpartyDetailsMap,
} from '../utils/ledger-transaction-enrichment'
import { platformMessagingService } from './platformMessaging.service'
import { pushNotificationService } from './pushNotification.service'
import type { PlatformMessageMetadata } from '../models/platform-message.schemas'
import { buildUserDisplayName } from '../utils/user-display'
import { rootLogger } from '../utils/rootLogger'

const log = rootLogger.child({ module: 'transactional-messaging' })

const SKIP_POINT_TX_TYPES = new Set<PointTxType>([
  PointTxType.WITHDRAWAL_ESCROW,
  PointTxType.WITHDRAWAL_ESCROW_SETTLED,
  PointTxType.WITHDRAWAL,
  PointTxType.WITHDRAWAL_REFUND,
  PointTxType.AGENT_COMMISSION,
])

const SKIP_COIN_TX_TYPES = new Set<CoinTxType>([CoinTxType.TRADING_TRANSFER_REVERSAL])

function walletCurrencyLabel(currency: 'COIN' | 'POINT' | 'TRADING_COIN'): string {
  if (currency === 'POINT') return 'points'
  if (currency === 'TRADING_COIN') return 'trading coins'
  return 'coins'
}

function formatAmount(amount: bigint, currency: 'COIN' | 'POINT' | 'TRADING_COIN'): string {
  return `${amount.toString()} ${walletCurrencyLabel(currency)}`
}

function counterpartyFromDetails(
  details: {
    name?: string
    publicId?: string
    userId?: string
    avatarUrl?: string | null
  } | null,
) {
  if (!details?.name && !details?.publicId) return undefined
  return {
    userId: details.userId,
    displayName: details.name ?? 'User',
    publicId: details.publicId,
    avatarUrl: details.avatarUrl ?? null,
  }
}

function buildLedgerClientMessageId(kind: 'coin' | 'point', entryId: string): string {
  return `txn:${kind}:${entryId}`
}

function transactionPushTitle(
  currency: 'COIN' | 'POINT' | 'TRADING_COIN',
  direction: 'CREDIT' | 'DEBIT',
): string {
  const label =
    currency === 'POINT' ? 'Points' : currency === 'TRADING_COIN' ? 'Trading coins' : 'Coins'
  return direction === 'CREDIT' ? `${label} credited` : `${label} debited`
}

/** Fire-and-forget FCM for a wallet credit/debit — never throws into the ledger message path. */
async function pushTransactionalNotification(params: {
  userId: string
  title: string
  body: string
  conversationId?: string
  messageId?: string
  metadata: PlatformMessageMetadata
}): Promise<void> {
  const data: Record<string, string> = {
    type: 'TRANSACTION',
    category: 'transactional',
  }
  if (params.conversationId) data.conversationId = params.conversationId
  if (params.messageId) data.messageId = params.messageId
  if (params.metadata.walletCurrency) data.walletCurrency = params.metadata.walletCurrency
  if (params.metadata.direction) data.direction = params.metadata.direction
  if (params.metadata.txType) data.txType = String(params.metadata.txType)
  if (params.metadata.amount) data.amount = params.metadata.amount
  if (params.metadata.balanceAfter) data.balanceAfter = params.metadata.balanceAfter
  if (params.metadata.ledgerEntryId) data.ledgerEntryId = params.metadata.ledgerEntryId
  if (params.metadata.withdrawalId) data.withdrawalId = params.metadata.withdrawalId
  if (params.metadata.withdrawalEvent) data.withdrawalEvent = params.metadata.withdrawalEvent

  try {
    await pushNotificationService.sendToUser(
      params.userId,
      {
        title: params.title,
        body: params.body,
        data,
      },
      { source: 'TRANSACTION' },
    )
  } catch (err) {
    log.warn({ err, userId: params.userId }, 'transactional push failed')
  }
}

export const transactionalMessagingService = {
  async sendFromCoinLedgerEntry(entryId: string): Promise<void> {
    const entry = await prismaRead.coinLedgerEntry.findUnique({
      where: { id: entryId },
      include: {
        wallet: { select: { userId: true, currencyType: true } },
      },
    })
    if (!entry) return

    if (SKIP_COIN_TX_TYPES.has(entry.txType)) return

    const currencyType = entry.wallet.currencyType
    const walletCurrency =
      currencyType === WalletCurrencyType.TRADING_COIN
        ? 'TRADING_COIN'
        : currencyType === WalletCurrencyType.POINT
          ? 'POINT'
          : 'COIN'

    const selfUserId = entry.wallet.userId
    const counterpartyDetailsMap = await buildCounterpartyDetailsMap(
      [
        {
          id: entry.id,
          direction: entry.direction,
          txType: entry.txType,
          amount: entry.amount,
          refId: entry.refId,
          counterpartyId: entry.counterpartyId,
          metadata: entry.metadata,
          createdAt: entry.createdAt,
        },
      ],
      walletCurrency === 'TRADING_COIN' ? 'TRADING_COIN' : 'COIN',
      selfUserId,
    )
    const cp = counterpartyFromDetails(counterpartyDetailsMap.get(entry.id) ?? null)
    const txLabel = getTransactionName(
      walletCurrency === 'TRADING_COIN' ? 'TRADING_COIN' : 'COIN',
      entry.txType,
      entry.direction,
    )
    const direction = entry.direction === LedgerDirection.CREDIT ? 'CREDIT' : 'DEBIT'
    const sign = direction === 'CREDIT' ? '+' : '-'
    const counterpartyLine = cp?.displayName ? ` with ${cp.displayName}` : ''

    const content = `${txLabel}${counterpartyLine}: ${sign}${formatAmount(entry.amount, walletCurrency)}. Balance: ${formatAmount(entry.balanceAfter, walletCurrency)}.`

    const metadata: PlatformMessageMetadata = {
      category: 'transactional',
      walletCurrency,
      direction,
      txType: entry.txType,
      txLabel,
      amount: entry.amount.toString(),
      balanceAfter: entry.balanceAfter.toString(),
      ledgerEntryId: entry.id,
      refId: entry.refId ?? undefined,
      counterparty: cp,
    }

    const sent = await platformMessagingService.sendPlatformMessage({
      targetUserId: selfUserId,
      type: 'TRANSACTIONAL',
      content,
      metadata,
      clientMessageId: buildLedgerClientMessageId('coin', entry.id),
    })
    if (sent.created) {
      await pushTransactionalNotification({
        userId: selfUserId,
        title: transactionPushTitle(walletCurrency, direction),
        body: content,
        conversationId: sent.conversationId || undefined,
        messageId: sent.messageId || undefined,
        metadata,
      })
    }
  },

  async sendFromPointLedgerEntry(entryId: string): Promise<void> {
    const entry = await prismaRead.pointLedgerEntry.findUnique({
      where: { id: entryId },
      include: {
        wallet: { select: { userId: true } },
      },
    })
    if (!entry) return

    if (SKIP_POINT_TX_TYPES.has(entry.txType)) return

    const selfUserId = entry.wallet.userId
    const counterpartyDetailsMap = await buildCounterpartyDetailsMap(
      [
        {
          id: entry.id,
          direction: entry.direction,
          txType: entry.txType,
          amount: entry.amount,
          refId: entry.refId,
          counterpartyId: entry.counterpartyId,
          metadata: entry.metadata,
          createdAt: entry.createdAt,
        },
      ],
      'POINT',
      selfUserId,
    )
    const cp = counterpartyFromDetails(counterpartyDetailsMap.get(entry.id) ?? null)
    const txLabel = getTransactionName('POINT', entry.txType, entry.direction)
    const direction = entry.direction === LedgerDirection.CREDIT ? 'CREDIT' : 'DEBIT'
    const sign = direction === 'CREDIT' ? '+' : '-'
    const counterpartyLine = cp?.displayName ? ` with ${cp.displayName}` : ''

    const content = `${txLabel}${counterpartyLine}: ${sign}${formatAmount(entry.amount, 'POINT')}. Balance: ${formatAmount(entry.balanceAfter, 'POINT')}.`

    const metadata: PlatformMessageMetadata = {
      category: 'transactional',
      walletCurrency: 'POINT',
      direction,
      txType: entry.txType,
      txLabel,
      amount: entry.amount.toString(),
      balanceAfter: entry.balanceAfter.toString(),
      ledgerEntryId: entry.id,
      refId: entry.refId ?? undefined,
      counterparty: cp,
    }

    const sent = await platformMessagingService.sendPlatformMessage({
      targetUserId: selfUserId,
      type: 'TRANSACTIONAL',
      content,
      metadata,
      clientMessageId: buildLedgerClientMessageId('point', entry.id),
    })
    if (sent.created) {
      await pushTransactionalNotification({
        userId: selfUserId,
        title: transactionPushTitle('POINT', direction),
        body: content,
        conversationId: sent.conversationId || undefined,
        messageId: sent.messageId || undefined,
        metadata,
      })
    }
  },

  async sendWithdrawalEvent(params: {
    withdrawalId: string
    event: string
    hostUserId: string
    agentUserId?: string
    reason?: string
  }): Promise<void> {
    const withdrawal = await prismaRead.withdrawal.findUnique({
      where: { id: params.withdrawalId },
      select: {
        id: true,
        status: true,
        amountPoints: true,
        hostPayoutUsd: true,
      },
    })
    if (!withdrawal) return

    let agent:
      | { userId: string; displayName: string; publicId: string; avatarUrl: string | null }
      | undefined
    if (params.agentUserId) {
      const agentUser = await prismaRead.user.findUnique({
        where: { id: params.agentUserId },
        select: COUNTERPARTY_USER_SELECT,
      })
      if (agentUser) {
        agent = {
          userId: agentUser.id,
          displayName: buildUserDisplayName(agentUser),
          publicId: agentUser.publicId.toString(),
          avatarUrl: agentUser.avatarUrl,
        }
      }
    }

    const points = `${withdrawal.amountPoints.toString()} points`
    const agentLine = agent ? ` Agent: ${agent.displayName}.` : ''
    const reasonLine = params.reason?.trim() ? ` Reason: ${params.reason.trim()}.` : ''

    let content: string
    switch (params.event) {
      case 'created':
        content = `Withdrawal requested: ${points}.${agentLine}`
        break
      case 'agent_rejected':
        content = `Withdrawal rejected by agent: ${points}.${agentLine}${reasonLine}`
        break
      case 'waiting':
        content = `Withdrawal proof uploaded — pending confirmation (${points}).${agentLine} You have a short window to raise a dispute.`
        break
      case 'paid':
        content = `Withdrawal settled: ${points} (${withdrawal.hostPayoutUsd ?? '0'} USD).${agentLine}`
        break
      case 'failed':
        content = `Withdrawal failed or reversed: ${points}.${agentLine}${reasonLine}`
        break
      default:
        content = `Withdrawal update (${params.event}): ${points}.${agentLine}`
    }

    const metadata: PlatformMessageMetadata = {
      category: 'transactional',
      walletCurrency: 'POINT',
      withdrawalId: params.withdrawalId,
      withdrawalEvent: params.event,
      withdrawalStatus: withdrawal.status,
      amount: withdrawal.amountPoints.toString(),
      agent,
    }

    const clientMessageId = `txn:withdrawal:${params.withdrawalId}:${params.event}`

    try {
      const sent = await platformMessagingService.sendPlatformMessage({
        targetUserId: params.hostUserId,
        type: 'TRANSACTIONAL',
        content,
        metadata,
        clientMessageId,
      })
      // Push when agency uploads proof (WAITING) — host can review for waitingHours.
      // Final PAID settlement is inbox-only (agency already credited after the window).
      if (sent.created && params.event === 'waiting') {
        await pushTransactionalNotification({
          userId: params.hostUserId,
          title: 'Withdrawal proof uploaded',
          body: content,
          conversationId: sent.conversationId || undefined,
          messageId: sent.messageId || undefined,
          metadata,
        })
      }
    } catch (err) {
      log.warn({ err, withdrawalId: params.withdrawalId }, 'withdrawal platform message failed')
    }
  },
}
