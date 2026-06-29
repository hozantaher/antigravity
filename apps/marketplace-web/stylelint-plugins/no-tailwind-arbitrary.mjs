import stylelint from 'stylelint'

const { createPlugin, utils } = stylelint

const ruleName = 'garaaage/no-tailwind-arbitrary'
const meta = { fixable: false }

const ARBITRARY_VALUE_RE = /\b[\w-]+-\[[^\]]+\]/g

const ruleFunction = primary => {
  return (root, result) => {
    const validOptions = utils.validateOptions(result, ruleName, { actual: primary })
    if (!validOptions) return

    root.walkAtRules('apply', atRule => {
      let match
      ARBITRARY_VALUE_RE.lastIndex = 0
      while ((match = ARBITRARY_VALUE_RE.exec(atRule.params)) !== null) {
        utils.report({
          message: `Unexpected arbitrary value "${match[0]}" — use a Tailwind preset or CSS variable instead.`,
          node: atRule,
          result,
          ruleName,
          word: match[0],
        })
      }
    })
  }
}

ruleFunction.ruleName = ruleName
ruleFunction.meta = meta

export default createPlugin(ruleName, ruleFunction)
