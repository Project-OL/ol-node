/**
 * Dev helper: dump auth_identifiers + security identifier cache for a user.
 * Usage: npx tsx scripts/check-security-identifiers.ts <userId>
 */
import { prismaRead } from '../src/config/database'
import { redisClient, RedisKeys } from '../src/config/redis'
import { securityPasswordService } from '../src/services/security-password.service'

const userId = process.argv[2]
const clearCache = process.argv.includes('--clear-cache')
if (!userId) {
  console.error('Usage: npx tsx scripts/check-security-identifiers.ts <userId> [--clear-cache]')
  process.exit(1)
}

const OTP_ELIGIBLE = new Set(['email', 'phone'])

async function main() {
  const user = await prismaRead.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true, publicId: true, isAgent: true },
  })
  console.log('user:', user)

  const rows = await prismaRead.authIdentifier.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
  })
  console.log('\n=== auth_identifiers (all) ===')
  for (const r of rows) {
    console.log({
      id: r.id,
      provider: r.provider,
      identifier: r.identifier,
      isVerified: r.isVerified,
      isPrimary: r.isPrimary,
      otpEligible: OTP_ELIGIBLE.has(r.provider),
    })
  }

  const eligible = rows.filter((r) => OTP_ELIGIBLE.has(r.provider))
  console.log(`\nOTP-eligible count: ${eligible.length} / ${rows.length} total`)

  const secKey = RedisKeys.userSecurityIdentifiers(userId)
  const authKey = RedisKeys.userAuthIdentifiers(userId)
  const [secCached, authCached] = await Promise.all([
    redisClient.get(secKey),
    redisClient.get(authKey),
  ])
  console.log('\n=== redis user:{id}:security:identifiers ===')
  console.log(secCached ?? '(miss)')
  console.log('\n=== redis user:{id}:auth_identifiers ===')
  console.log(authCached ?? '(miss)')

  if (clearCache) {
    await redisClient.del(secKey)
    console.log('\n(cleared security identifiers cache)')
    const fresh = await securityPasswordService.getIdentifiers(userId)
    console.log('\n=== getIdentifiers() after cache clear ===')
    console.log(JSON.stringify(fresh, null, 2))
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prismaRead.$disconnect()
    redisClient.disconnect()
  })
