// @linkage-allowed: discipline ratchet — checks docs/playbooks/operator-practice.md shape
/**
 * OP1.5 — audit for the operator practice runbook.
 *
 * Goal: prevent the runbook from rotting silently. If sprints land,
 * the table should reflect them; if commands rename, the runbook should
 * track. This test catches the most common drift patterns.
 */

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, it, expect } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '../../../../..')
const PLAYBOOK = join(REPO_ROOT, 'docs/playbooks/operator-practice.md')

describe('OP1.5 — operator practice runbook', () => {
  // 1. Playbook exists.
  it('playbook file exists', () => {
    expect(existsSync(PLAYBOOK)).toBe(true)
  })

  const md = readFileSync(PLAYBOOK, 'utf8')

  // 2. References the initiative doc.
  it('references the initiative doc', () => {
    expect(md).toMatch(/2026-04-30-operator-practice/)
  })

  // 3. References the operator focus memory.
  it('references feedback_operator_focus memory', () => {
    expect(md).toMatch(/feedback_operator_focus/)
  })

  // 4. Has a TL;DR with 3-step quickstart.
  it('has TL;DR section with quickstart', () => {
    expect(md).toMatch(/^##\s+TL;DR/m)
  })

  // 5. Quickstart mentions seed-replies.sh.
  it('quickstart shows seed-replies.sh', () => {
    expect(md).toMatch(/scripts\/mail-lab\/seed-replies\.sh/)
  })

  // 6. Quickstart mentions Mail Lab up.sh.
  it('quickstart shows mail-lab up.sh', () => {
    expect(md).toMatch(/scripts\/mail-lab\/up\.sh/)
  })

  // 7. Has a prerequisites section.
  it('has prerequisites section', () => {
    expect(md).toMatch(/^##\s+Prerequisites/m)
  })

  // 8. Has daily training routine section.
  it('has daily training routine section', () => {
    expect(md).toMatch(/Daily training routine|Training routine|trénink/i)
  })

  // 9. Has Sprint-aware feature map.
  it('has sprint-aware feature map', () => {
    expect(md).toMatch(/Sprint-aware feature map|feature map|sprint-aware/i)
  })

  // 10. Feature map references all OP sprints (OP1, OP2, OP3, OP4, OP5).
  it('feature map covers OP1–OP5', () => {
    for (const sprint of ['OP1', 'OP2', 'OP3', 'OP4', 'OP5']) {
      expect(md, `missing reference to ${sprint}`).toMatch(new RegExp(sprint))
    }
  })

  // 11. Has fixtures section explaining placeholder vs real.
  it('explains placeholder vs real-anonymized fixture sources', () => {
    expect(md).toMatch(/_placeholders/)
    expect(md).toMatch(/X-Lab-Source/)
    expect(md).toMatch(/placeholder-infrastructure-test/)
  })

  // 12. Has troubleshooting section.
  it('has troubleshooting section', () => {
    expect(md).toMatch(/^##\s+Troubleshooting/m)
  })

  // 13. Troubleshooting covers IMAP connect failure.
  it('troubleshooting covers ECONNREFUSED', () => {
    expect(md).toMatch(/ECONNREFUSED/)
  })

  // 14. Troubleshooting covers auth failure.
  it('troubleshooting covers LOGIN BAD / auth failed', () => {
    expect(md).toMatch(/LOGIN BAD|auth failed|provisioned/)
  })

  // 15. Has hard rules section listing safety guardrails.
  it('has hard rules section with safety guardrails', () => {
    expect(md).toMatch(/^##\s+Hard rules/im)
  })

  // 16. Hard rules cite memory rules.
  it('hard rules cite feedback memory entries', () => {
    expect(md).toMatch(/feedback_campaign_send/)
    expect(md).toMatch(/feedback_no_fabricated_test_data/)
  })

  // 17. Hard rules mention GDPR.
  it('hard rules mention GDPR', () => {
    expect(md).toMatch(/GDPR|Art\.?\s*6/i)
  })

  // 18. Has Related docs section.
  it('has Related docs section', () => {
    expect(md).toMatch(/^##\s+Related docs/m)
  })

  // 19. Related docs link to LLM classifier initiative.
  it('related docs link to LLM classifier initiative', () => {
    expect(md).toMatch(/llm-reply-classifier/)
  })

  // 20. Related docs link to Mail Lab initiative.
  it('related docs link to Mail Lab initiative', () => {
    expect(md).toMatch(/mail-lab/)
  })

  // 21. Has at least 6 H2 sections.
  it('has at least 6 H2 sections', () => {
    const h2 = md.match(/^##\s+/gm) || []
    expect(h2.length).toBeGreaterThanOrEqual(6)
  })

  // 22. Has at least one code block per quickstart.
  it('has fenced code blocks for shell commands', () => {
    const codeBlocks = md.match(/```bash/g) || []
    expect(codeBlocks.length).toBeGreaterThanOrEqual(3)
  })

  // 23. Status line says "living document".
  it('declares itself a living document', () => {
    expect(md).toMatch(/living document/i)
  })

  // 24. Mentions practice-mode toggle (OP3.4) so operators know it's pending.
  it('mentions practice-mode toggle', () => {
    expect(md).toMatch(/practice.mode/i)
  })

  // 25. Mentions confusion matrix (OP4.3).
  it('mentions confusion matrix', () => {
    expect(md).toMatch(/confusion matrix/i)
  })
})
