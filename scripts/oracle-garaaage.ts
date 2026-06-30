/**
 * Empirický kill-gate pro P2: rekonstrukce STRUKTURY proti zlatému orákulu garaaage-auction.
 *
 * garaaage má 101 ručně autorovaných `vektor.json` (100% story coverage). Ukládá `role` (stage/
 * primary/supporting/internal/voice) — to je nezávisle ověřitelné. Osu neukládá (je v cestě).
 *
 * Měříme HONESTLY:
 *   1) discovery (manifest): kolik uzlů deriver najde (sanity, čekáme 101)
 *   2) role accuracy: derivovaná role vs gold uložená role (kvalita deterministiky)
 *   3) heuristic recall: bez manifestů — kolik z 101 gold dirů heuristika obnoví
 *
 * Spuštění:  npx ts-node --transpile-only scripts/oracle-garaaage.ts [cesta-ke-garaaage]
 */
import * as fs from 'fs';
import * as path from 'path';
import { crawlNodes, deriveAxis, BIG_FIVE } from '../src/derive/structure';

const GARAAAGE = process.argv[2] || '/home/dkrul/Projects/garaaage-auction';

const listGold = (root: string): Map<string, { role: string; pillar: string; hasStory: boolean }> => {
  const gold = new Map<string, { role: string; pillar: string; hasStory: boolean }>();
  const rec = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) rec(full);
      else if (e.name === 'vektor.json') {
        const rel = path.relative(root, dir).split(path.sep).join('/');
        try {
          const m = JSON.parse(fs.readFileSync(full, 'utf-8'));
          gold.set(rel, {
            role: m.role ?? '∅',
            pillar: m.pillar ?? '∅',
            hasStory: Boolean(m.loreLine && m.promise),
          });
        } catch {
          /* ignore */
        }
      }
    }
  };
  rec(root);
  return gold;
};

const pct = (n: number, d: number) => (d ? ((n / d) * 100).toFixed(1) : '0.0') + '%';

const main = () => {
  if (!fs.existsSync(GARAAAGE)) {
    console.error(`✗ garaaage nenalezen: ${GARAAAGE}`);
    process.exit(2);
  }
  const gold = listGold(GARAAAGE);
  console.log(`\n=== ORACLE: garaaage-auction (${GARAAAGE}) ===`);
  console.log(`Gold uzlů (vektor.json): ${gold.size}`);

  // 1) discovery (manifest)
  const derived = crawlNodes(GARAAAGE, { nodeStrategy: 'manifest' });
  console.log(`\n[1] Discovery (manifest): deriver našel ${derived.length} uzlů (gold ${gold.size})`);

  // 2) role accuracy
  const byPath = new Map(derived.map((n) => [n.path, n]));
  let matched = 0;
  let roleOk = 0;
  const confusion = new Map<string, Map<string, number>>(); // gold → derived → count
  for (const [rel, g] of gold) {
    const d = byPath.get(rel);
    if (!d) continue;
    matched += 1;
    if (d.role === g.role) roleOk += 1;
    const inner = confusion.get(g.role) ?? new Map();
    inner.set(d.role, (inner.get(d.role) ?? 0) + 1);
    confusion.set(g.role, inner);
  }
  console.log(`\n[2] Role accuracy (matched ${matched}/${gold.size}): ${roleOk}/${matched} = ${pct(roleOk, matched)}`);
  console.log('    Confusion (gold → derived):');
  for (const [gr, inner] of [...confusion.entries()].sort()) {
    const parts = [...inner.entries()].map(([dr, c]) => `${dr}:${c}`).join('  ');
    console.log(`      ${gr.padEnd(12)} → ${parts}`);
  }

  // axis distribuce (sanity — osa se v garaaage neukládá, jen ukazujeme rozložení)
  const axisDist = new Map<string, number>();
  for (const d of derived) axisDist.set(d.story_axis, (axisDist.get(d.story_axis) ?? 0) + 1);
  console.log(`\n[axis] Derivovaná distribuce os: ${[...axisDist.entries()].map(([a, c]) => `${a}:${c}`).join('  ')}`);

  // 3) heuristic recall (bez manifestů)
  const heur = crawlNodes(GARAAAGE, { nodeStrategy: 'heuristic' });
  const heurDirs = new Set(heur.map((n) => n.path));
  let recovered = 0;
  for (const rel of gold.keys()) {
    if (heurDirs.has(rel)) recovered += 1;
  }
  console.log(`\n[3] Heuristic discovery: ${heur.length} kandidátních uzlů; recall gold dirů = ${recovered}/${gold.size} = ${pct(recovered, gold.size)}`);

  // verdikt
  const discoveryOk = derived.length === gold.size;
  console.log(`\n=== VERDIKT ===`);
  console.log(`  discovery(manifest)=${gold.size} uzlů: ${discoveryOk ? 'OK' : 'MISMATCH'}`);
  console.log(`  role accuracy: ${pct(roleOk, matched)}  ${roleOk / matched >= 0.9 ? '(≥90% ✅)' : '(< 90% — viz P4 pro role→LLM)'}`);
  console.log('');
  void deriveAxis;
  void BIG_FIVE;
};

main();
