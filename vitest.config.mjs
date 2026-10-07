import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    maxWorkers: 4,
    testTimeout: 15000, // PNG rasterization can exceed five seconds on shared CI workers.
    include: [
      'server/**/*.test.mjs',
      'scripts/**/*.{test,spec}.mjs',
    ],
  },
})
