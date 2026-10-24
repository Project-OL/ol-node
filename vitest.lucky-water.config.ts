import { defineConfig } from 'vitest/config'
import path from 'path'

/**
 * Phase 3 water_v1 ledger test against the local Phase-2 lucky DB (127.0.0.1:5433/ol_lucky).
 * Separate from vitest.ledger.config.ts (which pins the :55432 Live-server money container).
 *   npx vitest run -c vitest.lucky-water.config.ts
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/ledger/lucky-water.ledger.test.ts'],
    setupFiles: ['tests/ledger/lucky-water.env.setup.ts'],
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
