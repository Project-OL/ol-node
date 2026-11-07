import { defineConfig } from 'vitest/config'
import path from 'path'

/**
 * Rich tier in-memory simulation (`npm run test:rich-tier-sim`). The main config excludes
 * tests/integration/**, so this config includes the sim explicitly. No DB/Redis needed.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/integration/rich-tier-time-compressed.test.ts'],
    setupFiles: ['tests/setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
