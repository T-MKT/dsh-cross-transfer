import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    include: ['test/stress/**/*.stress.ts'],
    environment: 'node',
    globals: true,
    testTimeout: 120000,
    hookTimeout: 120000,
    fileParallelism: false,
  },
})
