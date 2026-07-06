/**
 * Idempotent social/wallet list-data seed for lab-user-1 (N+1 / fan-out probing):
 *  - 25 companion users (lab-social-1..25@test.local)
 *  - lab-user-1 follows all 25; first 15 follow back (friends)
 *  - all 25 recorded as visitors of lab-user-1; lab-user-1 visited all 25
 *  - 24 POINT ledger CREDIT entries with counterparties (history/summary data)
 * Usage: npx tsx lab/fixtures/phase1-social-seed.ts
 */
import { prisma } from '../../src/config/database'

const LAB_EMAIL = process.env.LAB_EMAIL || 'lab-user-1@test.local'
const N = 25

async function main(): Promise<void> {
  const labAuth = await prisma.authIdentifier.findFirst({
    where: { provider: 'email', identifier: LAB_EMAIL },
  })
  if (!labAuth) throw new Error('lab-user-1 not found; run npm run lab:seed first')
  const labUserId = labAuth.userId

  const companions: string[] = []
  for (let i = 1; i <= N; i++) {
    const email = `lab-social-${i}@test.local`
    const existing = await prisma.authIdentifier.findFirst({
      where: { provider: 'email', identifier: email },
    })
    if (existing) {
      companions.push(existing.userId)
      continue
    }
    const publicId = BigInt(900000 + i)
    const u = await prisma.user.create({
      data: {
        username: `lab_social_${i}`,
        firstName: `Social${i}`,
        lastName: 'Lab',
        publicId,
        defaultPublicId: publicId,
        status: 'active',
        passwordSet: false,
        country: 'NP',
        gender: i % 2 === 0 ? 'female' : 'male',
      },
    })
    await prisma.authIdentifier.create({
      data: {
        userId: u.id,
        provider: 'email',
        identifier: email,
        isVerified: true,
        verifiedAt: new Date(),
        isPrimary: true,
      },
    })
    companions.push(u.id)
  }

  for (let i = 0; i < companions.length; i++) {
    const cid = companions[i]!
    await prisma.userFollow.upsert({
      where: { followerId_followingId: { followerId: labUserId, followingId: cid } },
      create: { followerId: labUserId, followingId: cid },
      update: {},
    })
    if (i < 15) {
      await prisma.userFollow.upsert({
        where: { followerId_followingId: { followerId: cid, followingId: labUserId } },
        create: { followerId: cid, followingId: labUserId },
        update: {},
      })
    }
  }

  const base = Date.now() - 3600_000
  for (let i = 0; i < companions.length; i++) {
    const cid = companions[i]!
    await prisma.profileVisitor.upsert({
      where: { profileId_visitorId: { profileId: labUserId, visitorId: cid } },
      create: { profileId: labUserId, visitorId: cid, visitedAt: new Date(base + i * 60_000) },
      update: {},
    })
    await prisma.profileVisitor.upsert({
      where: { profileId_visitorId: { profileId: cid, visitorId: labUserId } },
      create: { profileId: cid, visitorId: labUserId, visitedAt: new Date(base + i * 60_000) },
      update: {},
    })
  }

  const wallet = await prisma.wallet.upsert({
    where: { userId_currencyType: { userId: labUserId, currencyType: 'POINT' } },
    create: { userId: labUserId, currencyType: 'POINT' },
    update: {},
  })
  const existingSeeded = await prisma.pointLedgerEntry.count({
    where: { walletId: wallet.id, idempotencyKey: { startsWith: 'lab-phase1-' } },
  })
  if (existingSeeded === 0) {
    const last = await prisma.pointLedgerEntry.findFirst({
      where: { walletId: wallet.id },
      orderBy: { createdAt: 'desc' },
    })
    let balance = last?.balanceAfter ?? 0n
    const txTypes = ['GIFT_RECEIVE', 'VIDEO_CALL', 'SUBSCRIPTION', 'PLATFORM_REWARD'] as const
    for (let i = 0; i < 24; i++) {
      const amount = 10_000n + BigInt(i) * 1_000n
      balance += amount
      await prisma.pointLedgerEntry.create({
        data: {
          walletId: wallet.id,
          direction: 'CREDIT',
          txType: txTypes[i % txTypes.length]!,
          amount,
          balanceAfter: balance,
          counterpartyId: companions[i % companions.length]!,
          description: `lab phase1 seed ${i}`,
          idempotencyKey: `lab-phase1-${i}`,
          createdAt: new Date(base + i * 30_000),
        },
      })
    }
    await prisma.wallet.update({
      where: { id: wallet.id },
      data: { version: { increment: 1n } },
    })
  }

  console.log(
    `[phase1-social-seed] ${companions.length} companions; follows/visits upserted; ledger seeded=${existingSeeded === 0}`,
  )
  await prisma.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
