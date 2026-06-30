/**
 * CLI pro orchestrátor (P5). Dopočítá chybějící stories přes živý LLM provider.
 *
 *   npx ts-node --transpile-only scripts/synthesize-cli.ts <targetDir> [--limit N] [--write]
 *
 * Default = dry-run (nic nezapíše, jen ukáže vygenerované manifesty + projekci coverage).
 */
import 'dotenv/config';
import { runPipeline, loadSeverka } from '../src/derive/synthesize';
import { providerFromEnv } from '../src/llm/provider';

const args = process.argv.slice(2);
const targetDir = args.find((a) => !a.startsWith('--')) || '.';
const write = args.includes('--write');
const limitArg = args.find((a) => a.startsWith('--limit'));
const limit = limitArg ? parseInt(limitArg.split('=')[1] || args[args.indexOf(limitArg) + 1], 10) : undefined;
const concArg = args.find((a) => a.startsWith('--concurrency'));
const concurrency = concArg ? parseInt(concArg.split('=')[1] || args[args.indexOf(concArg) + 1], 10) : 4;

const main = async () => {
  const provider = providerFromEnv();
  if (provider.name === 'mock' && !args.includes('--allow-mock')) {
    console.error(
      [
        '',
        '✗ Není připojený živý LLM — provider spadl na MOCK (vrací prázdno → 0 stories, 0 zápisů).',
        '  Příčina: neběží RunPod pod (chybí /tmp/runpod_llm_url) ani RUNPOD_URL/GEMINI_API_KEY.',
        '',
        '  Oprava (provision → běh → auto-teardown jedním příkazem):',
        `     npx ts-node scripts/derive-live.ts ${targetDir} ${args.filter((a) => a.startsWith('--')).join(' ')}`.trim(),
        '',
        '  Nebo manuálně nejdřív nahoď pod:',
        '     npx ts-node scripts/setup-pod-llm.ts',
        '',
        '  (Vědomý test s mockem: přidej --allow-mock.)',
        '',
      ].join('\n'),
    );
    process.exit(2);
  }
  const severka = loadSeverka(targetDir);
  const icon = (s: string) =>
    s === 'written' || s === 'valid-dryrun' ? '✓' : s === 'no-story' ? '·' : '✗';
  console.log(`Provider: ${provider.name} (available=${provider.available})`);
  console.log(`Severka pillars: ${severka.pillars.join(', ')}`);
  console.log(
    `Target: ${targetDir}  ·  mode: ${write ? 'WRITE' : 'dry-run'}  ·  concurrency ${concurrency}${limit ? `  ·  limit ${limit}` : ''}\n`,
  );

  // Liveness probe — radši hlasitě selhat než tiše vyrobit desítky "no-story" proti mrtvému podu.
  if (provider.name !== 'mock') {
    process.stdout.write('Ověřuji LLM endpoint… ');
    try {
      const pong = await provider.complete([{ role: 'user', content: 'Odpověz jediným slovem: ok' }], {
        timeoutMs: 60000,
      });
      console.log(`živý ✓ (${pong.slice(0, 24).replace(/\s+/g, ' ').trim()})`);
    } catch (e: any) {
      console.error(
        `\n✗ LLM endpoint NEREAGUJE: ${String(e.message).slice(0, 140)}\n` +
          '  Pod nejspíš neběží / je mrtvý / inference timeoutuje. Synthézu nespouštím — končím.',
      );
      process.exit(3);
    }
  }

  const result = await runPipeline(
    targetDir,
    {
      provider,
      severka,
      write,
      limit,
      concurrency,
      onProgress: (d, total, o) => {
        const extra =
          o.status === 'invalid' && o.errors ? ` — ${o.errors[0]}` : o.pillar ? ` (${o.pillar}/${o.role})` : '';
        console.log(`[${String(d).padStart(3)}/${total}] ${icon(o.status)} ${o.path}${extra}`);
      },
    },
    {
      onPhase: (phase, info: any) => {
        if (phase === 'assess')
          console.log(
            `\n━━ FÁZE A — zaštěrkat se strukturou ━━\n  stav: ${info.state}  ·  code-uzlů: ${info.codeNodes}  ·  manifestů: ${info.manifestNodes}  ·  chybí: ${info.missing.length}`,
          );
        else if (phase === 'migrate')
          console.log(
            `\n━━ FÁZE B — změna struktury (node manifesty) ━━\n  ${write ? 'vytvořeno' : 'k vytvoření (dry-run)'}: ${info.created.length}  ·  přeskočeno (už mají manifest): ${info.skipped.length}`,
          );
        else if (phase === 'skip-migrate')
          console.log(
            `\n━━ FÁZE B — přeskočeno: projekt UŽ JE vektor-tree (${info.manifestNodes} manifestů, struktura nezměněna) ━━`,
          );
        else if (phase === 'synthesize-start') console.log('\n━━ FÁZE C — vektory + stories (LLM) ━━');
      },
    },
  );

  const rep = result.synthesis;
  // plné manifesty tiskneme jen u malého běhu (jinak zahltí); velký běh = jen progress + report
  if (rep.attempted <= 12) {
    for (const o of rep.outcomes) {
      if (!o.manifest) continue;
      const m = o.manifest;
      console.log(`\n──────── ${o.path}  [${o.status}, pillar ${o.pillar}, role ${o.role}, grounded ${o.grounded}] ────────`);
      console.log(JSON.stringify(
        {
          id: m.id, story_axis: m.story_axis, role: m.role, pillar: m.pillar, semantic_layer: m.semantic_layer,
          loreLine: m.loreLine, promise: m.promise, antiFeature: m.antiFeature,
          identita: m.identita, smysl: m.smysl, smer: m.smer, duvod: m.duvod, myslenka: m.myslenka,
        },
        null, 2,
      ));
    }
  }

  const written = rep.outcomes.filter((o) => o.status === 'written').length;
  console.log(`\n=== REPORT ===`);
  console.log(
    `  struktura:          ${result.assessment.state}${result.migration ? ` · node manifestů ${write ? 'vytvořeno' : 'navrženo'}: ${result.migration.created.length}` : ' (nezměněna)'}`,
  );
  console.log(`  uzlů celkem:        ${rep.totalNodes}`);
  console.log(`  storyless před:     ${rep.storylessBefore}`);
  console.log(`  zpracováno:         ${rep.attempted}`);
  console.log(`  validní kompletní:  ${rep.validComplete}`);
  if (write) console.log(`  ZAPSÁNO vektor.json: ${written}`);
  console.log(`  coverage:           ${(rep.coverageBefore * 100).toFixed(1)}% → ${(rep.coverageProjected * 100).toFixed(1)}%`);
  if (rep.attempted > 12) console.log('  (plné manifesty se netiskly — velký běh; mrkni do vektor.json nebo použij --limit)');
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
