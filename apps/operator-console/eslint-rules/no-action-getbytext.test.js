// H1 — ESLint rule tests.
// Uses RuleTester from eslint v9 flat config style.

import { RuleTester } from 'eslint'
import rule from './no-action-getbytext.js'

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
})

ruleTester.run('no-action-getbytext', rule, {
  valid: [
    // 1. getByRole is the recommended pattern
    `screen.getByRole('button', { name: 'Spustit' }).click()`,
    // 2. getByTestId is also fine
    `screen.getByTestId('submit-btn').click()`,
    // 3. getByText for static labels (not followed by .click) is allowed
    `expect(screen.getByText('Welcome!')).toBeInTheDocument()`,
    // 4. queryByText for assertion only — no click
    `expect(screen.queryByText('Error')).toBeNull()`,
    // 5. findByText awaited then asserted (no click)
    `const el = await screen.findByText('Loading…'); expect(el).toBeVisible()`,
    // 6. getByText nested in expect (no action)
    `expect(screen.getByText('label')).toHaveTextContent('label')`,
    // 7. fireEvent.change (NOT click) is fine
    `fireEvent.change(screen.getByText('Field'), { target: { value: 'x' } })`,
  ],
  invalid: [
    // 1. .click() chained on getByText
    {
      code: `screen.getByText('Spustit').click()`,
      errors: [{ messageId: 'noAction' }],
    },
    // 2. fireEvent.click wrapping getByText
    {
      code: `fireEvent.click(screen.getByText('Vytvořit'))`,
      errors: [{ messageId: 'noAction' }],
    },
    // 3. user.click async wrapping getByText regex
    {
      code: `await user.click(screen.getByText(/save/i))`,
      errors: [{ messageId: 'noAction' }],
    },
    // 4. userEvent.click wrapping
    {
      code: `await userEvent.click(screen.getByText('Submit'))`,
      errors: [{ messageId: 'noAction' }],
    },
    // 5. queryByText followed by .click()
    {
      code: `screen.queryByText('Maybe').click()`,
      errors: [{ messageId: 'noAction' }],
    },
    // 6. findByText in click chain
    {
      code: `(await screen.findByText('Async Btn')).click()`,
      errors: [{ messageId: 'noAction' }],
    },
    // 7. Nested call: fireEvent.click(getByText('X'))
    {
      code: `fireEvent.click(getByText('Bare'))`,
      errors: [{ messageId: 'noAction' }],
    },
    // 8. getAllByText followed by [0].click()
    {
      code: `screen.getAllByText('Repeat')[0].click()`,
      errors: [{ messageId: 'noAction' }],
    },
  ],
})

console.log('✓ no-action-getbytext: 7 valid + 8 invalid cases pass')
