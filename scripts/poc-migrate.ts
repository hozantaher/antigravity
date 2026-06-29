import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import { VektorManifest } from '../src/types';

async function runMigratePOC() {
  const rootDir = process.cwd();
  console.log('🚂 Spouštím Proof-of-Concept: Auto Lift & Shift (Batch Migration)...\n');

  // Hledáme uzly, které jsou stále v karanténě (products/)
  const legacyFiles = await glob('products/**/vektor.json', {
    cwd: rootDir,
    ignore: 'node_modules/**',
  });

  if (legacyFiles.length === 0) {
    console.log('✅ Nebyly nalezeny žádné uzly v karanténě k migraci.');
    return;
  }

  console.log(`Nalezeno ${legacyFiles.length} uzlů v Karanténě připravených k automatické migraci:\n`);

  for (const file of legacyFiles) {
    const fullPath = path.join(rootDir, file);
    try {
      const manifest = JSON.parse(fs.readFileSync(fullPath, 'utf8')) as VektorManifest;
      
      const axis = manifest.story_axis || 'unknown';
      const id = manifest.id;
      
      // Vypočteme budoucí bezpečný domov ve spine/
      const targetDir = path.join('spine', axis, id);
      
      console.log(`📦 Uzel: ${id}`);
      console.log(`   Ze staré cesty: ${path.dirname(file)}`);
      console.log(`   Do nové cesty:  ${targetDir}`);
      console.log(`   Příkaz na pozadí: refactor.executeRename('${id}', '${id}', '${targetDir}')\n`);

    } catch (e) {
      console.warn(`Nepodařilo se přečíst: ${file}`);
    }
  }

  console.log('🛠 Závěr POC: Automatická migrace dokáže hromadně vypočítat trasy přesunu bez zásahu LLM a může tak zlikvidovat celou karanténu v jediné transakci.');
}

runMigratePOC().catch(console.error);
