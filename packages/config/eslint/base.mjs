// @ts-check
import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

/**
 * Preset base do monorepo. Regras type-aware ficam fora de proposito:
 * exigem um programa TS por pacote e tornam o lint lento nesta fase.
 * As checagens de tipo sao responsabilidade do `pnpm typecheck`.
 */
export const baseConfig = tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
)

export default baseConfig
