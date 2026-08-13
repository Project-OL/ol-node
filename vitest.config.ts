import { defineConfig, configDefaults } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'tests/**/*.test.ts',
      'tests/**/*.spec.ts',
      'lab/concurrency/**/*.test.ts',
    ],
    // tests/integration/** are explicit "real service" simulations run via their
    // own dedicated scripts (e.g. npm run test:rich-tier-sim) against real
    // DB/Redis — they're not meant to run under plain `npm test`.
    exclude: [...configDefaults.exclude, 'tests/integration/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      include: ['src/services/**/*.ts', 'src/repositories/**/*.ts', 'src/utils/jwt.ts'],
      exclude: ['src/**/*.d.ts', 'src/workers/**', 'src/jobs/**', '**/index.ts'],
    },
    setupFiles: ['tests/setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
