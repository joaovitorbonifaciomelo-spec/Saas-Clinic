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
    /**
     * `consistent-type-imports` e INCOMPATIVEL com o NestJS.
     *
     * A regra converte `import { ClinicsService }` em `import { type ClinicsService }`
     * quando o simbolo so aparece em anotacao de tipo — que e exatamente o caso de
     * um parametro de construtor injetado. Com isso o `emitDecoratorMetadata` passa
     * a emitir `design:paramtypes = [Function]` no lugar da classe, e o container
     * falha em runtime com "Nest can't resolve dependencies".
     *
     * O typecheck continua passando, entao o erro so aparece ao subir a aplicacao.
     * Desativada aqui para que o --fix nao reintroduza o bug a cada servico novo.
     */
    files: ['apps/api/**/*.ts'],
    rules: { '@typescript-eslint/consistent-type-imports': 'off' },
  },
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
