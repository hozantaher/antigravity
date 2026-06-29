import { glob } from 'glob';
import * as path from 'path';

async function buildTree() {
  const files = await glob('**/vektor.json', { ignore: 'node_modules/**' });
  const tree = {};

  for (const file of files) {
    const dir = path.dirname(file);
    const parts = dir.split('/');
    
    let current = tree;
    for (const part of parts) {
      if (!current[part]) {
        current[part] = {};
      }
      current = current[part];
    }
    // Mark as a node
    current['__isNode__'] = true;
  }

  function printTree(node, prefix = '') {
    const keys = Object.keys(node).filter(k => k !== '__isNode__').sort();
    let result = '';

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const isLast = i === keys.length - 1;
      const isVectorNode = node[key]['__isNode__'] ? ' [📦 Vektor Node]' : '';
      
      result += `${prefix}${isLast ? '└── ' : '├── '}${key}${isVectorNode}\n`;
      
      const nextPrefix = prefix + (isLast ? '    ' : '│   ');
      result += printTree(node[key], nextPrefix);
    }
    return result;
  }

  console.log('.\n' + printTree(tree));
}

buildTree().catch(console.error);
