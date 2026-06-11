/**
 * Set login password for a user by public id.
 * Usage: npx tsx scripts/set-password-by-public-id.ts <publicId> [password]
 */
import 'dotenv/config'
import { prisma } from '../src/config/database'
import { passwordService } from '../src/services/password.service'

const DEFAULT_PASSWORD = 'ValidPass1!'

async function main() {
  const publicIdRaw = process.argv[2]?.trim()
  const password = process.argv[3] ?? DEFAULT_PASSWORD

  if (!publicIdRaw || !/^\d+$/.test(publicIdRaw)) {
    console.error('Usage: npx tsx scripts/set-password-by-public-id.ts <publicId> [password]')
    process.exit(1)
  }

  const strength = passwordService.validateStrength(password)
  if (!strength.ok) {
    console.error(`Weak password: ${strength.error}`)
    process.exit(1)
  }

  const pid = BigInt(publicIdRaw)
  const user = await prisma.user.findFirst({
    where: {
      OR: [{ publicId: pid }, { defaultPublicId: pid }, { currentVipPublicId: pid }],
    },
    select: { id: true, username: true, publicId: true, passwordSet: true },
  })

  if (!user) {
    console.error(`No user found for publicId: ${publicIdRaw}`)
    process.exit(1)
  }

  const hasPwd = await passwordService.hasPassword(user.id)
  if (hasPwd) {
    await passwordService.setPassword(user.id, password)
  } else {
    await passwordService.createPassword(user.id, password)
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordSet: true },
  })

  console.log(
    JSON.stringify(
      {
        ok: true,
        userId: user.id,
        username: user.username,
        publicId: user.publicId.toString(),
        password,
        passwordSet: true,
      },
      null,
      2,
    ),
  )
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
