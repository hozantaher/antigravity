/**
 * AV-F4 — classifyReplyWithLLM integration tests.
 *
 * Validates the two-stage classifier:
 *   1. Regex confident (≥ 0.75) → no LLM call, regex verdict returned.
 *   2. Regex low-confidence → LLM called; LLM confident (> regex) → LLM wins
 *      with classifier_version='ollama_v1'.
 *   3. Regex low-confidence → LLM uncertain (< LLM_MIN_CONFIDENCE) → LLM
 *      stage recorded, regex verdict kept (classifier_version='regex_v1').
 *   4. Regex low-confidence → LLM fails (unreachable/parse) → regex stays,
 *      llm_error captured in reasoning.
 *   5. Regex low-confidence → LLM equals regex confidence → regex stays
 *      (LLM only wins on strictly higher confidence).
 */
import { describe, expect, it, vi } from 'vitest'
import {
  classifyReplyWithLLM,
  CLASSIFIER_VERSION,
  LLM_CLASSIFIER_VERSION,
  LLM_TRIGGER_THRESHOLD,
} from '../../../src/lib/replyClassifier.js'

function mockClient(response) {
  return {
    callLlmRunnerClassify: vi.fn().mockResolvedValue(response),
  }
}

const silentLogger = { warn: () => {}, info: () => {} }

const fakePrompt = () => 'fake-prompt'

describe('classifyReplyWithLLM — regex confident', () => {
  it('does NOT call LLM when regex confidence ≥ LLM_TRIGGER_THRESHOLD', async () => {
    const client = mockClient({ ok: true, classification: 'negative', confidence: 0.99, rationale: 'x' })
    // Strong positive — "máme na prodej Hitachi ZX 130" → confidence ~0.95
    const r = await classifyReplyWithLLM(
      'Máme na prodej Hitachi ZX 130, kontaktujte mě.',
      'Re: poptávka',
      'a@b.cz',
      { llmClient: client, buildPrompt: fakePrompt, logger: silentLogger },
    )
    expect(client.callLlmRunnerClassify).not.toHaveBeenCalled()
    expect(r.classification).toBe('positive')
    expect(r.confidence).toBeGreaterThanOrEqual(LLM_TRIGGER_THRESHOLD)
    expect(r.reasoning.classifier_version).toBe(CLASSIFIER_VERSION)
    expect(r.llm_invoked).toBe(false)
    expect(r.stages).toHaveLength(1)
  })
})

describe('classifyReplyWithLLM — LLM wins', () => {
  it('uses LLM verdict when regex is low-conf and LLM strictly more confident', async () => {
    const client = mockClient({
      ok: true,
      classification: 'positive',
      confidence: 0.92,
      rationale: 'odesilatel popisuje stroj k prodeji',
    })
    // Ambiguous body — no selling/negation/brand/machine regex hits → fallback (0.3).
    const r = await classifyReplyWithLLM(
      'Dobrý den, ozvu se vám dnes večer.',
      'Re: poptávka',
      'a@b.cz',
      { llmClient: client, buildPrompt: fakePrompt, logger: silentLogger },
    )
    expect(client.callLlmRunnerClassify).toHaveBeenCalledTimes(1)
    expect(r.classification).toBe('positive')
    expect(r.confidence).toBe(0.92)
    expect(r.reasoning.classifier_version).toBe(LLM_CLASSIFIER_VERSION)
    expect(r.stages).toHaveLength(2)
    expect(r.stages[0].version).toBe(CLASSIFIER_VERSION)
    expect(r.stages[1].version).toBe(LLM_CLASSIFIER_VERSION)
    expect(r.llm_invoked).toBe(true)
  })
})

describe('classifyReplyWithLLM — LLM uncertain', () => {
  it('keeps regex when LLM confidence below LLM_MIN_CONFIDENCE floor', async () => {
    const client = mockClient({
      ok: true,
      classification: 'positive',
      confidence: 0.3, // below 0.5 floor
      rationale: 'guess',
    })
    const r = await classifyReplyWithLLM(
      'Dobrý den, prosím o detaily.',
      'Re: poptávka',
      'a@b.cz',
      { llmClient: client, buildPrompt: fakePrompt, logger: silentLogger },
    )
    expect(client.callLlmRunnerClassify).toHaveBeenCalledTimes(1)
    // Regex would emit null/fallback (0.3) or question; either way classifier_version
    // sticks with regex_v1 because LLM was discarded.
    expect(r.reasoning.classifier_version).toBe(CLASSIFIER_VERSION)
    expect(r.llm_invoked).toBe(true)
    expect(r.stages).toHaveLength(2)
  })
})

describe('classifyReplyWithLLM — LLM fails', () => {
  it('falls back to regex when LLM client returns ok=false', async () => {
    const client = mockClient({ ok: false, reason: 'timeout' })
    const r = await classifyReplyWithLLM(
      'Možná. Asi se vrátím k tomu.',
      'Re: poptávka',
      'a@b.cz',
      { llmClient: client, buildPrompt: fakePrompt, logger: silentLogger },
    )
    expect(r.reasoning.classifier_version).toBe(CLASSIFIER_VERSION)
    expect(r.llm_error).toBe('timeout')
    expect(r.reasoning.llm_error).toBe('timeout')
    expect(r.stages).toHaveLength(2)
    expect(r.stages[1].error).toBe('timeout')
  })

  it('records LLM stage as error when client throws', async () => {
    const client = {
      callLlmRunnerClassify: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    }
    const r = await classifyReplyWithLLM(
      'Možná. Asi se vrátím k tomu.',
      'Re: poptávka',
      'a@b.cz',
      { llmClient: client, buildPrompt: fakePrompt, logger: silentLogger },
    )
    expect(r.llm_error).toBe('ECONNREFUSED')
    expect(r.reasoning.classifier_version).toBe(CLASSIFIER_VERSION)
  })
})

describe('classifyReplyWithLLM — LLM equal confidence', () => {
  it('keeps regex when LLM confidence equals regex confidence (LLM must be strictly higher)', async () => {
    const client = mockClient({
      ok: true,
      classification: 'positive', // different from regex fallback null
      confidence: 0.65, // above floor, but matches regex question/fallback range
      rationale: 'r',
    })
    // Short question — regex returns 'question' at confidence 0.65
    const r = await classifyReplyWithLLM(
      'Kolik to bude stát?',
      'Re: poptávka',
      'a@b.cz',
      { llmClient: client, buildPrompt: fakePrompt, logger: silentLogger },
    )
    expect(client.callLlmRunnerClassify).toHaveBeenCalledTimes(1)
    // Regex classified as question with 0.65. LLM at 0.65 → not strictly higher → regex stays.
    expect(r.classification).toBe('question')
    expect(r.reasoning.classifier_version).toBe(CLASSIFIER_VERSION)
    // The LLM alternative is recorded for audit.
    expect(r.reasoning.llm_alternative?.classification).toBe('positive')
  })
})
