/*
 * Give the smoke-test fixture account a known password — on the GCP copy only.
 *
 * Why this exists: the cutover restore overwrites the database with the AWS
 * dump, which carries production's password hash. Without this step the
 * authenticated tier of 05-smoke-test.sh silently downgrades to SKIP at exactly
 * the moment those checks matter most — the run would still report "safe to
 * proceed" having tested nothing but anonymous 401s.
 *
 * It hashes through the app's own compiled password service rather than calling
 * bcrypt directly, so the stored hash cannot disagree with what login verifies
 * against, and it re-reads the row and compares afterwards rather than trusting
 * the write.
 *
 * Run with cwd = the app directory (Prisma resolves its engine relative to it):
 *   cd /opt/ol/apps/ol-node-rest && PID=… NEWPW=… node reset-smoke-fixture.js
 */
const { PrismaClient } = require('@prisma/client')
const { passwordService } = require('./dist/services/password.service')

const PUBLIC_ID = process.env.PID
const NEW_PW = process.env.NEWPW

const p = new PrismaClient()
;(async () => {
  if (!PUBLIC_ID) throw new Error('set PID (the fixture account public_id)')
  if (!NEW_PW) throw new Error('set NEWPW')

  const rows = await p.$queryRaw`
    select id, username, public_id::text pid
    from users where public_id::text = ${PUBLIC_ID} limit 1`
  if (rows.length === 0) throw new Error(`no user with public_id ${PUBLIC_ID}`)
  const user = rows[0]

  console.log('fixture:', user.username, `(${user.pid})`)

  const hash = await passwordService.hash(NEW_PW)
  await p.$executeRaw`
    insert into auth_passwords (id, user_id, password_hash, previous_password_hashes,
                                last_changed_at, created_at, updated_at)
    values (gen_random_uuid(), ${user.id}::uuid, ${hash}, '{}', now(), now(), now())
    on conflict (user_id) do update
      set password_hash = ${hash}, last_changed_at = now(), updated_at = now()`
  await p.$executeRaw`update users set password_set = true where id = ${user.id}::uuid`

  const stored = await p.$queryRaw`
    select password_hash from auth_passwords where user_id = ${user.id}::uuid`
  const ok = await passwordService.compare(NEW_PW, stored[0].password_hash)
  console.log('verify :', ok ? 'PASS — password validates through the login path' : 'FAIL')

  await p.$disconnect()
  if (!ok) process.exit(1)
})().catch((e) => {
  console.error('ERR', e.message)
  process.exit(1)
})
