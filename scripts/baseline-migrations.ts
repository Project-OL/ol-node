/**
 * One-time fix for Neon DB baselined via 20260625104905_init:
 * - Clears failed 20250307000000_auth_production_schema migration
 * - Marks all repo migrations as applied (no SQL re-run; no data loss)
 * - Seeds public_id_classification_progress row if empty
 *
 * Usage: npx tsx scripts/baseline-migrations.ts
 */
import { execSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { prisma } from '../src/config/database'

const migrationsDir = join(process.cwd(), 'prisma', 'migrations')

function listMigrationNames(): string[] {
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
}

async function appliedMigrationNames(): Promise<Set<string>> {
  const rows = await prisma.$queryRawUnsafe<Array<{ migration_name: string }>>(
    `SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL`,
  )
  return new Set(rows.map((r) => r.migration_name))
}

async function runResolve(args: string, retries = 5) {
  console.log(`> prisma migrate resolve ${args}`)
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      execSync(`npx prisma migrate resolve ${args}`, { stdio: 'inherit', cwd: process.cwd() })
      return
    } catch (err) {
      if (attempt === retries) throw err
      const waitMs = attempt * 2000
      console.warn(`resolve failed (attempt ${attempt}/${retries}), retrying in ${waitMs}ms...`)
      await sleep(waitMs)
    }
  }
}

async function seedClassificationProgressIfMissing() {
  const rows = await prisma.$queryRawUnsafe<Array<{ id: number }>>(
    'SELECT id FROM public_id_classification_progress WHERE id = 1',
  )
  if (rows.length > 0) {
    console.log('public_id_classification_progress row already present')
    return
  }

  await prisma.$executeRawUnsafe(`
    INSERT INTO public_id_classification_progress (id, last_classified_id, updated_at)
    VALUES (
      1,
      (SELECT GREATEST(34216663::bigint, COALESCE(MAX(public_id), 0)) FROM users),
      CURRENT_TIMESTAMP
    )
    ON CONFLICT (id) DO NOTHING
  `)
  console.log('Seeded public_id_classification_progress id=1')
}

async function main() {
  const failed = '20250307000000_auth_production_schema'
  const applied = await appliedMigrationNames()

  if (!applied.has(failed)) {
    const failedRows = await prisma.$queryRawUnsafe<Array<{ finished_at: Date | null }>>(
      `SELECT finished_at FROM _prisma_migrations WHERE migration_name = '${failed}'`,
    )
    if (failedRows.some((r) => r.finished_at === null)) {
      await runResolve(`--rolled-back "${failed}"`)
    }
  }

  for (const name of listMigrationNames()) {
    if (applied.has(name)) {
      console.log(`skip (already applied): ${name}`)
      continue
    }
    await runResolve(`--applied "${name}"`)
    applied.add(name)
  }

  await seedClassificationProgressIfMissing()

  console.log('\nDone. Verify with: npx prisma migrate status')
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
