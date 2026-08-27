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
          // O do cookie precisa do app Next no ar: projeto proprio, script proprio.
          exclude: ['tests/clinic-hint.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
          fileParallelism: false,
          env: { NODE_ENV: 'test' },
          setupFiles: ['./tests/setup-env.ts'],
        },
      },
      {
        /*
         * Seguranca do cookie de clinica. Depende do app Next no ar (WEB_URL)
         * alem do banco e da API, entao fica fora de `pnpm test:isolation` e
         * roda em `pnpm test:hint`.
         */
        test: {
          name: 'hint',
          root: './supabase',
          environment: 'node',
          include: ['tests/clinic-hint.test.ts'],
          testTimeout: 120_000,
          hookTimeout: 180_000,
          fileParallelism: false,
          env: { NODE_ENV: 'test' },
          setupFiles: ['./tests/setup-env.ts'],
        },
      },
    ],
  },
})
