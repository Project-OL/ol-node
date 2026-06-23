import { env } from '../config/env'
import { systemAdminService } from '../services/systemAdmin.service'

async function main() {
  const email = env.ADMIN_INITIAL_EMAIL
  const password = env.ADMIN_INITIAL_PASSWORD

  if (!email || !password) {
    console.error('Set ADMIN_INITIAL_EMAIL and ADMIN_INITIAL_PASSWORD env vars before seeding.')
    process.exit(1)
  }

  const admin = await systemAdminService.createAdmin({
    email,
    password,
    displayName: 'Super Admin',
    role: 'SUPER_ADMIN',
  })

  console.log('✅ Super admin created:', admin.id, admin.email)
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
