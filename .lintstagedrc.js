module.exports = {
  '**/vektor.json': () => [
    'npm run ag:audit -- --heal',
    'npm run ag:map',
    'node dist/index.js docs',
    'git add docs/ARCHITECTURE.md docs/AUTODOCS.md **/vektor.json'
  ],
  '**/*.{ts,vue}': () => [
    'npm run ag:audit -- --heal',
    'eslint --fix',
    'prettier --write',
    'git add **/vektor.json'
  ]
}
