import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    db: { type: 'string', default: '' },
    output: { type: 'string', default: '' },
  },
});

const DB_PATH = values.db || resolve('data', 'autoline.db');
const OUTPUT_PATH = values.output || resolve('output', 'autoline-categories.json');

interface CategoryNode {
  name: string;
  count: number;
  children: CategoryNode[];
}

/** Split "Autoline > Trucks > Used" into ["Trucks", "Used"] */
const parseCategoryPath = (raw: string): string[] => {
  const parts = raw.split(' > ').filter(Boolean);
  return parts[0] === 'Autoline' ? parts.slice(1) : parts;
};

function buildTree(parsed: Array<{ path: string[]; cnt: number }>): CategoryNode {
  const root: CategoryNode = { name: 'Autoline', count: 0, children: [] };
  const rootMap = new Map<string, { node: CategoryNode; childMap: Map<string, unknown> }>();

  for (const { path, cnt } of parsed) {
    root.count += cnt;
    let children = root.children;
    let childMap = rootMap;

    for (const part of path) {
      let entry = childMap.get(part) as { node: CategoryNode; childMap: Map<string, unknown> } | undefined;
      if (!entry) {
        const node: CategoryNode = { name: part, count: 0, children: [] };
        children.push(node);
        entry = { node, childMap: new Map() };
        childMap.set(part, entry);
      }
      entry.node.count += cnt;
      children = entry.node.children;
      childMap = entry.childMap as Map<string, { node: CategoryNode; childMap: Map<string, unknown> }>;
    }
  }

  // Sort children by count descending at every level
  const sortTree = (node: CategoryNode) => {
    node.children.sort((a, b) => b.count - a.count);
    for (const child of node.children) sortTree(child);
  };
  sortTree(root);

  return root;
}

function printTree(node: CategoryNode, indent = 0, maxDepth = 3): void {
  const prefix = indent === 0 ? '' : '  '.repeat(indent) + '├─ ';
  console.log(`${prefix}${node.name} (${node.count.toLocaleString()})`);
  if (indent < maxDepth) {
    for (const child of node.children.slice(0, 10)) {
      printTree(child, indent + 1, maxDepth);
    }
    if (node.children.length > 10) {
      console.log(`${'  '.repeat(indent + 1)}├─ ... a ${node.children.length - 10} dalších`);
    }
  }
}

// Main
const db = new Database(DB_PATH, { readonly: true });

const rows = db
  .prepare(
    `SELECT category_path, COUNT(*) as cnt
     FROM listings
     WHERE category_path IS NOT NULL AND category_path != ''
     GROUP BY category_path`,
  )
  .all() as Array<{ category_path: string; cnt: number }>;

db.close();

console.log(`Loaded ${rows.length.toLocaleString()} unique category paths\n`);

// Parse paths once, reuse for both tree and flat summary
const parsed = rows.map(({ category_path, cnt }) => ({
  path: parseCategoryPath(category_path),
  cnt,
}));

const tree = buildTree(parsed);

// Print summary to console
printTree(tree);

// Save full tree as JSON
mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
writeFileSync(OUTPUT_PATH, JSON.stringify(tree, null, 2), 'utf-8');
console.log(`\nSaved to ${OUTPUT_PATH}`);

// Also save flat list of unique categories per level
const flatCategories: Record<string, Set<string>> = {};
for (const { path } of parsed) {
  for (let i = 0; i < path.length; i++) {
    const level = `L${i + 1}`;
    if (!flatCategories[level]) flatCategories[level] = new Set();
    flatCategories[level].add(path[i]);
  }
}

console.log('\nKategorie per úroveň:');
for (const [level, names] of Object.entries(flatCategories)) {
  console.log(`  ${level}: ${names.size} unikátních`);
}
