export default {
  extends: ['stylelint-config-recommended-vue'],
  customSyntax: 'postcss-html',
  plugins: [
    './stylelint-plugins/no-tailwind-arbitrary.mjs',
    './stylelint-plugins/no-raw-opacity-outside-keyframes.mjs',
  ],
  rules: {
    'garaaage/no-tailwind-arbitrary': true,
    'garaaage/no-raw-opacity-outside-keyframes': true,
    // CSS nesting + Vue scoped styles trigger false positives — base classes inside nested
    // blocks legitimately follow their more-specific descendants.
    'no-descending-specificity': null,
    'selector-class-pattern': [
      // Single _ allowed (enum values like `minor_issues`); double __/-- (BEM) rejected.
      '^(?!.*(__|--))[a-zA-Z][a-zA-Z0-9_-]*$',
      {
        message:
          'No BEM (__ or --) in class names. Use simple kebab-case + CSS nesting + .is-* state modifiers (viz CLAUDE.md).',
      },
    ],
    'declaration-property-unit-disallowed-list': [
      {
        // margin/gap/font-size/line-height/padding/border-*/top/right/bottom/left are banned outright below.
        '/^inset/': ['px', 'rem'],
        width: ['px', 'rem'],
        'min-width': ['px', 'rem'],
        'max-width': ['px', 'rem'],
        height: ['px', 'rem'],
        'min-height': ['px', 'rem'],
        'max-height': ['px', 'rem'],
      },
      {
        message:
          'Avoid raw px/rem — use Tailwind utility via @apply (e.g. @apply mb-4, @apply text-sm) or a CSS variable from main.css.',
      },
    ],
    'declaration-property-value-disallowed-list': [
      {
        'font-weight': ['/.*/'],
        background: ['/^#[0-9a-fA-F]+$/'],
        'text-align': ['/.*/'],
        'text-decoration': ['/.*/'],
        'text-decoration-line': ['/.*/'],
        '/^margin/': ['/.*/'],
        gap: ['/.*/'],
        'row-gap': ['/.*/'],
        'column-gap': ['/.*/'],
        'font-family': ['/.*/'],
        'font-size': ['/.*/'],
        'line-height': ['/.*/'],
        'letter-spacing': ['/.*/'],
        display: ['/.*/'],
        'list-style': ['/.*/'],
        'object-fit': ['/.*/'],
        'flex-shrink': ['/.*/'],
        'flex-wrap': ['/.*/'],
        'flex-direction': ['/.*/'],
        flex: ['/.*/'],
        top: ['/.*/'],
        right: ['/.*/'],
        bottom: ['/.*/'],
        left: ['/.*/'],
        'justify-self': ['/.*/'],
        'white-space': ['/.*/'],
        overflow: ['/.*/'],
        'overflow-x': ['/.*/'],
        'overflow-y': ['/.*/'],
        'vertical-align': ['/.*/'],
        position: ['/.*/'],
        outline: ['/.*/'],
        'text-transform': ['/.*/'],
        'justify-content': ['/.*/'],
        'align-items': ['/.*/'],
        '/^padding/': ['/.*/'],
        color: ['/.*/'],
        'background-color': ['/.*/'],
        'z-index': ['/.*/'],
        cursor: ['/.*/'],
        'aspect-ratio': ['/.*/'],
        'grid-template-columns': ['/.*/'],
        '/^border/': ['/.*/'],
        'pointer-events': ['/.*/'],
      },
      {
        message:
          'Avoid raw value — use Tailwind utility via @apply (e.g. @apply font-bold, text-center, underline). Hex colors and off-scale numbers belong in @theme tokens or Tailwind utilities.',
      },
    ],
    'media-feature-name-disallowed-list': [
      ['min-width', 'max-width'],
      {
        message:
          'Use Tailwind responsive utilities (sm:, md:, lg:, max-md:, ...) instead of raw width media queries. Accessibility features (prefers-reduced-motion, forced-colors, hover) remain allowed.',
      },
    ],
    'at-rule-no-unknown': [
      true,
      {
        ignoreAtRules: [
          'apply',
          'tailwind',
          'layer',
          'variants',
          'responsive',
          'screen',
          'theme',
          'config',
          'utility',
          'source',
          'reference',
          'custom-variant',
        ],
      },
    ],
  },
  ignoreFiles: [
    'node_modules/**',
    '.nuxt/**',
    '.output/**',
    'dist/**',
    'coverage/**',
    'public/**',
    'old/**',
    'prototype/**',
    '**/*.min.css',
    // Token / base layer files own the raw values that everything else references.
    'assets/css/main.css',
    'assets/css/reset.css',
  ],
}
