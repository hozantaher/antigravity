import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import { VektorManifest } from './types';

function levenshtein(a: string, b: string): number {
  const matrix = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) matrix[i][j] = matrix[i - 1][j - 1];
      else matrix[i][j] = Math.min(matrix[i - 1][j - 1], matrix[i][j - 1], matrix[i - 1][j]) + 1;
    }
  }
  return matrix[a.length][b.length];
}

export class CyberneticGovernor {
  private rootDir: string;
  private autoHeal: boolean;
  private enableSweep: boolean;
  private enableCompress: boolean;

  constructor(rootDir: string, autoHeal: boolean = false, enableSweep: boolean = false, enableCompress: boolean = false) {
    this.rootDir = rootDir;
    this.autoHeal = autoHeal;
    this.enableSweep = enableSweep;
    this.enableCompress = enableCompress;
  }

  public async audit(): Promise<string[]> {
    const report: string[] = [];
    const jsonFiles = await glob('**/vektor.json', {
      cwd: this.rootDir,
      ignore: 'node_modules/**',
    });
    const validNodes = new Set<string>();
    const nodePaths = new Map<string, string>(); // path -> nodeId

    // Pass 1: Collect nodes
    for (const file of jsonFiles) {
      const fullPath = path.join(this.rootDir, file);
      try {
        const manifest = JSON.parse(fs.readFileSync(fullPath, 'utf8')) as VektorManifest;
        validNodes.add(manifest.id);
        nodePaths.set(path.dirname(fullPath), manifest.id);
      } catch (e: any) {
        report.push(`DETECTED: Neplatný JSON ve vektor.json: ${file} (${e.message})`);
      }
    }

    // Pass 2: Missing Files (Dead links in JSON)
    for (const file of jsonFiles) {
      const fullPath = path.join(this.rootDir, file);
      let manifest: VektorManifest;
      try {
        manifest = JSON.parse(fs.readFileSync(fullPath, 'utf8')) as VektorManifest;
      } catch (e) {
        continue;
      }
      const dir = path.dirname(fullPath);
      let changed = false;

      if (manifest.facets) {
        for (const [facet, paths] of Object.entries(manifest.facets)) {
          const validPaths = [];
          for (const p of paths) {
            if (fs.existsSync(path.join(dir, p))) {
              validPaths.push(p);
            } else {
              report.push(`DETECTED: Broken link in ${manifest.id} -> ${p}`);
              if (this.autoHeal) {
                report.push(`  -> HEALED: Removed dead link from vektor.json`);
                changed = true;
              } else {
                validPaths.push(p); // keep if not healing
              }
            }
          }
          manifest.facets[facet] = validPaths;
        }
      }

      if (changed && this.autoHeal) {
        fs.writeFileSync(fullPath, JSON.stringify(manifest, null, 2));
      }
    }

    // Pass 3: Orphaned Magic Comments, In-Degree Tracking & Cycle Detection
    const inDegree = new Map<string, number>();
    const graph = new Map<string, Set<string>>();
    for (const node of validNodes) {
      inDegree.set(node, 0);
      graph.set(node, new Set<string>());
    }

    const tsFiles = await glob('**/*.{ts,vue,js}', {
      cwd: this.rootDir,
      ignore: 'node_modules/**',
    });
    for (const file of tsFiles) {
      const fullPath = path.join(this.rootDir, file);
      let content = fs.readFileSync(fullPath, 'utf8');
      const matches = content.matchAll(/\/\/\s*@vektor-link:\s*([\w-]+)/g);
      let closestNodeDir = '';
      let closestNodeId = '';
      for (const [nodeDir, nodeId] of nodePaths.entries()) {
         if (fullPath.startsWith(nodeDir)) {
            if (nodeDir.length > closestNodeDir.length) {
               closestNodeDir = nodeDir;
               closestNodeId = nodeId;
            }
         }
      }
      
      for (const match of matches) {
        const targetId = match[1];
        if (inDegree.has(targetId)) {
          inDegree.set(targetId, inDegree.get(targetId)! + 1);
          if (closestNodeId && closestNodeId !== targetId) {
            graph.get(closestNodeId)?.add(targetId);
          }
        }
        if (!validNodes.has(targetId)) {
          report.push(`DETECTED: Orphaned link in ${file}: Node '${targetId}' does not exist`);
          if (this.autoHeal) {
            let bestMatch = '';
            let lowestDist = Infinity;
            for (const validNode of validNodes) {
              const dist = levenshtein(targetId, validNode);
              if (dist < lowestDist) {
                lowestDist = dist;
                bestMatch = validNode;
              }
            }

            // FP Prevention: Zpřísnění pro krátká slova
            const maxAllowedDist = targetId.length < 4 ? 0 : (targetId.length < 6 ? 1 : 3);
            
            if (bestMatch && lowestDist <= maxAllowedDist && lowestDist > 0) {
              content = content.replace(match[0], match[0].replace(targetId, bestMatch));
              report.push(
                `  -> HEALED (Fuzzy): Fixed typo in magic comment from '${targetId}' to '${bestMatch}'`
              );
            } else if (bestMatch && lowestDist === 0) {
              // Valid link, no heal needed (shouldn't happen here as we check validNodes.has, but just in case)
            } else {
              content = content.replace(match[0], '');
              report.push(`  -> HEALED (Destructive): Stripped orphaned magic comment`);
            }
          }
        }
      }
      if (this.autoHeal && report.length > 0) {
        fs.writeFileSync(fullPath, content);
      }
    }

    // Pass 3b: Cycle Detection (DFS)
    const visited = new Set<string>();
    const recStack = new Set<string>();

    const detectCycle = (node: string, pathNodes: string[]): boolean => {
      if (!visited.has(node)) {
        visited.add(node);
        recStack.add(node);

        const edges = graph.get(node) || new Set<string>();
        for (const neighbor of edges) {
          if (!visited.has(neighbor)) {
            if (detectCycle(neighbor, [...pathNodes, neighbor])) return true;
          } else if (recStack.has(neighbor)) {
            report.push(`DETECTED: Circular Dependency v architektuře! Cyklus: ${pathNodes.join(' -> ')} -> ${neighbor}`);
            return true;
          }
        }
      }
      recStack.delete(node);
      return false;
    };

    for (const node of validNodes) {
      if (!visited.has(node)) {
        detectCycle(node, [node]);
      }
    }


    // Pass 4: Detect Invalid Manifests
    for (const file of jsonFiles) {
      const fullPath = path.join(this.rootDir, file);
      try {
        const manifest = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        if (!manifest.id || !manifest.story_axis) {
          report.push(`DETECTED: Invalid legacy manifest format in ${file}`);
        }
      } catch (e) {
        report.push(`DETECTED: Unparsable manifest in ${file}`);
      }
    }

    // Pass 5: Orphaned Files in Spine (not linked in any manifest)
    const allTrackedFiles = new Set<string>();
    for (const file of jsonFiles) {
      const fullPath = path.join(this.rootDir, file);
      try {
        const manifest = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        const dir = path.dirname(file);
        if (manifest.facets) {
          for (const paths of Object.values(manifest.facets)) {
            (paths as string[]).forEach((p) => {
              // Resolve to relative path from rootDir
              const resolved = path.normalize(path.join(dir, p));
              allTrackedFiles.add(resolved);
            });
          }
        }
      } catch (e) {}
    }

    const spineFiles = await glob('spine/**/*.{ts,vue,js,mjs}', {
      cwd: this.rootDir,
      ignore: 'node_modules/**',
    });

    for (const file of spineFiles) {
      if (!allTrackedFiles.has(path.normalize(file))) {
        report.push(`DETECTED: Unmapped file in spine: ${file} (not referenced in any facets)`);
        
        if (this.autoHeal) {
          // Find closest vektor.json
          let currentDir = path.dirname(path.join(this.rootDir, file));
          let foundManifest = false;
          while (currentDir !== this.rootDir && currentDir.includes('spine')) {
            const manifestPath = path.join(currentDir, 'vektor.json');
            if (fs.existsSync(manifestPath)) {
              try {
                const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                if (!manifest.facets) manifest.facets = {};
                let facetName = 'legacy_unmapped';
                if (file.endsWith('.vue')) facetName = 'ui';
                else if (file.endsWith('.test.ts') || file.endsWith('.spec.ts')) facetName = 'tests';
                else if (file.endsWith('.ts')) facetName = 'logic';
                
                if (!manifest.facets[facetName]) manifest.facets[facetName] = [];
                
                // Calculate relative path from manifest dir to file
                const relPath = './' + path.relative(currentDir, path.join(this.rootDir, file));
                
                if (!manifest.facets[facetName].includes(relPath)) {
                  manifest.facets[facetName].push(relPath);
                  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
                  report.push(`  -> HEALED: Auto-kategorizován soubor do facetu '${facetName}' v uzlu ${manifest.id}`);
                }
                foundManifest = true;
                break;
              } catch (e) {}
            }
            currentDir = path.dirname(currentDir);
          }
        }
      }
    }

    // Pass 6: Contract Drift Validation (Spine only)
    for (const file of tsFiles) {
      if (!file.includes('spine/')) continue;
      // FP Prevention: Ignore tests and POCs
      if (file.endsWith('.test.ts') || file.endsWith('.spec.ts') || file.includes('/poc/')) continue;
      
      const fullPath = path.join(this.rootDir, file);
      const dir = path.dirname(fullPath);
      const content = fs.readFileSync(fullPath, 'utf8');
      let patchedContent = content;
      
      const importRegex = /import\s+(?:.+?\s+from\s+)?['"](.*?)['"]/g;
      const matches = content.matchAll(importRegex);
      for (const match of matches) {
         const importPath = match[1];
         let resolvedTarget = '';
         
         if (importPath.startsWith('.')) {
            resolvedTarget = path.normalize(path.join(dir, importPath));
         } else if (importPath.startsWith('@/') || importPath.startsWith('~/')) {
            resolvedTarget = path.normalize(path.join(this.rootDir, importPath.substring(2)));
         }
         
         if (resolvedTarget) {
            let closestNodeDir = '';
            let closestNodeId = '';
            
            for (const [nodeDir, nodeId] of nodePaths.entries()) {
               if (nodeDir.includes('spine') && resolvedTarget.startsWith(nodeDir)) {
                  if (nodeDir.length > closestNodeDir.length) {
                     closestNodeDir = nodeDir;
                     closestNodeId = nodeId;
                  }
               }
            }
            
            if (closestNodeDir && !fullPath.startsWith(closestNodeDir)) {
               const isPublicContract = (resolvedTarget === closestNodeDir) || (resolvedTarget === path.join(closestNodeDir, 'index')) || (resolvedTarget === path.join(closestNodeDir, 'index.ts'));
               if (!isPublicContract) {
                  report.push(`DETECTED: Contract Drift v ${file} -> Importuje z vnitřností uzlu '${closestNodeId}' místo veřejného kontraktu.`);
                  if (this.autoHeal) {
                     let newRelPath = path.relative(dir, closestNodeDir);
                     if (!newRelPath.startsWith('.')) newRelPath = './' + newRelPath;
                     
                     patchedContent = patchedContent.replace(importPath, newRelPath);
                     report.push(`  -> HEALED (Contract): Import přesměrován na ${newRelPath}`);
                  }
               }
            }
         }
      }
      
      if (this.autoHeal && patchedContent !== content) {
         fs.writeFileSync(fullPath, patchedContent, 'utf8');
      }
    }

    // Pass 7: Orphan Sweeper
    if (this.enableSweep) {
      const rootAxes = ['supply', 'sale', 'engine', 'demand', 'platform'];
      let orphansFound = 0;
      for (const [nodeDir, nodeId] of nodePaths.entries()) {
        if (nodeDir.includes('/spine/')) {
          const degree = inDegree.get(nodeId) || 0;
          if (degree === 0 && !rootAxes.includes(nodeId)) {
            if (this.enableCompress) {
               fs.rmSync(nodeDir, { recursive: true, force: true });
               report.push(`COMPRESSED: Osiřelý uzel '${nodeId}' byl fyzicky smazán z disku.`);
            } else {
               report.push(`SWEEP DETECTED: Osiřelý uzel '${nodeId}' (in-degree=0, cesta: ${nodeDir}). Zvažte jeho odstranění.`);
            }
            orphansFound++;
          }
        }
      }
      if (orphansFound === 0) {
        // Zpráva se nepíše do reportu, aby nezpůsobila selhání CI (exit code 1)
        console.log(`SWEEP OK: Ve spine nebyly nalezeny žádné osiřelé uzly.`);
      }
    }

    return report;
  }
}
