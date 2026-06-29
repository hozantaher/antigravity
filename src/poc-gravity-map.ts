import { UnifiedVectorEngine } from './engine';
import fs from 'fs';
import path from 'path';

async function runPoC() {
  const rootDir = path.resolve(__dirname, '..');
  const engine = new UnifiedVectorEngine(rootDir);
  
  await engine.scan();
  
  // Access private fields using any for PoC purposes
  const nodes = (engine as any).nodes as Map<string, any>;
  const reverseLinks = (engine as any).reverseLinks as Map<string, string[]>;
  
  let md = '# 🌌 Antigravity Gravitational Map (PoC)\n\n';
  md += 'Tento experimentální graf ukazuje "gravitaci" (důležitost) jednotlivých uzlů na základě počtu zpětných odkazů (reverse links). Čím silnější ohraničení, tím více závislostí směřuje do daného uzlu.\n\n';
  md += '```mermaid\n';
  md += 'graph TD\n';
  
  // Build graph nodes with dynamic stroke-width based on gravity
  for (const [id, node] of nodes.entries()) {
    const linksCount = reverseLinks.has(id) ? reverseLinks.get(id)!.length : 0;
    const isCore = node.manifest.story_axis === 'platform' || node.manifest.story_axis === 'engine';
    
    // Base weight + extra weight per link
    const weight = 1 + Math.min(linksCount, 10); // Cap width at 11px
    
    let color = isCore ? '#3399ff' : '#00cc66';
    if (node.manifest.state === 'pending') {
      color = '#ff9900'; // Hot/Pending
    }
    
    const style = `stroke:${color},stroke-width:${weight}px,fill:${linksCount > 5 ? '#f0f0f0' : 'default'}`;
    
    md += `  ${id}["${id} (Links: ${linksCount})"]\n`;
    md += `  style ${id} ${style}\n`;
  }
  
  // Build graph edges
  for (const [id, node] of nodes.entries()) {
    if (node.manifest.edges) {
      for (const edge of node.manifest.edges) {
        if (nodes.has(edge)) {
          md += `  ${id} --> ${edge}\n`;
        }
      }
    }
  }
  
  md += '```\n\n';
  md += '## 📈 Top 5 Gravitačních Hubů\n\n';
  
  const sortedNodes = Array.from(nodes.keys()).sort((a, b) => {
    const countA = reverseLinks.has(a) ? reverseLinks.get(a)!.length : 0;
    const countB = reverseLinks.has(b) ? reverseLinks.get(b)!.length : 0;
    return countB - countA;
  });
  
  for (let i = 0; i < Math.min(5, sortedNodes.length); i++) {
    const id = sortedNodes[i];
    const count = reverseLinks.has(id) ? reverseLinks.get(id)!.length : 0;
    md += `${i + 1}. **${id}** (${count} zpětných vazeb)\n`;
  }
  
  const outPath = path.join(rootDir, 'docs', 'reference', 'gravity-map.md');
  fs.writeFileSync(outPath, md, 'utf8');
  console.log('PoC generated at docs/reference/gravity-map.md');
}

runPoC().catch(console.error);
