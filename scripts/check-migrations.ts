import { prisma } from '../src/config/database'

async function main() {
  const rows = await prisma.$queryRawUnsafe<
    Array<{
      migration_name: string
      finished_at: Date | null
      rolled_back_at: Date | null
      started_at: Date
    }>
  >(
    'SELECT migration_name, finished_at, rolled_back_at, started_at FROM "_prisma_migrations" ORDER BY started_at',
  )
  console.log(JSON.stringify(rows, null, 2))

  const table = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(
    `SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'public_id_classification_progress'
    ) AS exists`,
  )
  console.log('public_id_classification_progress exists:', table[0]?.exists)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
