// Stryker mutation testing config — KT-B9 (initiative
// docs/initiatives/2026-04-30-kampan-vykupu-techniky-B-quality.md).
//
// Per-module config (this file lives next to package.json) + points the
// vitest runner at vitest.config.ts (NOT vite.config.js — vitest.config.ts
// is the canonical test config since the "Tests as Heart" Phase 0
// consolidation; see vitest.config.ts header). This is the convention
// recorded in project memory `project_stryker_setup`.
//
// Scope: only pure-logic libs in src/lib that have established unit-test
// suites. Network/UI/server modules deliberately excluded — mutation
// signal there is dominated by mocks and e2e harness, not the unit
// surface Stryker is good at.
//
// Mutators: arithmetic / boolean / conditional / equality / logical /
// string-literal — the six families that catch the regressions we
// actually see in incident reviews (off-by-one comparisons, flipped
// negations, swapped operators in scoring math). Other mutators
// (BlockStatement, ObjectLiteral, ArrayDeclaration, ...) generate noisy
// equivalent mutants on this codebase and are disabled.
//
// Threshold strategy: `break: 0` keeps the runner non-blocking while we
// pin a real baseline. Once `pnpm test:mutation` produces a stable score
// for the targeted files, raise `break` to that score minus a small
// margin (one-way ratchet, never lower).
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  $schema: './node_modules/@stryker-mutator/core/schema/stryker-schema.json',
  packageManager: 'pnpm',
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  vitest: {
    configFile: 'vitest.config.ts',
  },
  reporters: ['html', 'progress', 'clear-text'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },

  // Narrow scope — mutation testing scales O(LOC) so we keep the
  // mutated surface deliberately small. Add files only when they have
  // a unit-test suite that already passes consistently.
  mutate: [
    'src/lib/suppression-union.js',
    'src/lib/suppressionFilter.js',
    'src/lib/llmReplyClassifier.js',
  ],

  // Mutator allowlist — Stryker exposes only `excludedMutations` (no
  // positive allowlist), so we list every mutator family we DO NOT want
  // to run. The kept set is: ArithmeticOperator, BooleanLiteral,
  // ConditionalExpression, EqualityOperator, LogicalOperator,
  // StringLiteral (the six with the highest signal-to-noise ratio for
  // this codebase — see header for rationale).
  mutator: {
    excludedMutations: [
      'ArrayDeclaration',
      'ArrowFunction',
      'AssignmentOperator',
      'BlockStatement',
      'MethodExpression',
      'ObjectLiteral',
      'OptionalChaining',
      'Regex',
      'UnaryOperator',
      'UpdateOperator',
    ],
  },

  ignorePatterns: [
    'e2e/**',
    'node_modules/**',
    'reports/**',
    '.stryker-tmp/**',
    'dist/**',
  ],

  // Thresholds — score raised 2026-04-30 to 79.43% after KT-B9 survivor
  // rescue (174/175 covered, 139 killed, 35 survived) on branch
  // test/stryker-survivor-fixes-2026-04-30. Previous baseline was
  // 66.29% (commit fb0332e4). `break: 74` keeps a ~5-pp safety margin
  // against day-to-day flake; raise it as the suite kills more mutants
  // (one-way ratchet, never lower). `low`/`high` only affect colour in
  // the HTML report.
  thresholds: { high: 85, low: 75, break: 74 },

  coverageAnalysis: 'perTest',
  concurrency: 4,
  timeoutMS: 15000,
  disableTypeChecks: true,
}
