import os from 'node:os'
import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
    coverage: {
      provider: 'v8',
      all: true,
      include: ['src/**/*.{ts,js}'],
      exclude: ['src/**/*.d.ts'],
      reporter: ['text-summary', 'json-summary', 'json'],
      reportsDirectory: path.join(
        os.tmpdir(),
        'ai-work',
        'datanoa',
        'coverage-100-full',
        'v8-report'
      ),
    },
  },
})
