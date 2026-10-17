import { defineConfig } from 'vitest/config'
import path from 'path'

/** BE-20 internal-ledger money tests against the local throwaway Postgres (see tests/ledger/env.setup.ts). */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/ledger/**/*.test.ts'],
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
