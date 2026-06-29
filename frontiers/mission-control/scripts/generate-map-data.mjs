import { glob } from 'glob';
import fs from 'fs/promises';
import path from 'path';

// Zóny definují hrubé pozice (X,Y) pro React Flow mapu
const ZONES = {
  "CORE": { x: 400, y: 600, color: '#4B5563' }, // Střed dole (Šedá)
  "BODY": { x: 100, y: 300, color: '#3B82F6' }, // Vlevo (Modrá)
  "BRAIN": { x: 400, y: 100, color: '#8B5CF6' }, // Střed nahoře (Fialová)
  "HANDS": { x: 700, y: 300, color: '#EF4444' } // Vpravo (Červená)
};

async function main() {
  const rootDir = path.resolve('../../'); // Cesta do kořene Antigravity
  const vektorFiles = await glob('**/*/vektor.json', { cwd: rootDir, ignore: ['node_modules/**'] });

  const nodes = [];
  const edges = [];
  let yOffsets = { CORE: 0, BODY: 0, BRAIN: 0, HANDS: 0 };

  for (const file of vektorFiles) {
    const fullPath = path.join(rootDir, file);
    const content = await fs.readFile(fullPath, 'utf-8');
    const manifest = JSON.parse(content);
    
    // Pokud nemá layer, defaultujeme na CORE (i když by ho Healer už měl spravit)
    const layer = manifest.semantic_layer || "CORE";
    const zone = ZONES[layer] || ZONES["CORE"];
    
    // Posuneme uzel dolů, aby se nepřekrývaly v jedné zóně
    const yPos = zone.y + (yOffsets[layer] * 120);
    yOffsets[layer]++;

    nodes.push({
      id: manifest.id,
      position: { x: zone.x, y: yPos },
      data: { 
        label: manifest.id,
        layer: layer,
        color: zone.color,
        description: manifest.legacy_metadata?.identita || ''
      },
      type: 'antigravityNode' // Odvolávka na náš custom React Flow Node komponent
    });

    // Edges (Spojnice)
    if (manifest.edges && Array.isArray(manifest.edges)) {
      manifest.edges.forEach(edgeId => {
        edges.push({
          id: `e-${manifest.id}-${edgeId}`,
          source: manifest.id,
          target: edgeId,
          animated: true,
          style: { stroke: zone.color, strokeWidth: 2 }
        });
      });
    }
  }

  // Zápis do src/data pro React aplikaci
  const outDir = path.join(process.cwd(), 'src/data');
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'map-nodes.json'), JSON.stringify(nodes, null, 2));
  await fs.writeFile(path.join(outDir, 'map-edges.json'), JSON.stringify(edges, null, 2));
  
  console.log(`✅ Blueprint mapa vygenerována. Nalezeno ${nodes.length} uzlů a ${edges.length} spojnic.`);
}

main().catch(console.error);
