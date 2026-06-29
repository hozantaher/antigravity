// H1 — Custom ESLint rule: forbid getByText/findByText/queryByText for
// action elements (button, a, role=button, role=link).
//
// Heuristic: any of these signals → likely action context (rule fires):
//   - .click() called on the result
//   - fireEvent.click(... ByText ...) wraps the call
//   - userEvent.click(... ByText ...) wraps the call
//
// Suggest using:
//   - getByRole('button', { name: /text/ })
//   - getByTestId('stable-id')
//
// Severity: 'warn' initially (ratchet to 'error' after data-testid migration).

const QUERY_NAMES = new Set(['getByText', 'findByText', 'queryByText', 'getAllByText', 'findAllByText', 'queryAllByText'])

export default {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Forbid getByText for action elements; prefer getByRole or getByTestId',
      category: 'Best Practices',
    },
    messages: {
      noAction: 'getByText is fragile for action elements (button/link). Use getByRole("button", { name: ... }) or getByTestId(...) instead.',
    },
    schema: [],
  },
  create(context) {
    function isActionWrapped(node) {
      // Walk up: is this CallExpression nested inside .click() or fireEvent.click() or user.click()?
      let parent = node.parent
      while (parent) {
        if (parent.type === 'MemberExpression' && parent.property?.name === 'click') return true
        if (parent.type === 'CallExpression') {
          const callee = parent.callee
          if (callee?.type === 'MemberExpression' && callee.property?.name === 'click') return true
          if (callee?.type === 'Identifier' && callee.name === 'click') return true
        }
        parent = parent.parent
      }
      return false
    }
    return {
      CallExpression(node) {
        const callee = node.callee
        // Match: screen.getByText(...) or .getByText(...) or directly getByText(...)
        let queryName = null
        if (callee.type === 'MemberExpression' && callee.property?.type === 'Identifier') {
          queryName = callee.property.name
        } else if (callee.type === 'Identifier') {
          queryName = callee.name
        }
        if (!queryName || !QUERY_NAMES.has(queryName)) return
        if (isActionWrapped(node)) {
          context.report({ node, messageId: 'noAction' })
        }
      },
    }
  },
}
