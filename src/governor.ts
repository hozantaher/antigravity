import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import { VektorManifest } from './types';

export class CyberneticGovernor {
  private rootDir: string;
  private autoHeal: boolean;

  constructor(rootDir: string, autoHeal: boolean = false) {
    this.rootDir = rootDir;
    this.autoHeal = autoHeal;
  }

  public async audit(): Promise<string[]> {
    const report: string[] = [];
    const jsonFiles = await glob('**/vektor.json', { cwd: this.rootDir, ignore: 'node_modules/**' });
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
    const tsFiles = await glob('**/*.{ts,vue,js}', { cwd: this.rootDir, ignore: 'node_modules/**' });
    for (const file of tsFiles) {
      const fullPath = path.join(this.rootDir, file);
      let content = fs.readFileSync(fullPath, 'utf8');
      const match = content.match(/\/\/\s*@vektor-link:\s*([\w-]+)/);
      if (match) {
        const targetId = match[1];
        if (!validNodes.has(targetId)) {
          report.push(`DETECTED: Orphaned link in ${file}: Node '${targetId}' does not exist`);
          if (this.autoHeal) {
            content = content.replace(match[0], '');
            fs.writeFileSync(fullPath, content);
            report.push(`  -> HEALED: Stripped orphaned magic comment`);
          }
        }
      }
    }

    return report;
  }
}
