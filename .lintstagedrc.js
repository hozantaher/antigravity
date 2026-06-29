module.exports = {
  '**/vektor.json': () => [
    'npm run ag:audit -- --heal',
    'npm run ag:audit -- --sweep',
    'npm run ag:map',
    'node dist/index.js docs',
    'git add docs/reference/topology-map.md docs/reference/autodocs.md **/vektor.json'
  ],
  '{src,spine}/**/*.{ts,vue}': () => [
    'npm run ag:audit -- --heal',
    'npm run ag:audit -- --sweep',
    'eslint --fix',
    'prettier --write',
    'git add **/vektor.json'
  ]
}
