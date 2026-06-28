// H1 — ESLint rule tests via vitest (manual verification per case).

import { describe, it, expect } from 'vitest'
import { Linter } from 'eslint'
import rule from '../../../eslint-rules/no-action-getbytext.js'

const linter = new Linter()

function lintCode(code) {
  return linter.verify(code, {
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    plugins: { custom: { rules: { 'no-action-getbytext': rule } } },
    rules: { 'custom/no-action-getbytext': 'warn' },
  })
}

describe('no-action-getbytext rule (H1)', () => {
  describe('VALID cases (should NOT report)', () => {
    const validCases = [
      `screen.getByRole('button', { name: 'Spustit' }).click()`,
      `screen.getByTestId('submit-btn').click()`,
      `expect(screen.getByText('Welcome!')).toBeInTheDocument()`,
      `expect(screen.queryByText('Error')).toBeNull()`,
      `const el = await screen.findByText('Loading…'); expect(el).toBeVisible()`,
      `expect(screen.getByText('label')).toHaveTextContent('label')`,
      `fireEvent.change(screen.getByText('Field'), { target: { value: 'x' } })`,
    ]
    for (const code of validCases) {
      it(`valid: ${code.slice(0, 60)}`, () => {
        const messages = lintCode(code)
        const ruleViolations = messages.filter(m => m.ruleId === 'custom/no-action-getbytext')
        expect(ruleViolations).toHaveLength(0)
      })
    }
  })

  describe('INVALID cases (should report)', () => {
    const invalidCases = [
      `screen.getByText('Spustit').click()`,
      `fireEvent.click(screen.getByText('Vytvořit'))`,
      `await user.click(screen.getByText(/save/i))`,
      `await userEvent.click(screen.getByText('Submit'))`,
      `screen.queryByText('Maybe').click()`,
      `(await screen.findByText('Async Btn')).click()`,
      `fireEvent.click(getByText('Bare'))`,
      `screen.getAllByText('Repeat')[0].click()`,
    ]
    for (const code of invalidCases) {
      it(`invalid: ${code.slice(0, 60)}`, () => {
        const messages = lintCode(code)
        const ruleViolations = messages.filter(m => m.ruleId === 'custom/no-action-getbytext')
        expect(ruleViolations.length).toBeGreaterThan(0)
        expect(ruleViolations[0].message).toMatch(/getByText|getByRole|getByTestId/)
      })
    }
  })
})
