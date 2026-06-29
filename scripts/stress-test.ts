import * as fs from 'fs';
import { execSync } from 'child_process';

console.log('--- ZAHÁJENÍ STRESS TESTU (Vue Contract Drift) ---');

const vueFile = 'spine/demand/ui/FavoritesGrid.vue';
fs.mkdirSync('spine/demand/ui', { recursive: true });
fs.writeFileSync(vueFile, `<script setup>\nimport { useInvoices } from '../../sale/invoicing/logic/useInvoices';\n</script>`, 'utf8');

// Musíme přidat vue soubor do vektor.json aby nebyl orphan
const manifestPath = 'spine/demand/vektor.json';
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (!manifest.facets.ui) manifest.facets.ui = [];
manifest.facets.ui.push('./ui/FavoritesGrid.vue');
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

try {
  const out = execSync('npm run ag:audit', { encoding: 'utf8', stdio: 'pipe' });
  console.log('VÝSLEDEK: BUILD PROŠEL!');
  console.log('\n❌ ZÁVĚR: Governor ignoruje .vue soubory! Ilegální cross-domain import prošel bez povšimnutí!');
} catch (e: any) {
  console.log('VÝSLEDEK: BUILD SELHAL (Governor to chytil!)');
  console.log(e.stdout);
}

// Úklid
fs.rmSync('spine/demand/ui', { recursive: true, force: true });
manifest.facets.ui = manifest.facets.ui.filter((x:string) => x !== './ui/FavoritesGrid.vue');
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
