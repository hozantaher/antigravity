import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    ignores: ['dist/**', 'node_modules/**', 'vitest.config.ts', 'products/**', 'spine/platform/outreach-dashboard/**', 'spine/platform/platform/**', 'spine/legacy/**', 'docs/.vitepress/dist/**']
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'no-empty': 'off',
      'no-useless-assignment': 'off',
      'no-undef': 'off',
      '@typescript-eslint/no-require-imports': 'off'
    }
  }
);
