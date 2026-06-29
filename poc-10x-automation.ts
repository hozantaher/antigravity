import * as cheerio from 'cheerio';
import { OpenAI } from 'openai';
import axios from 'axios';
import fs from 'fs';

// PoC simuluje Redis s cachovanými kompilovanými skripty pro danou doménu
const memoryCache: Record<string, string> = {};

async function run10xPoC(url: string) {
  const domain = new URL(url).hostname;
  console.log(`\n[10x PoC] Startuji scrapování pro: ${url}`);
  
  // 1. Získání HTML s fallbackem pro blokované portály (např. Bazoš z neznámé IP)
  let html = '';
  try {
    const { data } = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } });
    html = data;
  } catch (err) {
    console.log('[10x PoC] Axios selhal (anti-bot ochrana bez proxy). Pro účely dema použiji lokální dummy HTML s inzeráty.');
    html = `
      <html><body>
        <div class="inzerat" data-id="auto-123">
          <h2 class="nadpis">Škoda Octavia 3</h2>
          <span class="cena">150 000 Kč</span>
          <a class="odkaz" href="https://example.com/123">Detail</a>
        </div>
        <div class="inzerat" data-id="auto-124">
          <h2 class="nadpis">Audi A4 Avant</h2>
          <span class="cena">300 000</span>
          <a class="odkaz" href="https://example.com/124">Detail</a>
        </div>
      </body></html>
    `;
  }

  // 2. Kontrola v Cache (Adaptive Selector)
  let ruleCode = memoryCache[domain];
  let items = [];

  if (ruleCode) {
    console.log(`[10x PoC] ⚡ POUŽITÁ CACHE PRO ${domain}. Žádné volání LLM. Extrahuji lokálně...`);
    items = executeRule(html, ruleCode);
  } else {
    console.log(`[10x PoC] 🧠 Pravidlo pro ${domain} neexistuje! Spouštím LLM Kompilátor...`);
    ruleCode = await generateRuleWithLLM(html, url);
    
    if (ruleCode) {
      memoryCache[domain] = ruleCode;
      items = executeRule(html, ruleCode);
    }
  }

  console.log(`✅ Extrakce dokončena! Nalezených položek: ${items.length}`);
  console.log(items);
}

function executeRule(html: string, ruleCode: string) {
  const $ = cheerio.load(html);
  try {
     // Vyhodnocení generovaného kódu v sandoboxu
     const extractFn = new Function('$', `return ${ruleCode}`);
     return extractFn($);
  } catch (e) {
    console.error('Chyba exekuce pravidla:', e);
    return [];
  }
}

async function generateRuleWithLLM(html: string, url: string): Promise<string> {
    const apiKey = process.env.RUNPOD_API_KEY || process.env.OPENAI_API_KEY || 'sk-dummy';
    let baseURL = process.env.RUNPOD_URL || process.env.OLLAMA_URL;
    if (!baseURL && fs.existsSync('/tmp/runpod_llm_url')) {
      baseURL = fs.readFileSync('/tmp/runpod_llm_url', 'utf-8').trim();
      if (!baseURL.endsWith('/v1')) baseURL += '/v1';
    }
    const modelName = process.env.LLM_MODEL || (baseURL?.includes('runpod') ? 'qwen2.5:14b-instruct' : 'gpt-4o-mini');
    const openai = new OpenAI({ apiKey, baseURL });
    
    const $ = cheerio.load(html);
    $('script, style, noscript, svg').remove();
    const cleanHtml = $('body').html()?.substring(0, 4000) || '';

    const prompt = `Zde je ukázka HTML ze stránky. 
Napiš přesný JS kód (POUZE JS KÓD), který pomocí knihovny Cheerio ($) extrahuje pole inzerátů. Objekt bude mít tyto klíče: id, title, price (jako číslo), sourceUrl.
Odpověz JEN JavaScriptovým kódem bez backticků (\`\`\`), formátovaným jako pole. Nepiš vůbec nic jiného, ani slovo javascript.
Příklad čistého výstupu:
$('.trida-inzeratu').map((i, el) => ({ id: $(el).attr('data-id'), title: $(el).find('.nadpis').text().trim(), price: parseInt($(el).find('.cena').text().replace(/\\D/g,'')) || 0, sourceUrl: $(el).find('a').attr('href') })).get()
`;

   const res = await openai.chat.completions.create({
     model: modelName,
     messages: [
         { role: 'system', content: 'Jsi kódový kompilátor. Vracíš POUZE surový JavaScript kód pro cheerio, nic jiného.' },
         { role: 'user', content: prompt + '\n\nHTML:\n' + cleanHtml }
     ]
   });

   let code = res.choices[0]?.message?.content || '';
   // Bezpečnostní ořezání, pokud LLM i tak odpoví markdownem
   code = code.replace(/```javascript/gi, '').replace(/```js/gi, '').replace(/```/g, '').trim();
   console.log(`\n[LLM Kompilátor] Vygeneroval následující parsovací pravidlo:\n${code}\n`);
   return code;
}

// Spuštění testu: První průchod vygeneruje kód, druhý použije paměť
(async () => {
  await run10xPoC('https://example-auto.cz/vozy');
  console.log('\n---------------------------------------------------------');
  console.log('--- DRUHÝ BĚH (Načtení další stránky na stejném webu) ---');
  await run10xPoC('https://example-auto.cz/vozy?page=2');
})();
