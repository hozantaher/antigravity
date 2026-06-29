import 'dotenv/config';
import { readFile, writeFile, mkdir, readdir, access } from 'fs/promises';
import { join } from 'path';
import { parseArgs } from 'util';
import Anthropic from '@anthropic-ai/sdk';
import { createMcpClient } from './lib/mcp-client.js';
import { markdownToDocx } from './lib/docx-writer.js';

const RESEARCH_MODEL = process.env.ANTHROPIC_RESEARCH_MODEL || 'claude-sonnet-4-20250514';
const DRAFTING_MODEL = process.env.ANTHROPIC_DRAFTING_MODEL || 'claude-opus-4-20250514';
const OUTPUT_DIR = join(process.cwd(), 'output');
const RESEARCH_FILE = join(OUTPUT_DIR, 'vyzkum.md');

// --- CLI Args ---

const { values: args } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    phase: { type: 'string', default: 'all' },
  },
});

const VALID_PHASES = ['all', 'research', 'draft'] as const;
type Phase = (typeof VALID_PHASES)[number];

const phase: Phase = VALID_PHASES.includes(args.phase as Phase) ? (args.phase as Phase) : 'all';
if (args.phase && !VALID_PHASES.includes(args.phase as Phase)) {
  console.error(`Neznámá fáze: ${args.phase}. Platné: ${VALID_PHASES.join(', ')}`);
  process.exit(1);
}

// --- Vault Reader ---

const VAULT_DIRS = ['L5-Business', 'L6-Regulation', 'L7-Identity'];
const VAULT_ROOT_FILES = ['ARCHITECTURE.md', 'Index.md'];

async function readVaultFiles(vaultPath: string): Promise<string> {
  const sections: string[] = [];

  for (const file of VAULT_ROOT_FILES) {
    try {
      const content = await readFile(join(vaultPath, file), 'utf-8');
      sections.push(`## ${file}\n\n${content}`);
    } catch {
      /* skip missing */
    }
  }

  for (const dir of VAULT_DIRS) {
    const dirPath = join(vaultPath, dir);
    try {
      const entries = await readdir(dirPath, { recursive: true });
      for (const entry of entries) {
        const file = String(entry);
        if (!file.endsWith('.md')) continue;
        try {
          const content = await readFile(join(dirPath, file), 'utf-8');
          sections.push(`## ${dir}/${file}\n\n${content}`);
        } catch {
          /* skip unreadable */
        }
      }
    } catch {
      /* skip missing dir */
    }
  }

  return sections.join('\n\n---\n\n');
}

// --- System Prompts ---

function buildResearchPrompt(vaultContext: string): string {
  return `Jsi právní výzkumník specializovaný na české obchodní právo, e-commerce a B2B marketplace regulaci.

Tvým úkolem je provést důkladný výzkum české legislativy a judikatury pro přípravu Obchodních podmínek (OP) B2B online tržiště pro prodej použitých těžkých strojů a vozidel.

## Popis platformy

${vaultContext}

## Dostupné nástroje

Máš přístup k nástroji \`query\`, který dotazuje SQLite databáze. NEVOLEJ get_schema ani get_stats — schémata jsou uvedena níže.

Nástroj \`query\` má parametry:
- \`source\` (povinný) — vybírá databázi: \`"judikaty"\` nebo \`"esbirka"\`
- \`sql\` (povinný) — SELECT dotaz
- \`limit\` (volitelný) — max počet řádků

### judikaty — Česká judikatura (685K rozhodnutí ze 4 zdrojů)
Databáze rozhodnutí českých soudů. FTS5 index prohledává vyrok + pravni_veta + metadata napříč VŠEMI zdroji.

| source | počet | pravni_veta | vyrok | oduvodneni | vhodné pro |
|--------|-------|-------------|-------|------------|------------|
| nsoud  | 9.7K  | ANO         | —     | 3.7K       | Civilní a obchodní právo |
| usoud  | 107K  | —           | 83K   | 101K       | Ústavní práva, základní svobody |
| nssoud | 990   | —           | 961   | 990        | Správní právo |
| justice| 567K  | —           | 566K  | 565K       | Okresní soudy (bez spis. značky) |

**Tabulka \`decisions\`:**
- spisova_znacka, soud, source, datum_vydani, typ_rozhodnuti
- oblast_prava, predmet_rizeni, klicova_slova, zminena_ustanoveni
- pravni_veta — stručné shrnutí (jen nsoud)
- vyrok — výrok rozhodnutí (usoud, nssoud, justice)
- oduvodneni — plné odůvodnění (velké, vždy substr + LIMIT)

**Příklady — hledej napříč všemi zdroji:**
\`\`\`
query(source="judikaty", sql="SELECT spisova_znacka, soud, datum_vydani, substr(pravni_veta, 1, 500) as pv FROM decisions WHERE source = 'nsoud' AND pravni_veta LIKE '%zprostředkov%' LIMIT 10")
query(source="judikaty", sql="SELECT spisova_znacka, soud, substr(vyrok, 1, 500) as vyrok FROM decisions WHERE source = 'usoud' AND predmet_rizeni LIKE '%vlastn%' LIMIT 10")
query(source="judikaty", sql="SELECT spisova_znacka, soud, substr(vyrok, 1, 500) as vyrok FROM decisions WHERE vyrok LIKE '%odpovědnost%' AND source IN ('nsoud','usoud','nssoud') LIMIT 10")
query(source="judikaty", sql="SELECT spisova_znacka, soud, datum_vydani, substr(pravni_veta, 1, 500) as pv FROM decisions WHERE source = 'nsoud' AND (pravni_veta LIKE '%jak stojí a leží%' OR pravni_veta LIKE '%vady věci%') LIMIT 10")
query(source="judikaty", sql="SELECT spisova_znacka, soud, datum_vydani, substr(pravni_veta, 1, 500) as pv FROM decisions WHERE source = 'nsoud' AND pravni_veta LIKE '%dražb%' LIMIT 10")
\`\`\`

### esbirka — Česká legislativa (eSbírka zákonů)
Databáze českých zákonů a předpisů.

**Tabulka \`acts\`:**
- eli TEXT — European Legislation Identifier (unikátní)
- citace TEXT — citace předpisu (např. "89/2012 Sb.")
- nazev TEXT — název předpisu
- typ_aktu TEXT — typ (zákon, vyhláška, nařízení...)
- typ_zneni TEXT — typ znění
- datum_platnosti TEXT — datum platnosti
- datum_zruseni TEXT — datum zrušení (NULL = platný)
- full_text TEXT — plný text předpisu (velký, vždy omez LIMIT a sloupce)

**Příklady:**
\`\`\`
query(source="esbirka", sql="SELECT citace, nazev, typ_aktu FROM acts WHERE citace LIKE '%89/2012%' LIMIT 5")
query(source="esbirka", sql="SELECT substr(full_text, 1, 5000) as ukazka FROM acts WHERE citace = '89/2012 Sb.' AND full_text LIKE '%2445%' LIMIT 1")
\`\`\`

**Důležité:** Sloupce \`full_text\` (esbirka) a \`oduvodneni\` (judikaty) jsou velké. Vždy použij \`substr()\` nebo specifické \`WHERE\` filtry a nízký \`LIMIT\`.

## Co musíš prozkoumat

Proveď alespoň 3-5 dotazů na každý zdroj. Zaměř se na:

### Legislativa (source="esbirka")
- § 2445-2454 OZ (zprostředkování)
- § 1751-1756 OZ (obchodní podmínky)
- § 2012+ OZ (jistota/kauce)
- § 1771-1772 OZ (veřejná soutěž — pro odlišení od aukce)
- § 1918 OZ (as-is prodej, jak stojí a leží)
- § 2914 OZ (odpovědnost za pomocníka)
- § 1810+ OZ (spotřebitelské smlouvy — pro vyloučení B2C)
- Zákon č. 253/2008 Sb. (AML)
- Zákon č. 110/2019 Sb. (ochrana osobních údajů)
- Zákon č. 634/1992 Sb. (ochrana spotřebitele)

### Judikatura (source="judikaty")
- Zprostředkovatelské smlouvy — odlišení od komisionářské
- Online aukce vs. veřejná dražba (§ 1771-1772 vs. zákon č. 26/2000 Sb.)
- Limitace odpovědnosti v B2B kontextu
- Prodej "jak stojí a leží" a vzdání se práv z vad
- Escrow/úschova a odpovědnost za svěřené prostředky
- Smluvní pokuta a kauce

## Formát výstupu

Až dokončíš výzkum, vytvoř strukturovaný souhrn svých nálezů v tomto formátu:

### LEGISLATIVA
Pro každý relevantní paragraf/zákon:
- Přesná citace nebo parafráze klíčového ustanovení
- Jak se vztahuje k platformě Garaaage

### JUDIKATURA
Pro každé relevantní rozhodnutí:
- Spisová značka, soud, datum
- Klíčový právní závěr (ratio decidendi)
- Aplikace na kontext Garaaage

### DOPORUČENÍ PRO OP
- Konkrétní body, které musí OP obsahovat na základě zjištěné legislativy a judikatury
- Rizika a jak je OP adresovat`;
}

function buildDraftingPrompt(vaultContext: string): string {
  return `Jsi expert na české obchodní právo, specializace na e-commerce, zprostředkovatelské smlouvy (§ 2445+ OZ) a B2B marketplace regulaci.

Tvým úkolem je vytvořit kompletní, production-ready "Obchodní podmínky" (OP) pro platformu Garaaage — B2B online tržiště pro prodej použitých těžkých strojů a vozidel.

## Identifikace platformy

- Název: Garaaage
- Provozovatel: [DOPLNÍ PRÁVNÍK — obchodní firma, IČO, sídlo]
- URL: https://garaaage.com a https://garaaage.cz
- Kontakt: [DOPLNÍ PRÁVNÍK — e-mail, telefon]

## Popis platformy

${vaultContext}

## Požadavky na OP

1. Piš formální českou právní češtinou
2. Dodržuj 13-sekční strukturu z Dok-01-OP (obsaženo v popisu platformy)
3. Odkazuj na konkrétní §§ zákonů (přesná čísla paragrafů)
4. Používej VÝHRADNĚ schválenou terminologii (viz Legal-Terminology.md):
   - Aukce (NE dražba)
   - Zavazujeme se k profesionálnímu provedení (NE garantujeme)
   - Vizuální dokumentace (NE ověření/kontrola)
   - Odměna za zprostředkování (NE provize)
   - Komunikační služba (NE garanční program)
5. Dokument musí být kompletní — žádné placeholdery, žádné [DOPLNIT]
6. Na KONEC dokumentu přidej disclaimer:

---
**Upozornění:** Tento dokument byl vygenerován s využitím umělé inteligence na základě databáze české legislativy a judikatury. Nejedná se o právní poradenství. Před použitím je nezbytná revize kvalifikovaným advokátem. Data v databázi jsou platná ke dni posledního scrape a nemusí reflektovat nejnovější legislativní změny.
---

## Formát výstupu — Markdown

- \`#\` pro název dokumentu
- \`##\` pro hlavní sekce (1-13)
- \`###\` pro podsekce
- Číslované články uvnitř sekcí
- Křížové odkazy mezi sekcemi kde je to vhodné

Na výstupu bude text Obchodních podmínek + disclaimer na konci. Žádný úvod ani vysvětlení.`;
}

// --- Research Phase ---

const MIN_RESEARCH_LENGTH = 500;
const MAX_TOOL_RESULT_PER_CALL = 8_000;
const RESEARCH_ITERATIONS_ESBIRKA = 7;
const RESEARCH_ITERATIONS_JUDIKATY = 6;

async function runResearchPhase(
  anthropic: Anthropic,
  systemPrompt: string,
  tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>,
  callTool: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>,
  sourceLabel: string,
  userMessage: string,
  maxIterations: number,
): Promise<string> {
  type MessageParam = { role: 'user' | 'assistant'; content: unknown };
  const messages: MessageParam[] = [{ role: 'user', content: userMessage }];

  // Tool-use loop — let Sonnet research freely
  const collectedData: string[] = [];

  for (let i = 0; i < maxIterations; i++) {
    const params: Record<string, unknown> = {
      model: RESEARCH_MODEL,
      max_tokens: 16384,
      temperature: 0,
      system: systemPrompt,
      messages,
      tools,
    };

    console.log(`[${sourceLabel} ${i + 1}/${maxIterations}] Volám ${RESEARCH_MODEL}...`);

    const response = (await anthropic.messages.create(
      params as unknown as Parameters<typeof anthropic.messages.create>[0],
    )) as {
      stop_reason: string;
      content: Array<{ type: string; id?: string; name?: string; input?: unknown; text?: string }>;
    };

    console.log(`  stop_reason=${response.stop_reason}, bloků=${response.content.length}`);

    // Model finished research on its own
    if (response.stop_reason === 'end_turn') {
      const textBlock = response.content.find((b) => b.type === 'text');
      if (textBlock?.text && textBlock.text.length >= MIN_RESEARCH_LENGTH) {
        return textBlock.text;
      }
      // Too short — fall through to summarization
      break;
    }

    if (response.stop_reason === 'tool_use') {
      const toolBlocks = response.content.filter((b) => b.type === 'tool_use');

      const toolResults = await Promise.all(
        toolBlocks.map(async (block) => {
          const inputPreview = JSON.stringify(block.input).slice(0, 150);
          console.log(`  Nástroj: ${block.name}(${inputPreview})`);
          try {
            const result = await callTool(block.name!, block.input as Record<string, unknown>);
            let text = result.content
              .filter((c): c is { type: string; text: string } => c.type === 'text')
              .map((c) => c.text)
              .join('\n');

            if (text.length > MAX_TOOL_RESULT_PER_CALL) {
              text = text.slice(0, MAX_TOOL_RESULT_PER_CALL) + '\n... (zkráceno, upřesni dotaz)';
            }

            collectedData.push(`[${block.name}] ${JSON.stringify(block.input)}\n${text}`);

            return {
              type: 'tool_result' as const,
              tool_use_id: block.id,
              content: text,
              is_error: result.isError || false,
            };
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`  Chyba nástroje: ${msg}`);
            return {
              type: 'tool_result' as const,
              tool_use_id: block.id,
              content: `MCP chyba: ${msg}`,
              is_error: true,
            };
          }
        }),
      );

      messages.push({ role: 'assistant', content: toolBlocks });
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    // max_tokens or unexpected
    break;
  }

  // Separate summarization call with collected data (clean context)
  console.log(`  Sumarizuji ${sourceLabel} (${collectedData.length} dotazů)...`);

  const summaryData = collectedData.join('\n\n---\n\n').slice(0, 60_000);

  const summaryResponse = (await anthropic.messages.create({
    model: RESEARCH_MODEL,
    max_tokens: 8192,
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: `Následují výsledky dotazů do databáze (${sourceLabel}). Vytvoř podrobný strukturovaný souhrn všech nálezů. Pro každý relevantní nález uveď přesnou citaci, zdroj a aplikaci na B2B marketplace pro těžké stroje.

${summaryData}

Vytvoř nyní kompletní souhrn.`,
      },
    ],
  } as Parameters<typeof anthropic.messages.create>[0])) as {
    stop_reason: string;
    content: Array<{ type: string; text?: string }>;
  };

  const textBlock = summaryResponse.content.find((b) => b.type === 'text');
  if (!textBlock?.text) {
    throw new Error(`${sourceLabel}: summarization returned no text`);
  }

  return textBlock.text;
}

async function runResearch(
  anthropic: Anthropic,
  systemPrompt: string,
  tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>,
  callTool: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>,
): Promise<string> {
  console.log(`\n=== FÁZE 1: Výzkum (${RESEARCH_MODEL}) ===\n`);

  // Sub-phase 1a: eSbírka (laws)
  console.log('--- 1a: Legislativa (esbirka) ---\n');
  const esbirkaResult = await runResearchPhase(
    anthropic,
    systemPrompt,
    tools,
    callTool,
    'Legislativa',
    `Prozkoumej českou legislativu relevantní pro Obchodní podmínky platformy Garaaage. Používej VÝHRADNĚ source="esbirka". Zaměř se na:
- § 2445-2454 OZ (zprostředkování)
- § 1751-1756 OZ (obchodní podmínky)
- § 2012+ OZ (jistota/kauce)
- § 1771-1772 OZ (veřejná soutěž vs. aukce)
- § 1918 OZ (as-is prodej)
- § 2914 OZ (odpovědnost za pomocníka)
- Zákon č. 253/2008 Sb. (AML)
Nevolej get_schema ani get_stats.`,
    RESEARCH_ITERATIONS_ESBIRKA,
  );
  console.log(`\n  Legislativa: ${esbirkaResult.length} znaků`);

  if (esbirkaResult.length < MIN_RESEARCH_LENGTH) {
    console.error(`  VAROVÁNÍ: Výzkum legislativy je příliš krátký (${esbirkaResult.length} znaků)`);
  }

  // Sub-phase 1b: Judikatura (court decisions)
  console.log('\n--- 1b: Judikatura (judikaty) ---\n');
  const judikaturResult = await runResearchPhase(
    anthropic,
    systemPrompt,
    tools,
    callTool,
    'Judikatura',
    `Prozkoumej českou judikaturu relevantní pro Obchodní podmínky B2B marketplace. Používej VÝHRADNĚ source="judikaty".

DŮLEŽITÉ: Hledej POUZE v rozhodnutích Nejvyššího soudu (WHERE source = 'nsoud'), protože jen ty mají vyplněnou právní větu a spisovou značku. Hledej přes pravni_veta LIKE '%...%'.

Témata k vyhledání:
- Zprostředkovatelské smlouvy: pravni_veta LIKE '%zprostředkov%'
- Odpovědnost za škodu / limitace: pravni_veta LIKE '%odpovědnost%škod%'
- Prodej "jak stojí a leží" / vady: pravni_veta LIKE '%jak stojí a leží%' NEBO '%vady věci%'
- Dražby a aukce: pravni_veta LIKE '%dražb%'
- Smluvní pokuta: pravni_veta LIKE '%smluvní pokut%'
- Jistota / kauce: pravni_veta LIKE '%jistot%'
- Obchodní podmínky: pravni_veta LIKE '%obchodní podmín%'

Nevolej get_schema ani get_stats.`,
    RESEARCH_ITERATIONS_JUDIKATY,
  );
  console.log(`\n  Judikatura: ${judikaturResult.length} znaků`);

  if (judikaturResult.length < MIN_RESEARCH_LENGTH) {
    console.error(`  VAROVÁNÍ: Výzkum judikatury je příliš krátký (${judikaturResult.length} znaků)`);
  }

  // Combine
  const combined = `## LEGISLATIVA

${esbirkaResult}

## JUDIKATURA

${judikaturResult}`;

  console.log(`\n  Výzkum celkem: ${combined.length} znaků\n`);
  return combined;
}

// --- Drafting Phase ---

async function runDrafting(anthropic: Anthropic, systemPrompt: string, researchSummary: string): Promise<string> {
  console.log(`\n=== FÁZE 2: Generování OP (${DRAFTING_MODEL}) ===\n`);

  const stream = anthropic.messages.stream({
    model: DRAFTING_MODEL,
    max_tokens: 32000,
    temperature: 0,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: `Na základě následujícího právního výzkumu vytvoř kompletní Obchodní podmínky pro platformu Garaaage podle struktury z Dok-01-OP.

## Právní výzkum

${researchSummary}

Vytvoř nyní kompletní OP.`,
      },
    ],
  });

  let text = '';
  let chars = 0;

  stream.on('text', (chunk) => {
    text += chunk;
    // Progress indicator every ~2000 chars
    const newChars = Math.floor(text.length / 2000);
    if (newChars > chars) {
      chars = newChars;
      process.stdout.write(`\r  Generuji... ${text.length} znaků`);
    }
  });

  const response = await stream.finalMessage();

  console.log(`\r  stop_reason=${response.stop_reason}, vygenerováno: ${text.length} znaků`);

  if (!text) {
    throw new Error('Drafting phase returned no text');
  }

  if (response.stop_reason === 'max_tokens') {
    console.log('  VAROVÁNÍ: Výstup byl oříznut (max_tokens). Dokument může být neúplný.');
  }

  return text;
}

// --- Output ---

async function ensureOutputDir() {
  await mkdir(OUTPUT_DIR, { recursive: true });
}

async function saveResearch(researchSummary: string) {
  await ensureOutputDir();
  await writeFile(RESEARCH_FILE, researchSummary, 'utf-8');
  console.log(`  Výzkum uložen: ${RESEARCH_FILE}`);
}

async function saveDraft(markdown: string) {
  await ensureOutputDir();

  const mdPath = join(OUTPUT_DIR, 'obchodni-podminky.md');
  await writeFile(mdPath, markdown, 'utf-8');
  console.log(`  MD:   ${mdPath}`);

  try {
    const docxBuffer = await markdownToDocx(markdown, 'Obchodní podmínky platformy Garaaage');
    const docxPath = join(OUTPUT_DIR, 'obchodni-podminky.docx');
    await writeFile(docxPath, docxBuffer);
    console.log(`  DOCX: ${docxPath}`);
  } catch (e) {
    console.error(`  Chyba při generování DOCX: ${e instanceof Error ? e.message : e}`);
    console.error('  Markdown verze byla uložena úspěšně');
  }
}

// --- Main ---

async function main() {
  console.log(`Fáze: ${phase}`);

  // Validate env — MCP only needed for research
  const requiredEnv = ['ANTHROPIC_API_KEY', 'OBSIDIAN_VAULT_PATH'];
  if (phase !== 'draft') {
    requiredEnv.push('MCP_URL');
  }
  const missing = requiredEnv.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Chybí environment proměnné: ${missing.join(', ')}`);
    console.error('Zkopíruj .env.example do .env a vyplň hodnoty');
    process.exit(1);
  }

  // For draft-only, check that research exists
  if (phase === 'draft') {
    try {
      await access(RESEARCH_FILE);
    } catch {
      console.error(`Soubor ${RESEARCH_FILE} neexistuje. Nejprve spusť --phase=research`);
      process.exit(1);
    }
  }

  // Read vault
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH!;
  console.log('Načítám Obsidian vault...');
  const vaultContext = await readVaultFiles(vaultPath);
  console.log(`  Načteno ${(vaultContext.length / 1024).toFixed(0)} KB kontextu`);

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  let researchSummary: string;

  // Phase 1: Research
  if (phase === 'draft') {
    researchSummary = await readFile(RESEARCH_FILE, 'utf-8');
    console.log(`\nPoužívám existující výzkum: ${RESEARCH_FILE} (${(researchSummary.length / 1024).toFixed(0)} KB)`);
  } else {
    // Connect to MCP server
    console.log('Připojuji se k MCP serveru...');
    const mcp = createMcpClient({
      baseUrl: process.env.MCP_URL!,
      secret: process.env.MCP_SECRET,
      prefix: 'mcp',
    });

    // List tools — only expose 'query'
    let allTools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
    try {
      allTools = await mcp.listTools();
      console.log(`  Nástroje: ${allTools.map((t) => t.name).join(', ')}`);
    } catch (e) {
      console.error(`  Nelze se připojit k MCP: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    }

    const queryTools = allTools
      .filter((t) => t.name.endsWith('query'))
      .map((t) => ({
        name: t.name,
        description: t.description || '',
        input_schema: t.inputSchema,
      }));

    if (!queryTools.length) {
      console.error('  MCP server nemá nástroj "query"');
      process.exit(1);
    }
    console.log(`  Používám: ${queryTools.map((t) => t.name).join(', ')}`);

    const callTool = async (name: string, args: Record<string, unknown>) => mcp.callTool(name, args);

    const researchPrompt = buildResearchPrompt(vaultContext);
    researchSummary = await runResearch(anthropic, researchPrompt, queryTools, callTool);

    // Save research immediately — before Opus call
    console.log('\nUkládám výzkum...');
    await saveResearch(researchSummary);

    if (phase === 'research') {
      console.log('\nHotovo! Pro generování OP spusť: pnpm run generate:terms -- --phase=draft');
      return;
    }
  }

  // Phase 2: Draft
  const draftingPrompt = buildDraftingPrompt(vaultContext);
  const termsMarkdown = await runDrafting(anthropic, draftingPrompt, researchSummary);

  console.log('\nUkládám výstupy...');
  await saveDraft(termsMarkdown);

  console.log('\nHotovo!');
}

main().catch((e) => {
  console.error('Fatální chyba:', e);
  process.exit(1);
});
