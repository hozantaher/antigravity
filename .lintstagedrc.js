module.exports = {
  '**/vektor.json': () => [
    'npm run ag:audit -- --heal',
    'npm run ag:map',
    'node dist/index.js docs',
    'git add docs/reference/topology-map.md docs/reference/autodocs.md **/vektor.json'
  ],
  '{src,spine}/**/*.{ts,vue}': () => [
    'npm run ag:audit -- --heal',
    'eslint --fix',
    'prettier --write',
    'git add **/vektor.json'
  ]
}
