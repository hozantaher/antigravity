/**
 * Bans inline Tailwind utility classes in Vue templates. Styling belongs in
 * `<style scoped>` via `@apply` (semantic class) or a project `@utility` from
 * main.css — never as `class="flex gap-4 ..."` on the element. Mirrors the
 * stylelint side which keeps raw/arbitrary values out of `@apply`.
 *
 * Detection is allowlist-by-shape: a token is a Tailwind utility when, after
 * stripping `!`, variant prefixes (`sm:`, `hover:`, ...) and a leading `-`, its
 * base is a known utility keyword, starts with a known utility root, or carries
 * an arbitrary value (`[...]`). Semantic names (`status`, `ui-badge`, `is-open`)
 * and project utilities (`app-btn`, `app-panel`) never match.
 */

// Standalone utilities that are whole words (no trailing `-value`).
// NOTE: `group` / `peer` are intentionally excluded — they are structural markers
// (for `group-hover:` / `peer-*` variants) that must stay in the template, not styling.
const KEYWORDS = new Set([
  'flex',
  'grid',
  'block',
  'inline',
  'table',
  'hidden',
  'contents',
  'flow-root',
  'list-item',
  'relative',
  'absolute',
  'fixed',
  'sticky',
  'static',
  'visible',
  'invisible',
  'collapse',
  'isolate',
  'truncate',
  'italic',
  'uppercase',
  'lowercase',
  'capitalize',
  'underline',
  'overline',
  'antialiased',
  'container',
  'transform',
  'transition',
  'border',
  'rounded',
  'ring',
  'outline',
  'shadow',
  'sr-only',
  'grow',
  'shrink',
])

// Utility roots used as `root-value` (or bare `root`).
const ROOTS = [
  'm',
  'mx',
  'my',
  'ms',
  'me',
  'mt',
  'mr',
  'mb',
  'ml',
  'p',
  'px',
  'py',
  'ps',
  'pe',
  'pt',
  'pr',
  'pb',
  'pl',
  'w',
  'h',
  'size',
  'min',
  'max',
  'min-w',
  'max-w',
  'min-h',
  'max-h',
  'gap',
  'space',
  'inset',
  'top',
  'right',
  'bottom',
  'left',
  'start',
  'end',
  'z',
  'flex',
  'basis',
  'grow',
  'shrink',
  'order',
  'grid',
  'col',
  'row',
  'auto',
  'justify',
  'items',
  'content',
  'self',
  'place',
  'text',
  'font',
  'leading',
  'tracking',
  'indent',
  'align',
  'whitespace',
  'break',
  'list',
  'decoration',
  'underline',
  'line',
  'truncate',
  'bg',
  'from',
  'via',
  'to',
  'gradient',
  'border',
  'rounded',
  'divide',
  'ring',
  'outline',
  'shadow',
  'opacity',
  'blur',
  'brightness',
  'contrast',
  'grayscale',
  'invert',
  'saturate',
  'sepia',
  'backdrop',
  'table',
  'transition',
  'duration',
  'ease',
  'delay',
  'animate',
  'scale',
  'rotate',
  'translate',
  'skew',
  'origin',
  'accent',
  'appearance',
  'cursor',
  'caret',
  'pointer',
  'resize',
  'scroll',
  'snap',
  'touch',
  'select',
  'will',
  'fill',
  'stroke',
  'object',
  'overflow',
  'overscroll',
  'float',
  'clear',
  'box',
  'columns',
  'aspect',
  'sr',
]

const isTailwindToken = (raw, allow) => {
  if (!raw) return false
  if (allow.some(re => re.test(raw))) return false

  // Strip variant prefixes (sm:, hover:, data-[..]:, ...) — keep the final base.
  const segments = raw.split(':')
  let base = segments[segments.length - 1]

  base = base.replace(/^!/, '').replace(/^-/, '') // important + negative
  if (!base) return false
  if (base.includes('[')) return true // arbitrary value, e.g. gap-[6px]

  base = base.split('/')[0] // drop opacity modifier (bg-app-red/90)

  if (KEYWORDS.has(base)) return true
  return ROOTS.some(root => base === root || base.startsWith(`${root}-`))
}

// Walk a `:class` expression, yielding { text, node } for every class literal.
const collectFromExpression = function* (node, keyOnly) {
  if (!node) return
  switch (node.type) {
    case 'Literal':
      yield { text: `${node.value}`, node }
      break
    case 'TemplateLiteral':
      for (const quasi of node.quasis) yield { text: quasi.value.cooked ?? '', node: quasi }
      for (const expr of node.expressions) yield* collectFromExpression(expr, true)
      break
    case 'BinaryExpression':
      if (node.operator === '+') {
        yield* collectFromExpression(node.left, true)
        yield* collectFromExpression(node.right, true)
      }
      break
    case 'ConditionalExpression':
      yield* collectFromExpression(node.consequent, true)
      yield* collectFromExpression(node.alternate, true)
      break
    case 'LogicalExpression':
      yield* collectFromExpression(node.right, true)
      break
    case 'ArrayExpression':
      for (const el of node.elements) {
        if (el && el.type !== 'SpreadElement') yield* collectFromExpression(el, keyOnly)
      }
      break
    case 'ObjectExpression':
      // Object keys are the class strings; values are the boolean conditions.
      for (const prop of node.properties) {
        if (prop.type !== 'Property') continue
        const key = prop.key
        if (key.type === 'Literal') yield { text: `${key.value}`, node: key }
        else if (key.type === 'Identifier' && !prop.computed) yield { text: key.name, node: key }
      }
      break
    default:
      break
  }
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'disallow inline Tailwind utility classes in templates (use <style> + @apply)',
    },
    schema: [
      {
        type: 'object',
        properties: {
          allow: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      inlineTailwind:
        "Inline Tailwind class '{{class}}' is not allowed. Move styling into <style scoped> via @apply (or a project @utility). See CLAUDE.md.",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode()
    const services = sourceCode.parserServices
    if (!services || !services.defineTemplateBodyVisitor) return {}

    const option = context.options[0] ?? {}
    const allow = (option.allow ?? []).map(p => {
      const m = /^\/(.+)\/([a-z]*)$/u.exec(p)
      return m ? new RegExp(m[1], m[2]) : new RegExp(`^${p}$`)
    })

    const report = (text, node) => {
      for (const cls of `${text}`.split(/\s+/)) {
        if (isTailwindToken(cls, allow)) {
          context.report({ node, messageId: 'inlineTailwind', data: { class: cls } })
        }
      }
    }

    return services.defineTemplateBodyVisitor({
      "VAttribute[directive=false][key.name='class'][value!=null]"(node) {
        report(node.value.value, node)
      },
      "VAttribute[directive=true][key.name.name='bind'][key.argument.name='class'] > VExpressionContainer.value"(node) {
        for (const { text, node: at } of collectFromExpression(node.expression)) report(text, at)
      },
    })
  },
}
