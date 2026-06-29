import * as cheerio from 'cheerio';
import { OpenAI } from 'openai';
import fs from 'fs';

export class CheerioCompiler {
  static async compile(html: string, url: string): Promise<string> {
    console.log(`[ParserCompiler] Spouštím LLM kognici pro pochopení struktury: ${url}`);
    
    const apiKey = process.env.RUNPOD_API_KEY || process.env.OPENAI_API_KEY || 'sk-dummy';
    let baseURL = process.env.RUNPOD_URL || process.env.OLLAMA_URL;
    if (!baseURL && fs.existsSync('/tmp/runpod_llm_url')) {
      baseURL = fs.readFileSync('/tmp/runpod_llm_url', 'utf-8').trim();
      if (!baseURL.endsWith('/v1')) baseURL += '/v1';
    }
    const modelName = process.env.LLM_MODEL || (baseURL?.includes('runpod') ? 'qwen2.5:14b-instruct' : 'gpt-4o-mini');
    const openai = new OpenAI({ apiKey, baseURL });
    
    const $ = cheerio.load(html);
    $('script, style, noscript, svg, footer, nav, iframe, img, path').remove();
    const cleanHtml = $('body').html()?.substring(0, 25000) || '';

    const prompt = `Zde je ukázka HTML ze stránky.
Napiš přesný JS kód (POUZE JS KÓD), který pomocí knihovny Cheerio ($) extrahuje pole inzerátů. Objekt bude mít klíče: id, title, make, model, price (jako číslo), sourceUrl.
Odpověz JEN JavaScriptovým kódem bez backticků (\`\`\`), formátovaným jako pole. Nepiš vůbec nic jiného, ani slovo javascript.
KRITICKÁ PRAVIDLA:
1. Používej volitelné řetězení (?.), attr('href') může vrátit undefined. 
2. NIKDY nepoužívej funkci .match() u zjišťování ceny. Použij pouze .text().replace(/\\D/g, '').
3. Pro vlastnosti 'make' a 'model' klidně rozštěp titulek (např. title.split(' ')[0] pro make, atd.).
4. Jsi v Node.js prostředí, nemáš k dispozici window, location, ani document.
Příklad čistého a bezpečného výstupu:
$('.trida-inzeratu').map((i, el) => { const href = $(el).find('a').attr('href'); const title = $(el).find('.nadpis').text().trim(); return { id: $(el).attr('data-id') || href?.replace(/\\D/g,'') || '', title, make: title.split(' ')[0] || '', model: title.split(' ')[1] || '', price: parseInt($(el).find('.cena').text().replace(/\\D/g,'')) || 0, sourceUrl: href || '' }; }).get()
`;

   const res = await openai.chat.completions.create({
     model: modelName,
     messages: [
         { role: 'system', content: 'Jsi kódový kompilátor. Vracíš POUZE surový JavaScript kód pro cheerio, nic jiného.' },
         { role: 'user', content: prompt + '\n\nHTML:\n' + cleanHtml }
     ]
   });

   let code = res.choices[0]?.message?.content || '';
   code = code.replace(/```javascript/gi, '').replace(/```js/gi, '').replace(/```/g, '').trim();
   console.log(`[ParserCompiler] Pravidlo úspěšně vygenerováno.`);
   return code;
  }
}
