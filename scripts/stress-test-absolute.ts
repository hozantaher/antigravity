import * as fs from 'fs';
import { execSync } from 'child_process';

console.log('--- ZAHÁJENÍ STRESS TESTU (Absolutní importy) ---');

const testFile = 'spine/demand/ui/FavoritesAbsolute.ts';
fs.mkdirSync('spine/demand/ui', { recursive: true });
fs.writeFileSync(testFile, `import { useInvoices } from '@/spine/sale/invoicing/logic/useInvoices';\n`, 'utf8');

const manifestPath = 'spine/demand/vektor.json';
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (!manifest.facets.logic) manifest.facets.logic = [];
manifest.facets.logic.push('./ui/FavoritesAbsolute.ts');
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

try {
  const out = execSync('npm run ag:audit', { encoding: 'utf8', stdio: 'pipe' });
  console.log('VÝSLEDEK: BUILD PROŠEL!');
  console.log('\n❌ ZÁVĚR: Governor má kritickou trhlinu! Ignoruje absolutní importy (@/spine/...), čímž lze Contract Drift obejít!');
} catch (e: any) {
  console.log('VÝSLEDEK: BUILD SELHAL (Governor to chytil!)');
  console.log(e.stdout);
}

// Úklid
fs.rmSync('spine/demand/ui', { recursive: true, force: true });
manifest.facets.logic = manifest.facets.logic.filter((x:string) => x !== './ui/FavoritesAbsolute.ts');
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
