import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'shared',
          root: './packages/shared',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'api',
          root: './apps/api',
          environment: 'node',
          include: ['test/**/*.test.ts'],
        },
      },
      {
        // Depende de banco remoto: fora do `pnpm test`, roda em `pnpm test:isolation`.
        test: {
          name: 'isolation',
          root: './supabase',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
          fileParallelism: false,
          env: { NODE_ENV: 'test' },
          setupFiles: ['./tests/setup-env.ts'],
        },
      },
    ],
  },
})
