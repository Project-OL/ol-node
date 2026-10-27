import { defineConfig } from 'vitest/config'
import path from 'path'

/** BE-20 internal-ledger money tests against the local throwaway Postgres (see tests/ledger/env.setup.ts). */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/ledger/**/*.test.ts'],
    // Lucky water-level suites need the seeded lucky DB and their own setup files
    // (vitest.lucky-water.config.ts, vitest.lucky-pool-starve.config.ts).
    exclude: [
      'tests/ledger/lucky-water.ledger.test.ts',
      'tests/ledger/lucky-shadow-worker.test.ts',
      'tests/ledger/lucky-pool-starvation.test.ts',
    ],
    setupFiles: ['tests/ledger/env.setup.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
