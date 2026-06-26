import { prisma } from '../src/config/database'

async function main() {
  const rows = await prisma.$queryRawUnsafe<
    Array<{ id: number; last_classified_id: bigint; updated_at: Date }>
  >('SELECT id, last_classified_id, updated_at FROM public_id_classification_progress')

  console.log('classification_progress rows:', rows)

  const maxPublicId = await prisma.$queryRawUnsafe<Array<{ max: bigint | null }>>(
    'SELECT MAX(public_id) AS max FROM users',
  )
  console.log('max public_id:', maxPublicId[0]?.max?.toString())
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
