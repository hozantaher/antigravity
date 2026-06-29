import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import { VektorManifest } from '../src/types';

async function runOrphanSweeper() {
  const rootDir = process.cwd();
  console.log('🧹 Spouštím Proof-of-Concept: Orphan Sweeper (Garbage Collection)...\n');

  const jsonFiles = await glob('**/vektor.json', {
    cwd: rootDir,
    ignore: 'node_modules/**',
  });

  const nodes = new Map<string, { manifest: VektorManifest; path: string }>();
  const inDegree = new Map<string, number>();

  // Krok 1: Načtení všech uzlů a inicializace in-degree
  for (const file of jsonFiles) {
    const fullPath = path.join(rootDir, file);
    try {
      const manifest = JSON.parse(fs.readFileSync(fullPath, 'utf8')) as VektorManifest;
      nodes.set(manifest.id, { manifest, path: fullPath });
      inDegree.set(manifest.id, 0); // Výchozí stav je 0 příchozích hran
    } catch (e) {
      console.warn(`Nepodařilo se přečíst: ${file}`);
    }
  }

  // Krok 2: Počítání hran přes magické komentáře (vektor-link)
  const sourceFiles = await glob('**/*.{ts,vue,js}', {
    cwd: rootDir,
    ignore: 'node_modules/**',
  });

  let totalEdges = 0;
  for (const file of sourceFiles) {
    try {
      const fullPath = path.join(rootDir, file);
      const content = fs.readFileSync(fullPath, 'utf8');
      const matches = content.matchAll(/\/\/\s*@vektor-link:\s*([\w-]+)/g);
      for (const match of matches) {
        const targetId = match[1];
        if (inDegree.has(targetId)) {
          inDegree.set(targetId, inDegree.get(targetId)! + 1);
          totalEdges++;
        }
      }
    } catch(e) {}
  }

  console.log(`Analyzováno ${nodes.size} uzlů a ${totalEdges} definovaných hran (edges).\n`);

  // Hlavní "Root" uzly aplikací obvykle nemají příchozí hrany (jsou to vstupní body)
  const rootAxes = ['supply', 'sale', 'engine', 'demand', 'platform'];

  const orphans: string[] = [];

  // Krok 3: Detekce sirotků
  for (const [id, node] of nodes) {
    const degree = inDegree.get(id) || 0;
    
    // Zajímají nás pouze uzly ve spine (páteři), u legacy to dává smysl
    if (node.path.includes('/spine/')) {
       // Pokud na uzel nevede žádná hrana a není to hlavní osa
       if (degree === 0 && !rootAxes.includes(id)) {
          orphans.push(id);
       }
    }
  }

  if (orphans.length === 0) {
    console.log('✅ Skvělé! Nenalezeny žádné osiřelé uzly v páteři systému.');
  } else {
    console.log(`⚠️  Bylo nalezeno ${orphans.length} osiřelých uzlů (in-degree = 0) ve /spine/:`);
    orphans.forEach(id => {
       const n = nodes.get(id);
       console.log(`  - [${id}] (cesta: ${path.relative(rootDir, path.dirname(n!.path))})`);
       console.log(`    Náprava: Zvažte odstranění nebo začlenění (odkazování) z jiného uzlu.\n`);
    });
  }
}

runOrphanSweeper().catch(console.error);
