import * as fs from 'fs';
import * as path from 'path';
import { globSync } from 'glob';

const manifests = globSync('spine/**/vektor.json');

let totalHealed = 0;

for (const manifestPath of manifests) {
  const content = fs.readFileSync(manifestPath, 'utf8');
  let data;
  try {
    data = JSON.parse(content);
  } catch (e) { continue; }
  
  if (data.facets && Array.isArray(data.facets.legacy_unmapped) && data.facets.legacy_unmapped.length > 0) {
    const unmapped = data.facets.legacy_unmapped;
    data.facets.legacy_unmapped = [];
    
    for (const file of unmapped) {
      let bucket = '';
      if (file.endsWith('.vue')) bucket = 'ui';
      else if (file.includes('.test.') || file.includes('.spec.')) bucket = 'tests';
      else if (file.endsWith('contract.ts') || file.endsWith('contract.js')) bucket = 'contract';
      else if (file.endsWith('.ts') || file.endsWith('.js') || file.endsWith('.mjs')) bucket = 'logic';
      
      if (bucket) {
        if (!data.facets[bucket]) data.facets[bucket] = [];
        if (!data.facets[bucket].includes(file)) data.facets[bucket].push(file);
        totalHealed++;
      } else {
        // Keep in legacy_unmapped if we don't know what it is
        data.facets.legacy_unmapped.push(file);
      }
    }
    
    if (data.facets.legacy_unmapped.length === 0) {
      delete data.facets.legacy_unmapped;
    }
    
    fs.writeFileSync(manifestPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  }
}

console.log(`✅ Úspěšně sémanticky zatříděno ${totalHealed} souborů z legacy_unmapped.`);
