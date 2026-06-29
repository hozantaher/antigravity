const fs = require('fs');
const path = require('path');

const numNodes = 100;
const targetDir = path.join(process.cwd(), 'spine', 'poc');

if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}

console.log(`Generuji ${numNodes} uzlů pro 100x POC...`);

for (let i = 1; i <= numNodes; i++) {
  const nodeId = `poc-node-${i}`;
  const nodeDir = path.join(targetDir, nodeId);
  
  if (!fs.existsSync(nodeDir)) {
    fs.mkdirSync(nodeDir);
  }
  
  const logicCode = `export function doSomething${i}() { return ${i}; }\n`;
  fs.writeFileSync(path.join(nodeDir, `logic.ts`), logicCode);
  
  const manifest = {
    id: nodeId,
    story_axis: 'poc',
    state: 'pending',
    facets: {
      logic: ['./logic.ts']
    },
    edges: []
  };
  fs.writeFileSync(path.join(nodeDir, 'vektor.json'), JSON.stringify(manifest, null, 2));
}
console.log('Hotovo.');
