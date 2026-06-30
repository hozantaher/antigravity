/**
 * Reálný kill-gate pro P4: kvalita LLM stories proti zlatému orákulu garaaage (přes živý RunPod).
 *
 * Vezme vzorek garaaage uzlů, odmaže gold narativu, nechá LLM (qwen2.5:14b na RunPodu) dopočítat
 * story z grounded bubble + severky, a porovná: pillar accuracy, role accuracy a loreLine/promise
 * vedle gold (eyeball). Cost-cap: malý vzorek (default 8 uzlů).
 *
 * Předpoklad: běžící pod (/tmp/runpod_llm_url) + RUNPOD_API_KEY v .env.
 * Spuštění:  npx ts-node --transpile-only scripts/oracle-story.ts [N] [cesta-garaaage]
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { crawlNodes } from '../src/derive/structure';
import { buildBubble } from '../src/derive/context';
import { tellStory, Severka } from '../src/derive/storyteller';
import { providerFromEnv } from '../src/llm/provider';

const N = parseInt(process.argv[2] || '8', 10);
const GARAAAGE = process.argv[3] || '/home/dkrul/Projects/garaaage-auction';

interface Gold {
  role: string;
  pillar: string;
  loreLine: string;
  promise: string;
}

const loadGold = (root: string): Map<string, Gold> => {
  const out = new Map<string, Gold>();
  const rec = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) rec(full);
      else if (e.name === 'vektor.json') {
        try {
          const m = JSON.parse(fs.readFileSync(full, 'utf-8'));
          out.set(path.relative(root, dir).split(path.sep).join('/'), {
            role: m.role ?? '∅',
            pillar: m.pillar ?? '∅',
            loreLine: m.loreLine ?? '',
            promise: m.promise ?? '',
          });
        } catch {
          /* ignore */
        }
      }
    }
  };
  rec(root);
  return out;
};

const parseSeverka = (root: string): Severka => {
  const p = path.join(root, 'docs/story.md');
  const pillars = new Set<string>(['cross']); // cross = osa-level uzel napříč sliby
  let lore = 'Projekt';
  let voice: string | undefined;
  try {
    const txt = fs.readFileSync(p, 'utf-8');
    const fm = txt.split('---')[1] || '';
    let inSmer = false;
    for (const line of fm.split('\n')) {
      if (/^\s*smer:/.test(line)) {
        inSmer = true;
        continue;
      }
      if (inSmer) {
        const m = line.match(/^\s*-\s*(.+?)\s*$/);
        if (m) {
          pillars.add(m[1]);
          continue;
        }
        if (/^\s*\w+:/.test(line)) inSmer = false;
      }
      const id = line.match(/^\s*identita:\s*"?(.+?)"?\s*$/);
      if (id) lore = id[1];
      const sm = line.match(/^\s*smysl:\s*"?(.+?)"?\s*$/);
      if (sm) lore += ' ' + sm[1];
      const hl = line.match(/^\s*hlas:\s*"?(.+?)"?\s*$/);
      if (hl) voice = hl[1];
    }
  } catch {
    /* ignore */
  }
  return { pillars: [...pillars], lore, voice };
};

const sample = <T>(arr: T[], n: number): T[] => {
  if (arr.length <= n) return arr;
  const step = arr.length / n;
  return Array.from({ length: n }, (_, i) => arr[Math.floor(i * step)]);
};

const main = async () => {
  const provider = providerFromEnv();
  console.log(`Provider: ${provider.name} (available=${provider.available})`);
  if (provider.name !== 'runpod' || !provider.available) {
    console.error('✗ RunPod provider nedostupný. Je pod nahozený (/tmp/runpod_llm_url) a RUNPOD_API_KEY v .env?');
    process.exit(2);
  }

  const gold = loadGold(GARAAAGE);
  const severka = parseSeverka(GARAAAGE);
  console.log(`Severka pillars: ${severka.pillars.join(', ')}`);
  console.log(`Severka lore: ${severka.lore.slice(0, 80)}...\n`);

  const nodes = crawlNodes(GARAAAGE, { nodeStrategy: 'manifest' });
  const byPath = new Map(nodes.map((n) => [n.path, n]));
  const goldPaths = [...gold.keys()].filter((p) => byPath.has(p)).sort();
  const chosen = sample(goldPaths, N);

  console.log(`=== STORY ORACLE: ${chosen.length} uzlů (z ${goldPaths.length}) přes ${provider.name} ===\n`);

  let pillarOk = 0;
  let roleOk = 0;
  let produced = 0;
  let grounded = 0;

  for (const rel of chosen) {
    const node = byPath.get(rel)!;
    const g = gold.get(rel)!;
    const bubble = buildBubble(node, nodes, GARAAAGE);
    const parent = rel.split('/').slice(0, -1).join('/');
    const siblings = goldPaths
      .filter((p) => p !== rel && p.split('/').slice(0, -1).join('/') === parent)
      .map((p) => ({ id: byPath.get(p)!.id, promise: gold.get(p)!.promise }));

    process.stdout.write(`• ${rel}  …`);
    let story;
    try {
      story = await tellStory(provider, bubble, severka, siblings, { timeoutMs: 120000 });
    } catch (e: any) {
      console.log(` CHYBA: ${String(e.message).slice(0, 80)}`);
      continue;
    }
    if (!story) {
      console.log(' (LLM nevrátil validní story — uzel zůstává pending)');
      continue;
    }
    produced += 1;
    if (story.grounded) grounded += 1;
    const pOk = story.pillar === g.pillar;
    const rOk = story.role === g.role;
    if (pOk) pillarOk += 1;
    if (rOk) roleOk += 1;
    console.log(` hotovo  [pillar ${story.pillar}${pOk ? '✓' : `✗(gold ${g.pillar})`} · role ${story.role}${rOk ? '✓' : `✗(gold ${g.role})`} · grounded ${story.grounded}]`);
    console.log(`    LLM   lore: ${story.loreLine}`);
    console.log(`    gold  lore: ${g.loreLine}`);
    console.log(`    LLM   prom: ${story.promise}`);
    console.log(`    gold  prom: ${g.promise}\n`);
  }

  const pct = (n: number, d: number) => (d ? ((n / d) * 100).toFixed(0) : '0') + '%';
  console.log(`=== VÝSLEDEK (n=${chosen.length}) ===`);
  console.log(`  produced (LLM dal validní story): ${produced}/${chosen.length}`);
  console.log(`  grounded (uzemněno v kódu):       ${grounded}/${produced}`);
  console.log(`  pillar accuracy vs gold:          ${pillarOk}/${produced} = ${pct(pillarOk, produced)}`);
  console.log(`  role accuracy vs gold:            ${roleOk}/${produced} = ${pct(roleOk, produced)}`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
