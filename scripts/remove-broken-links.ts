import * as fs from 'fs';
import * as path from 'path';
import { globSync } from 'glob';

const manifests = globSync('spine/**/vektor.json');

for (const manifestPath of manifests) {
  const content = fs.readFileSync(manifestPath, 'utf8');
  let data;
  try {
    data = JSON.parse(content);
  } catch (e) { continue; }
  
  let changed = false;
  const dir = path.dirname(manifestPath);
  
  if (data.facets) {
    for (const [key, paths] of Object.entries(data.facets)) {
      if (Array.isArray(paths)) {
        const validPaths = paths.filter((p: string) => {
          const fullPath = path.join(dir, p);
          return fs.existsSync(fullPath);
        });
        if (validPaths.length !== paths.length) {
          data.facets[key] = validPaths;
          changed = true;
        }
      }
    }
  }
  
  if (changed) {
    fs.writeFileSync(manifestPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  }
}
