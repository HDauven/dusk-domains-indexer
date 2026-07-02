import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'server/**/*.test.mjs',
      'scripts/**/*.{test,spec}.mjs',
    ],
  },
})
