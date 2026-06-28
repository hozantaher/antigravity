module.exports = {
  '**/vektor.json': () => [
    'npm run ag:audit -- --heal',
    'npm run ag:map',
    'git add ARCHITECTURE.md **/vektor.json'
  ],
  '**/*.{ts,vue}': () => [
    'npm run ag:audit -- --heal',
    'eslint --fix',
    'prettier --write',
    'git add **/vektor.json'
  ]
}
