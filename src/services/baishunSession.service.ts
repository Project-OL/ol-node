import crypto from 'crypto'
import { CoinTxType, GameSessionStatus, WalletCurrencyType, type Prisma } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'
import { AppError } from '../middlewares/errorHandler'
import { walletRepository } from '../repositories/wallet.repository'
import { diamondWalletService } from './diamond-wallet.service'
import { ledgerAccountRoleService } from './ledgerAccountRole.service'
import { lockWalletsInOrder } from '../utils/wallet-lock-order'
import { isUniqueViolation, withSerializationRetry } from '../utils/txRetry'
import { buildUserDisplayName } from '../utils/user-display'

const SS_TOKEN_TTL_MS = 24 * 60 * 60 * 1000
const TX_TIMEOUT_MS = 20_000

type BaishunDiffMsg = 'bet' | 'result' | 'refund'

function newSsToken(): string {
  return crypto.randomBytes(32).toString('base64url')
}

async function loadUserBasics(userId: string) {
  const user = await prismaRead.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true, firstName: true, lastName: true, avatarUrl: true },
  })
  if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
  return user
}

async function requireActiveSession(ssToken: string) {
  const session = await prisma.gameSession.findUnique({ where: { ssToken } })
  if (!session) throw new AppError(401, 'Session not found', 'GAME_SESSION_NOT_FOUND')
  if (!session.ssTokenExpiresAt || session.ssTokenExpiresAt < new Date()) {
    throw new AppError(401, 'Session expired', 'GAME_SESSION_EXPIRED')
  }
  return session
}

/** diff_msg → the paired user/house DIAMOND ledger tx types (§1 of the plan). Direction is
 * fixed per diff_msg, not re-derived from currency_diff's sign, so the two never disagree. */
function resolveSettlement(diffMsg: BaishunDiffMsg, currencyDiff: bigint) {
  const amount = currencyDiff < 0n ? -currencyDiff : currencyDiff
  switch (diffMsg) {
    case 'bet':
      return {
        userIsDebit: true,
        userTxType: CoinTxType.GAME_WAGER_OUT,
        houseTxType: CoinTxType.GAME_WAGER_IN,
        amount,
      }
    case 'result':
      return {
        userIsDebit: false,
        userTxType: CoinTxType.GAME_RESULT_IN,
        houseTxType: CoinTxType.GAME_RESULT_OUT,
        amount,
      }
    case 'refund':
      return {
        userIsDebit: false,
        userTxType: CoinTxType.GAME_REFUND_IN,
        houseTxType: CoinTxType.GAME_REFUND_OUT,
        amount,
      }
    default: {
      const exhaustive: never = diffMsg
      throw new AppError(400, `Unknown diff_msg: ${String(exhaustive)}`, 'INVALID_REQUEST')
    }
  }
}

/**
 * BAISHUN merchant-server session lifecycle + `change_balance` settlement (§3 of their
 * integration doc). Called only from `src/routes/v1/game-webhooks.routes.ts`, behind
 * `verifyBaishunSignature`.
 */
export const baishunSessionService = {
  async getSsToken(params: { userId: string; code: string }) {
    const claimed = await prisma.gameSession.updateMany({
      where: { code: params.code, codeUsedAt: null },
      data: { codeUsedAt: new Date(), status: GameSessionStatus.ACTIVE },
    })
    if (claimed.count !== 1) {
      throw new AppError(401, 'Launch code already used or invalid', 'GAME_LAUNCH_CODE_INVALID')
    }
    const session = await prisma.gameSession.findUnique({ where: { code: params.code } })
    if (!session || session.userId !== params.userId) {
      throw new AppError(401, 'Launch code does not match user', 'GAME_LAUNCH_CODE_INVALID')
    }

    const ssToken = newSsToken()
    const expiresAt = new Date(Date.now() + SS_TOKEN_TTL_MS)
    await prisma.gameSession.update({
      where: { id: session.id },
      data: { ssToken, ssTokenExpiresAt: expiresAt },
    })

    const [user, balance] = await Promise.all([
      loadUserBasics(session.userId),
      diamondWalletService.getBalance(session.userId),
    ])

    return {
      ssToken,
      expireDateMs: expiresAt.getTime(),
      userInfo: {
        userId: session.userId,
        userName: buildUserDisplayName(user),
        userAvatar: user.avatarUrl ?? '',
        balance: Number(balance),
      },
    }
  },

  async getUserInfo(params: { ssToken: string }) {
    const session = await requireActiveSession(params.ssToken)
    const [user, balance] = await Promise.all([
      loadUserBasics(session.userId),
      diamondWalletService.getBalance(session.userId),
    ])
    return {
      userId: session.userId,
      userName: buildUserDisplayName(user),
      userAvatar: user.avatarUrl ?? '',
      balance: Number(balance),
    }
  },

  async updateSsToken(params: { ssToken: string }) {
    const session = await requireActiveSession(params.ssToken)
    const ssToken = newSsToken()
    const expiresAt = new Date(Date.now() + SS_TOKEN_TTL_MS)
    await prisma.gameSession.update({
      where: { id: session.id },
      data: { ssToken, ssTokenExpiresAt: expiresAt },
    })
    return { ssToken, expireDateMs: expiresAt.getTime() }
  },

  async changeBalance(params: {
    ssToken: string
    currencyDiff: bigint
    diffMsg: BaishunDiffMsg
    gameId: number
    roomId?: string
    orderId: string
  }): Promise<{ currencyBalance: bigint }> {
    if (params.currencyDiff === 0n) {
      throw new AppError(400, 'currency_diff must not be zero', 'INVALID_REQUEST')
    }
    const session = await requireActiveSession(params.ssToken)
    const houseUserId = await ledgerAccountRoleService.requireGameHouseUserId()
    const { userIsDebit, userTxType, houseTxType, amount } = resolveSettlement(
      params.diffMsg,
      params.currencyDiff,
    )

    const findLink = (db: Prisma.TransactionClient | typeof prisma) =>
      db.gameRoundLedgerLink.findUnique({
        where: { providerId_orderId: { providerId: session.providerId, orderId: params.orderId } },
      })

    const existing = await findLink(prisma)
    if (existing) {
      const balance = await diamondWalletService.getBalance(session.userId)
      return { currencyBalance: balance }
    }

    const runSettlement = () =>
      prisma.$transaction(
        async (tx) => {
          const dup = await findLink(tx)
          if (dup) return dup

          const userWallet = await walletRepository.getOrCreate(
            session.userId,
            WalletCurrencyType.DIAMOND,
            tx,
          )
          const houseWallet = await walletRepository.getOrCreate(
            houseUserId,
            WalletCurrencyType.DIAMOND,
            tx,
          )
          await lockWalletsInOrder(tx, [userWallet, houseWallet])

          const linkKey = `game-round:${session.providerId}:${params.orderId}`
          const description = `Game ${params.diffMsg} (order ${params.orderId})`

          const userLeg = userIsDebit
            ? await diamondWalletService.debit(session.userId, amount, userTxType, tx, {
                idempotencyKey: `${linkKey}:user`,
                description,
              })
            : await diamondWalletService.credit(session.userId, amount, userTxType, tx, {
                idempotencyKey: `${linkKey}:user`,
                description,
              })
          const houseLeg = userIsDebit
            ? await diamondWalletService.credit(houseUserId, amount, houseTxType, tx, {
                idempotencyKey: `${linkKey}:house`,
                description,
              })
            : await diamondWalletService.debit(houseUserId, amount, houseTxType, tx, {
                idempotencyKey: `${linkKey}:house`,
                description,
              })

          return tx.gameRoundLedgerLink.create({
            data: {
              providerId: session.providerId,
              orderId: params.orderId,
              gameId: params.gameId,
              roomId: params.roomId ?? null,
              diffMsg: params.diffMsg,
              userId: session.userId,
              currencyDiff: params.currencyDiff,
              userLedgerEntryId: userLeg.ledgerEntryId,
              houseLedgerEntryId: houseLeg.ledgerEntryId,
            },
          })
        },
        { timeout: TX_TIMEOUT_MS },
      )

    try {
      await withSerializationRetry(runSettlement)
    } catch (err) {
      // Parallel settlement retry: the winner committed between our existence check and
      // insert. Fall through — the balance read below reflects the winner's result either way.
      if (!isUniqueViolation(err)) throw err
    }

    await diamondWalletService.bustBalanceCache(session.userId)
    await diamondWalletService.bustBalanceCache(houseUserId)
    const balance = await diamondWalletService.getBalance(session.userId)
    return { currencyBalance: balance }
  },
}
