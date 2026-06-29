import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { globSync } from 'glob';

console.log('🐒 ZAHÁJENÍ CHAOS MONKEY STRESS TESTU (100x Architecture Resilience) 🐒');

// Záloha pro pozdější úklid
const cleanups: (() => void)[] = [];

try {
  // --- MUTACE 1: Circular Dependency (Cyklická závislost) ---
  console.log('\n[Mutace 1] Vytváření cyklické závislosti: A -> B -> A');
  const nodeAPath = 'spine/platform/chaos-a';
  const nodeBPath = 'spine/platform/chaos-b';
  
  fs.mkdirSync(nodeAPath, { recursive: true });
  fs.mkdirSync(nodeBPath, { recursive: true });
  
  fs.writeFileSync(`${nodeAPath}/vektor.json`, JSON.stringify({ id: 'chaos-a', story_axis: 'platform', facets: { logic: ['./a.ts'] } }, null, 2));
  fs.writeFileSync(`${nodeBPath}/vektor.json`, JSON.stringify({ id: 'chaos-b', story_axis: 'platform', facets: { logic: ['./b.ts'] } }, null, 2));
  
  // A linkuje na B
  fs.writeFileSync(`${nodeAPath}/a.ts`, `// @vektor-link: chaos-b\nexport const a = 1;`, 'utf8');
  // B linkuje na A (CYKLUS!)
  fs.writeFileSync(`${nodeBPath}/b.ts`, `// @vektor-link: chaos-a\nexport const b = 2;`, 'utf8');
  
  cleanups.push(() => {
    fs.rmSync(nodeAPath, { recursive: true, force: true });
    fs.rmSync(nodeBPath, { recursive: true, force: true });
  });

  // --- BĚH TESTU ---
  console.log('Spouštím Governor (ag:audit)...');
  const output = execSync('npm run ag:audit', { encoding: 'utf8', stdio: 'pipe' });
  
  console.log('\n❌ VÝSLEDEK: BUILD PROŠEL!');
  console.log('Governor nedetekoval cyklickou závislost (Circular Dependency) v architektuře!');
  console.log('To je obrovská False Negative trhlina. Architekturní strom se právě změnil v zacyklený graf a Governor to přešel bez povšimnutí.');
  
} catch (e: any) {
  console.log('\n✅ VÝSLEDEK: BUILD SELHAL (Governor zachytil chaos)');
  console.log(e.stdout);
} finally {
  console.log('\nUklízím stopy po Chaos Monkey...');
  cleanups.forEach(c => c());
}
