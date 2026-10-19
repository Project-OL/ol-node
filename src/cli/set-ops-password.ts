/**
 * INF-23: set (or replace) a SUPER_ADMIN's ops password for capacity changes. Run ON THE VM only:
 *
 *   cd /opt/ol/apps/ol-node-rest && sudo -u olapp bash -c 'set -a; . ./.env; set +a; \
 *     node dist/cli/set-ops-password.js admin@example.com'      # then type the password + Enter
 *
 * The password is read from stdin (never an argument, so it stays out of shell history and `ps`),
 * must be at least 16 characters, and must differ from the admin's login password.
 */
import bcrypt from 'bcrypt'
import { prisma } from '../config/database'

async function readStdinLine(): Promise<string> {
  process.stdout.write('Ops password (min 16 chars): ')
  return new Promise((resolve) => {
    let buf = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk: string) => {
      buf += chunk
      const nl = buf.indexOf('\n')
      if (nl >= 0) {
        process.stdin.pause()
        resolve(buf.slice(0, nl).replace(/\r$/, ''))
      }
    })
  })
}

async function main() {
  const email = (process.argv[2] ?? '').trim().toLowerCase()
  if (!email) throw new Error('usage: set-ops-password.js <super-admin-email>')
  const admin = await prisma.systemAdmin.findUnique({ where: { email } })
  if (!admin) throw new Error(`no admin with email ${email}`)
  if (admin.role !== 'SUPER_ADMIN') throw new Error(`${email} is ${admin.role}, not SUPER_ADMIN`)
  const password = await readStdinLine()
  if (password.length < 16) throw new Error('ops password must be at least 16 characters')
  if (await bcrypt.compare(password, admin.passwordHash)) {
    throw new Error('ops password must differ from the login password')
  }
  const passwordHash = await bcrypt.hash(password, 12)
  await prisma.adminOpsCredential.upsert({
    where: { adminId: admin.id },
    create: { adminId: admin.id, passwordHash },
    update: { passwordHash },
  })
  console.log(`ops password set for ${email}`)
}

main()
  .then(() => prisma.$disconnect().then(() => process.exit(0)))
  .catch(async (err) => {
    console.error(`error: ${(err as Error).message}`)
    await prisma.$disconnect()
    process.exit(1)
  })
