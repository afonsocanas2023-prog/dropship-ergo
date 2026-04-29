// @ts-check
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '*.mjs'] },

  ...tseslint.configs.recommended,

  {
    rules: {
      // Downgrade to warn — test helpers occasionally need broad types
      '@typescript-eslint/no-explicit-any': 'warn',
      // Unused vars are an error; prefix with _ to opt out intentionally
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // The project convention is named exports only
      'no-restricted-syntax': [
        'error',
        { selector: 'ExportDefaultDeclaration', message: 'Use named exports only (project convention).' },
      ],
    },
  },

  // Relax rules that are noisy in test files
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      // vi.fn() assignments look like unsafe member access to ESLint
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
)
