// Creates the `ledger_test` database in the Live-server money-test Postgres container and pushes
// this repo's Prisma schema into it. Local throwaway container only (127.0.0.1:55432).
//   docker compose -f ../Live-server/tests/money/docker-compose.yml up -d --wait   (once)
//   npm run test:ledger:setup
import { execSync } from 'node:child_process'

const container = process.env.LEDGER_TEST_PG_CONTAINER ?? 'live-money-test-postgres-1'
const target = 'postgresql://money:money@127.0.0.1:55432/ledger_test'

const exists = execSync(
  `docker exec ${container} psql -U money -d money_test -tAc "SELECT 1 FROM pg_database WHERE datname = 'ledger_test'"`,
)
  .toString()
  .trim()
if (exists !== '1') {
  execSync(`docker exec ${container} createdb -U money ledger_test`, { stdio: 'inherit' })
}

execSync('npx prisma db push --skip-generate --accept-data-loss', {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: target },
})
