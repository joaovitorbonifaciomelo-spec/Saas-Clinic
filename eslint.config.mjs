// @ts-check
import { baseConfig } from '@clinicas/config/eslint/base.mjs'

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/*.d.ts',
      'apps/web/next-env.d.ts',
    ],
  },
  ...baseConfig,
  {
    // Scripts operacionais rodam direto no Node, fora de qualquer bundler:
    // precisam dos globais do runtime e de imprimir resultado no terminal.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        __dirname: 'readonly',
      },
    },
    rules: { 'no-console': 'off' },
  },
  {
    files: ['supabase/tests/**/*.ts'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', __dirname: 'readonly' },
    },
    rules: { 'no-console': 'off' },
  },
]
