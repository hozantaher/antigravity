import * as fs from 'fs';
import * as path from 'path';

interface NodeInventory {
  id: string;
  path: string;
  story_axis: string;
  edges: string[];
  reverseLinks: string[];
  files: string[];
}

const rootDir = process.cwd();
const spineDir = path.join(rootDir, 'spine');
const inventory: Record<string, NodeInventory> = {};

// 1. Find all nodes first
function findNodes(dir: string) {
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir);
  
  if (files.includes('vektor.json')) {
    const vektorPath = path.join(dir, 'vektor.json');
    const vektor = JSON.parse(fs.readFileSync(vektorPath, 'utf8'));
    inventory[vektor.id] = {
      id: vektor.id,
      path: path.relative(rootDir, dir),
      story_axis: vektor.story_axis || 'unknown',
      edges: vektor.edges || [],
      reverseLinks: [],
      files: []
    };
  }
  
  for (const file of files) {
    const filePath = path.join(dir, file);
    try {
      if (fs.lstatSync(filePath).isDirectory()) {
        findNodes(filePath);
      }
    } catch (e) {}
  }
}

findNodes(spineDir);

// 2. Map files to nodes
// A file belongs to the deepest node in its path.
function assignFilesToNodes(dir: string, fileList: string[] = []) {
  if (!fs.existsSync(dir)) return fileList;
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    try {
      const stat = fs.lstatSync(filePath);
      if (stat.isDirectory()) {
        assignFilesToNodes(filePath, fileList);
      } else {
        fileList.push(filePath);
      }
    } catch (e) {}
  }
  return fileList;
}

const allSpineFiles = assignFilesToNodes(spineDir);

for (const file of allSpineFiles) {
  // Find which node this file belongs to (the deepest one)
  let bestNode: NodeInventory | null = null;
  let bestLength = -1;
  
  const relPath = path.relative(rootDir, file);
  
  for (const node of Object.values(inventory)) {
    if (relPath.startsWith(node.path + '/') || relPath === node.path) {
      if (node.path.length > bestLength) {
        bestLength = node.path.length;
        bestNode = node;
      }
    }
  }
  
  if (bestNode) {
    bestNode.files.push(relPath);
  }
}

// 3. Sub-sample outreach-dashboard and platform to avoid massive JSONs
if (inventory['outreach-dashboard'] && inventory['outreach-dashboard'].files.length > 20) {
  inventory['outreach-dashboard'].files = inventory['outreach-dashboard'].files.slice(0, 20);
}
if (inventory['platform'] && inventory['platform'].files.length > 20) {
  inventory['platform'].files = inventory['platform'].files.slice(0, 20);
}

// 4. Find reverse links across the codebase
const allFilesToScan = assignFilesToNodes(rootDir).filter(f => {
  const rel = path.relative(rootDir, f);
  return !rel.includes('node_modules') && !rel.includes('dist') && !rel.includes('.git') && !rel.endsWith('.json') && !rel.endsWith('.md') && !rel.endsWith('.png');
});

for (const file of allFilesToScan) {
  try {
    const content = fs.readFileSync(file, 'utf8');
    const matches = content.match(/\/\/\s*@vektor-link:\s*([\w-]+)/g);
    if (matches) {
      for (const match of matches) {
        const id = match.split(':')[1].trim();
        if (inventory[id]) {
          const relFile = path.relative(rootDir, file);
          if (!inventory[id].reverseLinks.includes(relFile)) {
            inventory[id].reverseLinks.push(relFile);
          }
        }
      }
    }
  } catch (e) {}
}

fs.writeFileSync(
  path.join(rootDir, 'experiments/topology-bench/inventory.json'), 
  JSON.stringify(Object.values(inventory), null, 2)
);

console.log(`Inventory extracted: ${Object.keys(inventory).length} nodes.`);
