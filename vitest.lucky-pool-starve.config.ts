import { defineConfig } from 'vitest/config'
import path from 'path'

/** C2: isolated fork with connection_limit=4. */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/ledger/lucky-pool-starvation.test.ts'],
    setupFiles: ['tests/ledger/lucky-pool-starve.env.setup.ts'],
    fileParallelism: false,
    pool: 'forks',
    maxWorkers: 1,
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
