import * as fs from 'fs';
import * as path from 'path';
import { globSync } from 'glob';

const manifests = globSync('spine/**/vektor.json');
const stats = {
  totalNodes: manifests.length,
  missingTests: 0,
  missingUI: 0,
  missingReadme: 0,
  pendingNodes: 0,
  highOutDegree: 0,
  legacyUnmapped: 0,
};

for (const m of manifests) {
  const data = JSON.parse(fs.readFileSync(m, 'utf8'));
  const dir = path.dirname(m);
  
  if (data.state === 'pending') stats.pendingNodes++;
  
  if (!data.facets?.tests || data.facets.tests.length === 0) {
    stats.missingTests++;
  }
  
  if (!data.facets?.ui || data.facets.ui.length === 0) {
    stats.missingUI++;
  }
  
  if (data.facets?.legacy_unmapped) {
    stats.legacyUnmapped++;
  }
  
  if (data.edges && data.edges.length > 5) {
    stats.highOutDegree++;
  }
  
  if (!fs.existsSync(path.join(dir, 'README.md'))) {
    stats.missingReadme++;
  }
}

console.log(JSON.stringify(stats, null, 2));
