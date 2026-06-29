import OpenAI from 'openai';
import * as fs from 'fs';

/**
 * Kognitivní Mozek: Relay Engine
 * Vyhodnocuje nestrukturovaná data pomocí LLM.
 */
export class RelayEngine {
  private openai: OpenAI;

  constructor() {
    let baseURL = 'https://api.openai.com/v1';
    let apiKey = process.env.OPENAI_API_KEY || 'mock-key';
    
    // Hard rule: Využij RunPod LLM pokud existuje
    const runpodUrlEnv = process.env.RUNPOD_LLM_URL;
    let runpodUrlFile = '';
    try {
      runpodUrlFile = fs.readFileSync('/tmp/runpod_llm_url', 'utf-8').trim();
    } catch (e) {
      // Ignorovat, soubor neexistuje
    }

    const runpodUrl = runpodUrlEnv || runpodUrlFile;
    if (runpodUrl) {
      console.log(`[RelayEngine] Připojuji se na perzistentní RunPod LLM: ${runpodUrl}`);
      baseURL = `${runpodUrl}/v1`; // Ollama OpenAI kompatibilní endpoint
      apiKey = 'ollama'; // API key pro Ollama je libovolný string
    }

    this.openai = new OpenAI({
      baseURL,
      apiKey,
    });
  }

  public async evaluateArbitrageScore(listingTitle: string, price: number): Promise<number> {
    if (!process.env.RUNPOD_LLM_URL && !fs.existsSync('/tmp/runpod_llm_url') && (process.env.OPENAI_API_KEY === 'mock-key' || !process.env.OPENAI_API_KEY)) {
      // Mock logic pro běh bez API klíče a bez RunPodu
      const multiplier = listingTitle.toLowerCase().includes('audi') ? 1.5 : 1.1;
      return price * multiplier;
    }

    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'Jsi expert na oceňování vozů. Odpověz POUZE číslem reprezentujícím reálnou odhadovanou tržní hodnotu vozidla v CZK.' },
          { role: 'user', content: `Oceň: ${listingTitle}. Nabízená cena je ${price} CZK.` }
        ],
        temperature: 0.1,
      });

      const estimatedValue = parseInt(response.choices[0].message.content?.replace(/[^0-9]/g, '') || '0', 10);
      return estimatedValue > 0 ? estimatedValue : price;
    } catch (error) {
      console.error('[RelayEngine] LLM Evaluace selhala:', error);
      return price; // Fallback
    }
  }
}
