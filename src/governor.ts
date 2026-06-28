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

  constructor(rootDir: string, autoHeal: boolean = false) {
    this.rootDir = rootDir;
    this.autoHeal = autoHeal;
  }

  public async audit(): Promise<string[]> {
    const report: string[] = [];
    const jsonFiles = await glob('**/vektor.json', {
      cwd: this.rootDir,
      ignore: 'node_modules/**',
    });
    const validNodes = new Set<string>();

    // Pass 1: Collect nodes
    for (const file of jsonFiles) {
      const fullPath = path.join(this.rootDir, file);
      try {
        const manifest = JSON.parse(fs.readFileSync(fullPath, 'utf8')) as VektorManifest;
        validNodes.add(manifest.id);
      } catch (e) {}
    }

    // Pass 2: Missing Files (Dead links in JSON)
    for (const file of jsonFiles) {
      const fullPath = path.join(this.rootDir, file);
      const manifest = JSON.parse(fs.readFileSync(fullPath, 'utf8')) as VektorManifest;
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

    // Pass 3: Orphaned Magic Comments
    const tsFiles = await glob('**/*.{ts,vue,js}', {
      cwd: this.rootDir,
      ignore: 'node_modules/**',
    });
    for (const file of tsFiles) {
      const fullPath = path.join(this.rootDir, file);
      let content = fs.readFileSync(fullPath, 'utf8');
      const matches = content.matchAll(/\/\/\s*@vektor-link:\s*([\w-]+)/g);
      for (const match of matches) {
        const targetId = match[1];
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

            if (bestMatch && lowestDist <= 3) {
              content = content.replace(match[0], match[0].replace(targetId, bestMatch));
              report.push(
                `  -> HEALED (Fuzzy): Fixed typo in magic comment from '${targetId}' to '${bestMatch}'`
              );
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
      }
    }

    return report;
  }
}
