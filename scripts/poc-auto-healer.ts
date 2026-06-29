import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

console.log('=== ZAHÁJENÍ POC: AUTO-HEALER (Self-Healing Architecture) ===');

// 1. Založíme umělý problém (Contract Drift)
const badFilePath = 'spine/demand/search/poc-logic.ts';
fs.mkdirSync(path.dirname(badFilePath), { recursive: true });
fs.writeFileSync(badFilePath, `import { secretLogic } from '../../sale/demo-invoicing/demo-invoicing.vue';\nconsole.log(secretLogic);`, 'utf8');

// Namapujeme ho do existujícího vektor.json, aby nespadl na Unmapped File
const manifestPath = 'spine/demand/search/vektor.json';
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (!manifest.facets.logic) manifest.facets.logic = [];
manifest.facets.logic.push('./poc-logic.ts');
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

console.log('1. Vývojář vytvořil ilegální závislost (Contract Drift).');

// 2. Spustíme Governor, který to odchytí
let governorOutput = '';
try {
  console.log('2. Spouštím CI/CD Governor...');
  execSync('npm run ag:audit', { encoding: 'utf8', stdio: 'pipe' });
} catch (e: any) {
  governorOutput = e.stdout;
}

if (!governorOutput.includes('Contract Drift')) {
  console.log('Chyba: Governor drift nezachytil!');
  process.exit(1);
}

console.log('3. Governor zachytil chybu. Namísto selhání buildu voláme Auto-Healer...');

// 3. Auto-Healer logika
const lines = governorOutput.split('\n');
let healedCount = 0;

for (const line of lines) {
  if (line.includes('Contract Drift v ')) {
    // Extrahujeme cestu k rozbitému souboru
    const match = line.match(/Contract Drift v (.*?) ->/);
    if (match && match[1]) {
      const brokenFile = match[1];
      const content = fs.readFileSync(brokenFile, 'utf8');
      
      // Najdeme ilegální import
      const importRegex = /import\s+{([^}]+)}\s+from\s+['"](.*?)['"]/;
      const importMatch = content.match(importRegex);
      
      if (importMatch) {
        const importedVars = importMatch[1].trim();
        const badPath = importMatch[2];
        
        // Zjistíme, kam to mělo správně směřovat (na veřejný kontrakt)
        // V tomto POC to natvrdo přepíšeme na 'index'
        const healedContent = content.replace(badPath, '../../sale/demo-invoicing/index');
        
        // Vytvoříme veřejný kontrakt, aby to fungovalo
        const contractPath = 'spine/sale/demo-invoicing/index.ts';
        if (!fs.existsSync(contractPath)) {
          fs.writeFileSync(contractPath, `// AUTO-HEALED CONTRACT\nexport const ${importedVars} = 'HEALED';\n`, 'utf8');
          
          // Zmapujeme do vektor.json
          const dManifestPath = 'spine/sale/demo-invoicing/vektor.json';
          const dManifest = JSON.parse(fs.readFileSync(dManifestPath, 'utf8'));
          if (!dManifest.facets.contract) dManifest.facets.contract = [];
          dManifest.facets.contract.push('./index.ts');
          fs.writeFileSync(dManifestPath, JSON.stringify(dManifest, null, 2), 'utf8');
        }
        
        // Zapíšeme opravený soubor
        fs.writeFileSync(brokenFile, healedContent, 'utf8');
        healedCount++;
        console.log(` -> HEALED: Soubor ${brokenFile} byl automaticky opraven a import přesměrován na veřejný kontrakt!`);
      }
    }
  }
}

// 4. Ověříme, že je systém čistý
try {
  console.log('\n4. Kontrolní spuštění Governora po automatické opravě...');
  execSync('npm run ag:audit', { encoding: 'utf8', stdio: 'pipe' });
  console.log('✅ ÚSPĚCH: Build prošel! Architektura se sama opravila a technologický dluh byl zlikvidován bez zásahu člověka.');
} catch (e) {
  console.log('❌ Selhání opravy.');
  console.log((e as any).stdout);
}

// Úklid
fs.rmSync(badFilePath, { force: true });
manifest.facets.logic = manifest.facets.logic.filter((x:string) => x !== './poc-logic.ts');
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
fs.rmSync('spine/sale/demo-invoicing/index.ts', { force: true });

const dManifestPath = 'spine/sale/demo-invoicing/vektor.json';
const dManifest = JSON.parse(fs.readFileSync(dManifestPath, 'utf8'));
if (dManifest.facets.contract) {
  dManifest.facets.contract = dManifest.facets.contract.filter((x:string) => x !== './index.ts');
  if (dManifest.facets.contract.length === 0) delete dManifest.facets.contract;
  fs.writeFileSync(dManifestPath, JSON.stringify(dManifest, null, 2), 'utf8');
}
