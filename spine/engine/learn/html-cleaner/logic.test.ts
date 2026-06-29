import { describe, it, expect } from 'vitest';
import { askLLMToCleanHTML } from './logic';
import { http, HttpResponse } from 'msw';
import { server } from '../../../../vitest.setup';

describe('HTML Cleaner (BRAIN Layer)', () => {
  it('PoC (Prove-of-Concept): Používá VCR Kazetu a nesahá na cizí sítě', async () => {
    // 1. Zavedeme "Kazetu" (Mock odpověď ze serveru)
    server.use(
      http.post('https://api.openai.com/v1/chat/completions', () => {
        return HttpResponse.json({
          choices: [{ message: { content: '<div>Vyčištěno bez utrácení peněz</div>' } }]
        });
      })
    );

    const result = await askLLMToCleanHTML('<div><span>Složitý DOM</span></div>');
    expect(result).toBe('<div>Vyčištěno bez utrácení peněz</div>');
  });

  it('Break-the-Concept: Pokusí se obejít kazetu a trefit reálné API OpenAI', async () => {
    // 2. Tady kazeta NENÍ zavedená. Pokud to Shield (MSW z Fáze 1) funguje správně,
    // test nesmí projít ven, ale musí spadnout.
    await expect(askLLMToCleanHTML('<div>Nějaký DOM</div>')).rejects.toThrow(/Cannot bypass a request/);
  });
});
