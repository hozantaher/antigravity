/**
 * AV-F4 — llmReplyClassifierPrompt unit tests.
 *
 * Validates the prompt is well-formed for the JSON-instruct flow:
 *   - all 7 categories present (positive/negative/question/auto_reply/bounce/unsubscribe/null)
 *   - example structure included (INPUT/OUTPUT pairs)
 *   - body is truncated to LLM_BODY_TRUNC_CHARS
 *   - missing subject/from rendered as defaults ('(no subject)' / '(unknown)')
 */
import { describe, expect, it } from 'vitest'
import {
  buildClassifyPrompt,
  LLM_BODY_TRUNC_CHARS,
} from '../../../src/lib/llmReplyClassifierPrompt.js'

describe('buildClassifyPrompt', () => {
  it('mentions all 7 categories (including null)', () => {
    const p = buildClassifyPrompt({ body: 'hello', subject: 'subj', fromAddress: 'a@b.cz' })
    const expected = ['positive', 'negative', 'question', 'auto_reply', 'bounce', 'unsubscribe', 'null']
    for (const cat of expected) {
      expect(p).toContain(cat)
    }
  })

  it('contains INPUT / OUTPUT example structure', () => {
    const p = buildClassifyPrompt({ body: 'x', subject: 'y', fromAddress: 'z@b.cz' })
    expect(p).toContain('INPUT:')
    expect(p).toContain('OUTPUT:')
    // Real-corpus example payloads
    expect(p).toContain('dzobamek@seznam.cz')
    expect(p).toContain('chupik@chupik.cz')
  })

  it('truncates body to LLM_BODY_TRUNC_CHARS', () => {
    const longBody = 'A'.repeat(LLM_BODY_TRUNC_CHARS + 500)
    const p = buildClassifyPrompt({ body: longBody, subject: 's', fromAddress: 'f@x.cz' })
    // The prompt also contains "AAAA…" in examples? No — examples don't use 'A' as a long run.
    // Count actual run of 'A' to be safe.
    const longestA = (p.match(/A+/g) || []).reduce((max, m) => Math.max(max, m.length), 0)
    expect(longestA).toBeLessThanOrEqual(LLM_BODY_TRUNC_CHARS)
    expect(longestA).toBeGreaterThan(0)
  })

  it('falls back to (no subject) / (unknown) when fields are missing', () => {
    const p = buildClassifyPrompt({ body: 'x' })
    expect(p).toContain('(no subject)')
    expect(p).toContain('(unknown)')
  })

  it('exports LLM_BODY_TRUNC_CHARS as a positive integer', () => {
    expect(LLM_BODY_TRUNC_CHARS).toBeGreaterThan(0)
    expect(Number.isInteger(LLM_BODY_TRUNC_CHARS)).toBe(true)
  })
})
