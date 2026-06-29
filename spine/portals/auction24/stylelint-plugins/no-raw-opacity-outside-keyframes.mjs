import stylelint from 'stylelint'

const { createPlugin, utils } = stylelint

const ruleName = 'garaaage/no-raw-opacity-outside-keyframes'
const meta = { fixable: false }

const isInsideKeyframes = node => {
  let parent = node.parent
  while (parent) {
    if (parent.type === 'atrule' && /^(-\w+-)?keyframes$/.test(parent.name)) return true
    parent = parent.parent
  }
  return false
}

const ruleFunction = primary => {
  return (root, result) => {
    const validOptions = utils.validateOptions(result, ruleName, { actual: primary })
    if (!validOptions) return

    root.walkDecls('opacity', decl => {
      if (isInsideKeyframes(decl)) return
      utils.report({
        message:
          'Avoid raw opacity — use @apply opacity-* (e.g. @apply opacity-50). Raw opacity is allowed only inside @keyframes (Tailwind v4 forbids @apply there).',
        node: decl,
        result,
        ruleName,
      })
    })
  }
}

ruleFunction.ruleName = ruleName
ruleFunction.meta = meta

export default createPlugin(ruleName, ruleFunction)
