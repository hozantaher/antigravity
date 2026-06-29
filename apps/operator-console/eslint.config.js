import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'
import noActionGetByText from './eslint-rules/no-action-getbytext.js'

export default defineConfig([
  globalIgnores(['dist', 'node_modules', '.stryker-tmp']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],
    },
  },
  // H3 — Custom rule for tests: forbid getByText() for action elements.
  // Severity 'warn' initially; ratchet to 'error' after data-testid migration.
  {
    files: ['tests/**/*.{js,jsx,ts,tsx}'],
    plugins: {
      custom: { rules: { 'no-action-getbytext': noActionGetByText } },
    },
    rules: {
      'custom/no-action-getbytext': 'warn',
    },
  },
])
