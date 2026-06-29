// @ts-check
import withNuxt from './.nuxt/eslint.config.mjs'
import vueI18n from '@intlify/eslint-plugin-vue-i18n'
import prettierConfig from 'eslint-config-prettier'
import prettierPlugin from 'eslint-plugin-prettier'
import garaaage from './eslint-plugins/index.mjs'

// Ported from garaaage-main, adapted for this project: we keep native <button>/<input>/
// <select> (auction24's Base* components wrap them) and have no data-cy/E2E layer, so the
// @nuxt/ui-specific "no native element" + data-cy rules are intentionally NOT carried over.
export default withNuxt(
  {
    ignores: ['.nuxt/**', '.output/**', 'dist/**', 'coverage/**'],
  },
  {
    plugins: {
      prettier: prettierPlugin,
      garaaage,
    },
    rules: {
      'prettier/prettier': 'warn',
      // Styling lives in <style scoped> via @apply, not as inline utility classes.
      'garaaage/no-inline-tailwind': 'error',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/ban-types': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-dynamic-delete': 'off',
      'vue/multi-word-component-names': 'off',
      'vue/max-attributes-per-line': 'off',
      'vue/require-default-prop': 'off',
      'vue/no-v-html': 'off',
      // Vue 3 supports fragment (multi-root) templates — auction24 pages use them.
      'vue/no-multiple-template-root': 'off',
      'no-unsafe-optional-chaining': 'off',
    },
  },
  // Flag hardcoded UI text that should go through i18n. Admin UI is internal/English,
  // so it (and the error page) is exempt. Warning only — guidance, not a gate.
  {
    files: ['**/*.vue'],
    // Playground is an internal, English-only component gallery (like admin).
    ignores: ['pages/admin/**', 'layouts/admin.vue', 'error.vue', 'pages/playground.vue', '**/ui/playground/**'],
    plugins: {
      '@intlify/vue-i18n': /** @type {any} */ (vueI18n),
    },
    rules: {
      '@intlify/vue-i18n/no-raw-text': [
        'warn',
        {
          attributes: {
            '/.+/': ['title', 'aria-label', 'aria-placeholder', 'aria-roledescription', 'aria-valuetext'],
            input: ['placeholder'],
            textarea: ['placeholder'],
            img: ['alt'],
            button: ['title', 'aria-label'],
            a: ['title', 'aria-label'],
          },
          ignoreNodes: ['pre', 'code', 'style'],
          ignorePattern: '^[\\s\\p{P}\\p{S}\\d]*$',
          // Brand / non-localized labels. Company/legal/contact constants live in
          // utils/company.ts (rendered via interpolation), not here.
          ignoreText: [
            'Auction24',
            'Auction24.cz',
            'EUR',
            'CZK',
            'km',
            'h',
            '360°',
            'OK',
            'Admin',
            'ID',
            'ID:',
            'Pan-Arab',
          ],
        },
      ],
    },
  },
  prettierConfig,
)
