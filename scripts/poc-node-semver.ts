import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import { execSync } from 'child_process';

async function runNodeSemVerPOC() {
  const rootDir = process.cwd();
  console.log('🧬 Spouštím Proof-of-Concept: Autonomní Node-based SemVer (Fáze 6)...\n');

  const readmes = await glob('spine/**/README.md', {
    cwd: rootDir,
    ignore: 'node_modules/**',
  });

  if (readmes.length === 0) {
    console.log('Nebyly nalezeny žádné README.md soubory ve /spine/.');
    return;
  }

  let analyzedCount = 0;
  for (const file of readmes) {
    if (analyzedCount >= 5) {
      console.log('... a desítky dalších uzlů. (Zobrazeno pouze prvních 5 pro POC)');
      break;
    }

    const fullPath = path.join(rootDir, file);
    const nodeDir = path.dirname(fullPath);
    const nodeId = path.basename(nodeDir);
    
    try {
      // Získáme historii gitu pouze pro tento izolovaný uzel (složku)
      const logOutput = execSync(`git log --oneline -- "${nodeDir}"`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
      const lines = logOutput.split('\n').filter(l => l.trim() !== '');
      
      let major = 1;
      let minor = 0;
      let patch = 0;
      
      // Analyzujeme znění commitů podle konvencí pro SemVer
      for (const line of lines) {
        if (line.includes('BREAKING')) {
           major++;
        } else if (line.toLowerCase().includes('feat')) {
           minor++;
        } else {
           patch++;
        }
      }
      
      // Základní fallback pro čerstvě migrované uzly
      if (major === 1 && minor === 0 && patch === 0) {
         patch = 1;
      }
      
      const version = `v${major}.${minor}.${patch}`;
      
      console.log(`📦 Uzel: ${nodeId}`);
      console.log(`   Cesta: ${nodeDir}`);
      console.log(`   Zaznamenáno změn v Gitu (commits): ${lines.length}`);
      console.log(`   Vypočítaná lokální verze: ${version}`);
      console.log(`   Akce: Aktualizace hlavičky v ${file}\n`);
      
      analyzedCount++;
    } catch (e: any) {
      // Může spadnout pokud složka ještě není v gitu
    }
  }

  console.log('🛠 Závěr POC: Analyzátor umí prohledat historii izolovaných složek a generovat mikroverze. Můžeme to napojit přímo do příkazu docs --readme nebo do release skriptu!');
}

runNodeSemVerPOC().catch(console.error);
