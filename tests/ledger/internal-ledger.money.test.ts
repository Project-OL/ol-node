/**
 * BE-20: the internal ledger (src/services/internalLedger.service.ts) under concurrency, against a
 * real throwaway Postgres (tests/ledger/env.setup.ts). The cases mirror Live-server's
 * tests/money/money.test.js, where LIVE-24/25/56 reproduce on Live-server's own money code.
 */
import { randomBytes, randomUUID } from 'crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { prisma } from '../../src/config/database'
import { redisClient } from '../../src/config/redis'
import { internalLedgerService } from '../../src/services/internalLedger.service'
import { buildInternalApp } from '../../src/internal/internal-app'
import { signInternalRequest } from '../../src/internal/hmac'

const N = 20
const rid = () => randomBytes(6).toString('hex')
const randPublicId = () => BigInt(10_000_000 + Math.floor(Math.random() * 89_999_999))

afterAll(async () => {
  await prisma.$disconnect()
  redisClient.disconnect()
})

async function makeUser(opts: { coins?: bigint; agencyUserId?: string } = {}) {
  const publicId = randPublicId()
  const user = await prisma.user.create({
    data: {
      username: `u_${rid()}`,
      publicId,
      defaultPublicId: publicId,
      ...(opts.agencyUserId ? { currentAgencyId: opts.agencyUserId } : {}),
    },
  })
  if (opts.coins && opts.coins > 0n) {
    const wallet = await prisma.wallet.create({ data: { userId: user.id, currencyType: 'COIN' } })
    await prisma.coinLedgerEntry.create({
      data: {
        walletId: wallet.id,
        direction: 'CREDIT',
        txType: 'TOPUP',
        amount: opts.coins,
        balanceAfter: opts.coins,
        idempotencyKey: `seed-${rid()}`,
      },
    })
  }
  return user
}

async function makeAgency(level = 'A', rateBp = 1600, opts: { paused?: boolean } = {}) {
  await prisma.agencyCommissionLevel.upsert({
    where: { level },
    create: { level, minWindowPoints: 0n, liveRateBp: rateBp, matchChatRateBp: rateBp, sortOrder: 1 },
    update: { liveRateBp: rateBp, matchChatRateBp: rateBp },
  })
  const owner = await makeUser()
  await prisma.agency.create({
    data: {
      userId: owner.id,
      defaultPublicId: owner.publicId,
      displayName: `agency_${rid()}`,
      currentLevel: level,
      ...(opts.paused ? { pausedAt: new Date() } : {}),
    },
  })
  return owner
}

async function makeGift(coinCost = 100, opts: { isLucky?: boolean } = {}) {
  return prisma.gift.create({
    data: {
      name: `gift_${rid()}`,
      coinCost,
      displayImageUrl: 'https://example.invalid/g.png',
      code: `g_${rid()}`,
      isActive: true,
      isLucky: opts.isLucky ?? false,
    },
  })
}

async function makeCall(callerId: string, creatorId: string, status = 'ACTIVE', pricePerMin = 600) {
  return prisma.videoCallSession.create({
    data: {
      callerId,
      creatorId,
      livekitRoom: `room_${rid()}`,
      pricePerMin,
      status,
      ...(status === 'ACTIVE' ? { minsCharged: 1 } : {}),
    },
  })
}

async function walletIdOf(userId: string, currencyType: 'COIN' | 'POINT') {
  const w = await prisma.wallet.findUnique({
    where: { userId_currencyType: { userId, currencyType } },
  })
  return w?.id ?? null
}

/** Same invariants as the 2026-10-14 prod check and Live-server's ledgerProblems. */
async function ledgerProblems(walletIds: Array<string | null>): Promise<string[]> {
  const ids = walletIds.filter((x): x is string => Boolean(x))
  const problems: string[] = []
  for (const table of ['coin_ledger_entries', 'point_ledger_entries']) {
    const breaks = await prisma.$queryRawUnsafe<{ wallet_id: string; n: number }[]>(
      `WITH l AS (
         SELECT wallet_id, direction::text AS d, amount, balance_after,
                LAG(balance_after) OVER (PARTITION BY wallet_id ORDER BY created_at, id) AS prev
         FROM ${table} WHERE wallet_id = ANY($1::uuid[]))
       SELECT wallet_id::text, count(*)::int AS n FROM l
       WHERE prev IS NOT NULL AND balance_after <> prev + CASE WHEN d = 'CREDIT' THEN amount ELSE -amount END
       GROUP BY wallet_id`,
      ids,
    )
    for (const b of breaks) problems.push(`${table} ${b.wallet_id}: ${b.n} chain break(s)`)
    const sums = await prisma.$queryRawUnsafe<
      { wallet_id: string; ledger_sum: string; latest: string }[]
    >(
      `SELECT wallet_id::text,
              (sum(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END))::text AS ledger_sum,
              (array_agg(balance_after ORDER BY created_at DESC, id DESC))[1]::text AS latest
       FROM ${table} WHERE wallet_id = ANY($1::uuid[]) GROUP BY wallet_id`,
      ids,
    )
    for (const s of sums) {
      if (s.ledger_sum !== s.latest) problems.push(`${table} ${s.wallet_id}: ${s.latest} vs sum ${s.ledger_sum}`)
    }
  }
  return problems
}

function liveGift(senderId: string, receiverId: string, giftId: string, quantity = 1) {
  const giftTransactionId = randomUUID()
  return internalLedgerService.giftSend({
    requestId: randomUUID(),
    context: 'live_stream',
    senderId,
    receiverId,
    giftId,
    quantity,
    giftTransactionId,
    idemBase: `gift-stream:${giftTransactionId}`,
  })
}

const settled = <T>(ps: Promise<T>[]) => Promise.allSettled(ps)
const rejectedCodes = (rs: PromiseSettledResult<unknown>[]) =>
  rs
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => `${(r.reason as { code?: string })?.code ?? ''} ${(r.reason as Error)?.message}`)

describe('internal ledger: gifts', () => {
  it('concurrent live gifts from one sender keep sender and host ledgers consistent', async () => {
    const sender = await makeUser({ coins: 1_000_000n })
    const host = await makeUser()
    const gift = await makeGift(100)

    const rs = await settled(Array.from({ length: N }, () => liveGift(sender.id, host.id, gift.id)))
    expect(rejectedCodes(rs)).toEqual([])
    expect(await ledgerProblems([await walletIdOf(sender.id, 'COIN'), await walletIdOf(host.id, 'POINT')])).toEqual([])
    const latest = await prisma.coinLedgerEntry.findFirst({
      where: { walletId: (await walletIdOf(sender.id, 'COIN'))! },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    })
    expect(latest!.balanceAfter).toBe(1_000_000n - BigInt(N * 100))
  })

  it('cannot overspend: only the affordable gifts succeed, with 402 INSUFFICIENT_COINS', async () => {
    const sender = await makeUser({ coins: 1_000n })
    const host = await makeUser()
    const gift = await makeGift(100)

    const rs = await settled(Array.from({ length: N }, () => liveGift(sender.id, host.id, gift.id)))
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(10)
    expect(new Set(rejectedCodes(rs).map((c) => c.split(' ')[0]))).toEqual(new Set(['INSUFFICIENT_COINS']))
  })

  it('LIVE-56: parallel first gifts to a brand-new host (no wallet yet) all succeed', async () => {
    const sender = await makeUser({ coins: 1_000_000n })
    const newHost = await makeUser()
    const gift = await makeGift(100)

    const rs = await settled(Array.from({ length: N }, () => liveGift(sender.id, newHost.id, gift.id)))
    expect(rejectedCodes(rs)).toEqual([])
    expect(await ledgerProblems([await walletIdOf(newHost.id, 'POINT')])).toEqual([])
  })

  it('LIVE-24: two hosts of one agency earning at once keep the agency wallet consistent', async () => {
    const agency = await makeAgency('A', 1600)
    const [h1, h2] = [await makeUser({ agencyUserId: agency.id }), await makeUser({ agencyUserId: agency.id })]
    const [s1, s2] = [await makeUser({ coins: 1_000_000n }), await makeUser({ coins: 1_000_000n })]
    const gift = await makeGift(100)

    const ops: Promise<unknown>[] = []
    for (let i = 0; i < N; i++) {
      ops.push(liveGift(s1.id, h1.id, gift.id))
      ops.push(liveGift(s2.id, h2.id, gift.id))
    }
    const rs = await settled(ops)
    expect(rejectedCodes(rs)).toEqual([])
    const aw = await walletIdOf(agency.id, 'POINT')
    expect(await ledgerProblems([aw])).toEqual([])
    const commissions = await prisma.pointLedgerEntry.count({
      where: { walletId: aw!, txType: 'AGENT_COMMISSION' },
    })
    expect(commissions).toBe(2 * N)
  })

  it('agency commission uses the key admin reversal looks up, and a paused agency is not paid', async () => {
    const agency = await makeAgency('A', 1600)
    const host = await makeUser({ agencyUserId: agency.id })
    const sender = await makeUser({ coins: 10_000n })
    const gift = await makeGift(1_000)
    await liveGift(sender.id, host.id, gift.id)
    const hostRow = await prisma.pointLedgerEntry.findFirstOrThrow({
      where: { walletId: (await walletIdOf(host.id, 'POINT'))!, txType: 'GIFT_RECEIVE' },
    })
    const commission = await prisma.pointLedgerEntry.findUnique({
      where: { idempotencyKey: `agency-commission:${hostRow.id}` },
    })
    expect(commission?.amount).toBe(96n) // 16% of 600 host points

    const paused = await makeAgency('A', 1600, { paused: true })
    const pausedHost = await makeUser({ agencyUserId: paused.id })
    await liveGift(sender.id, pausedHost.id, gift.id)
    expect(await walletIdOf(paused.id, 'POINT')).not.toBeNull() // locked, so created
    expect(
      await prisma.pointLedgerEntry.count({
        where: { walletId: (await walletIdOf(paused.id, 'POINT'))!, txType: 'AGENT_COMMISSION' },
      }),
    ).toBe(0)
  })

  it('a retry with the same requestId replays; a new request on the same key is a duplicate', async () => {
    const sender = await makeUser({ coins: 10_000n })
    const host = await makeUser()
    const gift = await makeGift(100)
    const giftTransactionId = randomUUID()
    const input = {
      requestId: randomUUID(),
      context: 'live_stream' as const,
      senderId: sender.id,
      receiverId: host.id,
      giftId: gift.id,
      quantity: 2,
      giftTransactionId,
      idemBase: `gift-stream:${sender.id}:client-tx-1`,
    }
    const first = await internalLedgerService.giftSend(input)
    const again = await internalLedgerService.giftSend(input)
    expect(again.replayed).toBe(true)
    expect(again.balanceAfterCoins).toBe(first.balanceAfterCoins)
    expect(again.balanceAfterPoints).toBe(first.balanceAfterPoints)
    expect(await prisma.coinLedgerEntry.count({ where: { refId: giftTransactionId } })).toBe(1)

    await expect(
      internalLedgerService.giftSend({ ...input, requestId: randomUUID(), giftTransactionId: randomUUID() }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'DUPLICATE_LEDGER_KEY' })
  })

  it('video-call gift needs an ACTIVE call between the two users', async () => {
    const caller = await makeUser({ coins: 10_000n })
    const host = await makeUser()
    const other = await makeUser()
    const gift = await makeGift(100)
    const call = await makeCall(caller.id, host.id)
    const send = (receiverId: string) => {
      const giftTransactionId = randomUUID()
      return internalLedgerService.giftSend({
        requestId: randomUUID(),
        context: 'video_call',
        senderId: caller.id,
        receiverId,
        giftId: gift.id,
        quantity: 1,
        giftTransactionId,
        idemBase: `gift:${giftTransactionId}`,
        sessionId: call.id,
      })
    }
    const ok = await send(host.id)
    expect(ok.pointsAwarded).toBe('60')
    await expect(send(other.id)).rejects.toMatchObject({ statusCode: 403 })
  })
})

describe('internal ledger: lucky gifts', () => {
  const lucky = (senderId: string, receiverId: string, giftId: string, count: number, reward: bigint) => {
    const giftTransactionId = randomUUID()
    return internalLedgerService.luckyGiftSend({
      requestId: randomUUID(),
      senderId,
      receiverId,
      giftId,
      count,
      giftTransactionId,
      txKeyBase: `lucky:${giftTransactionId}`,
      rewardCoins: reward.toString(),
      category: 'TEST',
    })
  }

  it('single: host 4% + equal livestream XP, wealth XP = cost, no agency commission', async () => {
    const agency = await makeAgency('A', 1600)
    const host = await makeUser({ agencyUserId: agency.id })
    const sender = await makeUser({ coins: 1_000_000n })
    const gift = await makeGift(1_000, { isLucky: true })

    const r = await lucky(sender.id, host.id, gift.id, 1, 500n)
    expect(r.hostPoints).toBe('40')
    expect(r.finalBalanceCoins).toBe(String(1_000_000 - 1_000 + 500))
    const level = (userId: string, levelType: 'LIVESTREAM' | 'WEALTH') =>
      prisma.walletUserLevel.findUnique({ where: { userId_levelType: { userId, levelType } } })
    expect((await level(host.id, 'LIVESTREAM'))?.cumulativeTotal).toBe(40n)
    expect((await level(sender.id, 'WEALTH'))?.cumulativeTotal).toBe(1_000n)
    expect(
      await prisma.pointLedgerEntry.count({ where: { refId: r.transactionId, txType: 'AGENT_COMMISSION' } }),
    ).toBe(0)
  })

  it('combo: agency commission at the live rate on the host points', async () => {
    const agency = await makeAgency('A', 1600)
    const host = await makeUser({ agencyUserId: agency.id })
    const sender = await makeUser({ coins: 1_000_000n })
    const gift = await makeGift(1_000, { isLucky: true })

    const r = await lucky(sender.id, host.id, gift.id, 5, 0n)
    expect(r.hostPoints).toBe('200')
    const commission = await prisma.pointLedgerEntry.findFirst({
      where: { refId: r.transactionId, txType: 'AGENT_COMMISSION' },
    })
    expect(commission?.amount).toBe(32n)
  })

  it('LIVE-31: parallel lucky gifts add exactly to the reserve-pool counters, in the gift transaction', async () => {
    const pool = async () => {
      const [r] = await prisma.$queryRaw<{ spent: bigint; rewarded: bigint }[]>`
        SELECT COALESCE(SUM(total_spent),0)::bigint AS spent, COALESCE(SUM(total_rewarded),0)::bigint AS rewarded
        FROM lucky_reserve_pool`
      return r
    }
    const host = await makeUser()
    const sender = await makeUser({ coins: 10_000_000n })
    const gift = await makeGift(1_000, { isLucky: true })
    const before = await pool()
    const rs = await settled(Array.from({ length: N }, () => lucky(sender.id, host.id, gift.id, 1, 300n)))
    expect(rejectedCodes(rs)).toEqual([])
    const after = await pool()
    expect(after.spent - before.spent).toBe(BigInt(N * 1_000))
    expect(after.rewarded - before.rewarded).toBe(BigInt(N * 300))

    // A failed gift (insufficient coins) must not move the counters.
    const poor = await makeUser({ coins: 10n })
    await expect(lucky(poor.id, host.id, gift.id, 1, 0n)).rejects.toMatchObject({ code: 'INSUFFICIENT_COINS' })
    expect((await pool()).spent).toBe(after.spent)
  })

  it('rejects a reward above the engine maximum', async () => {
    const host = await makeUser()
    const sender = await makeUser({ coins: 1_000_000n })
    const gift = await makeGift(1_000, { isLucky: true })
    await expect(lucky(sender.id, host.id, gift.id, 1, 10_001n)).rejects.toMatchObject({
      code: 'INVALID_LUCKY_REWARD',
    })
  })
})

describe('internal ledger: video calls', () => {
  it('LIVE-25: accept commits minute 1 and its agency commission together', async () => {
    const agency = await makeAgency('A', 1600)
    const host = await makeUser({ agencyUserId: agency.id })
    const caller = await makeUser({ coins: 1_000_000n })
    const session = await makeCall(caller.id, host.id, 'RINGING')

    const r = await internalLedgerService.callAccept({
      requestId: randomUUID(),
      sessionId: session.id,
      receiverId: host.id,
    })
    expect(r.session.status).toBe('ACTIVE')
    expect(r.coinRate).toBe('1000') // ceil(600 * 10000 / 6000)
    const hostLedger = await prisma.pointLedgerEntry.findUniqueOrThrow({
      where: { idempotencyKey: `call-${session.id}-min-1-points` },
    })
    expect(
      await prisma.pointLedgerEntry.findUnique({ where: { idempotencyKey: `agency-commission:${hostLedger.id}` } }),
    ).not.toBeNull()
  })

  it('a double accept bills once; the same request replays', async () => {
    const host = await makeUser()
    const caller = await makeUser({ coins: 1_000_000n })
    const session = await makeCall(caller.id, host.id, 'RINGING')
    const input = { requestId: randomUUID(), sessionId: session.id, receiverId: host.id }

    const rs = await settled([
      internalLedgerService.callAccept(input),
      internalLedgerService.callAccept({ ...input, requestId: randomUUID() }),
    ])
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(await prisma.coinLedgerEntry.count({ where: { refId: session.id } })).toBe(1)
  })

  it('bills a minute once, refuses an ended call, keeps the order', async () => {
    const host = await makeUser()
    const caller = await makeUser({ coins: 1_000_000n })
    const session = await makeCall(caller.id, host.id, 'ACTIVE')

    const rs = await settled(
      Array.from({ length: 5 }, () =>
        internalLedgerService.callMinute({ requestId: randomUUID(), sessionId: session.id, minute: 2 }),
      ),
    )
    expect(rejectedCodes(rs)).toEqual([])
    expect(rs.filter((r) => r.status === 'fulfilled' && !r.value.alreadyBilled)).toHaveLength(1)
    expect((await prisma.videoCallSession.findUniqueOrThrow({ where: { id: session.id } })).minsCharged).toBe(2)

    await expect(
      internalLedgerService.callMinute({ requestId: randomUUID(), sessionId: session.id, minute: 4 }),
    ).rejects.toMatchObject({ code: 'MINUTE_OUT_OF_ORDER' })

    await prisma.videoCallSession.update({ where: { id: session.id }, data: { status: 'ENDED' } })
    await expect(
      internalLedgerService.callMinute({ requestId: randomUUID(), sessionId: session.id, minute: 3 }),
    ).rejects.toMatchObject({ code: 'CALL_NOT_ACTIVE' })
  })

  it('a minute the caller cannot afford is 402 and writes nothing', async () => {
    const host = await makeUser()
    const caller = await makeUser({ coins: 999n })
    const session = await makeCall(caller.id, host.id, 'ACTIVE')
    await expect(
      internalLedgerService.callMinute({ requestId: randomUUID(), sessionId: session.id, minute: 2 }),
    ).rejects.toMatchObject({ statusCode: 402, code: 'INSUFFICIENT_COINS' })
    expect(await prisma.coinLedgerEntry.count({ where: { refId: session.id } })).toBe(0)
  })
})

describe('internal ledger: global message', () => {
  it('charges 10,000 coins and adds wealth XP', async () => {
    const sender = await makeUser({ coins: 25_000n })
    const messageTxId = randomUUID()
    const r = await internalLedgerService.globalMessage({
      requestId: randomUUID(),
      senderId: sender.id,
      messageTxId,
      idemKey: `global-msg:${messageTxId}`,
      message: 'hello everyone',
    })
    expect(r.balanceAfterCoins).toBe('15000')
  })
})

describe('internal API (HTTP)', () => {
  const secret = process.env.INTERNAL_LEDGER_HMAC_SECRET!

  it('rejects unsigned, badly signed and stale requests; accepts a signed one', async () => {
    const app = await buildInternalApp(secret)
    const sender = await makeUser({ coins: 25_000n })
    const messageTxId = randomUUID()
    const body = JSON.stringify({
      requestId: randomUUID(),
      senderId: sender.id,
      messageTxId,
      idemKey: `global-msg:${messageTxId}`,
      message: 'signed',
    })
    const path = '/internal/v1/ledger/global-message'
    const call = (headers: Record<string, string>) =>
      app.inject({ method: 'POST', url: path, payload: body, headers: { 'content-type': 'application/json', ...headers } })

    expect((await call({})).statusCode).toBe(401)
    const ts = String(Date.now())
    expect((await call({ 'x-ol-timestamp': ts, 'x-ol-signature': 'v1=00' })).statusCode).toBe(401)
    const old = String(Date.now() - 120_000)
    const oldSig = signInternalRequest(secret, { timestamp: old, method: 'POST', path, body })
    expect((await call({ 'x-ol-timestamp': old, 'x-ol-signature': oldSig })).statusCode).toBe(401)

    const sig = signInternalRequest(secret, { timestamp: ts, method: 'POST', path, body })
    const ok = await call({ 'x-ol-timestamp': ts, 'x-ol-signature': sig })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().balanceAfterCoins).toBe('15000')

    // No JSON body = never verified: refused before any handler.
    expect((await app.inject({ method: 'POST', url: path })).statusCode).toBe(401)
    expect(
      (await app.inject({ method: 'POST', url: path, headers: { 'content-type': 'application/json' } }))
        .statusCode,
    ).toBe(401)
    expect((await app.inject({ method: 'GET', url: '/internal/health' })).statusCode).toBe(200)
    await app.close()
  })
})
