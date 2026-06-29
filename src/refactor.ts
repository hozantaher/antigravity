import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import { execSync } from 'child_process';
import { VektorManifest } from './types';

export class TransactionalRefactorEngine {
  private rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  public async planRename(oldId: string, newId: string, newPath?: string): Promise<string[]> {
    const plan: string[] = [];
    let nodePath: string | null = null;
    let manifestData: VektorManifest | null = null;
    let manifestFullPath: string | null = null;

    // 1. Locate the node
    const jsonFiles = await glob('**/vektor.json', {
      cwd: this.rootDir,
      ignore: '**/node_modules/**',
    });
    for (const file of jsonFiles) {
      const fullPath = path.join(this.rootDir, file);
      try {
        const manifest = JSON.parse(fs.readFileSync(fullPath, 'utf8')) as VektorManifest;
        let inferredId = manifest.id;
        if (!inferredId) {
            const parts = file.split('/');
            inferredId = parts[parts.length - 2];
        }

        if (inferredId === oldId) {
          nodePath = path.dirname(fullPath);
          manifestData = manifest;
          manifestFullPath = fullPath;
          break;
        }
      } catch (e) {}
    }

    if (!nodePath || !manifestData || !manifestFullPath) {
      throw new Error(`Node with ID '${oldId}' not found.`);
    }

    plan.push(`UPDATE_JSON: ${manifestFullPath} (id: ${oldId} -> ${newId})`);

    let finalDir = nodePath;
    if (newPath) {
      finalDir = path.join(this.rootDir, newPath);
      plan.push(`GIT_MV: ${nodePath} -> ${finalDir}`);
    }

    // 2. Patch reverse links in code
    const tsFiles = await glob('**/*.{ts,vue,js}', {
      cwd: this.rootDir,
      ignore: '**/node_modules/**',
    });
    for (const file of tsFiles) {
      const fullPath = path.join(this.rootDir, file);
      const content = fs.readFileSync(fullPath, 'utf8');
      if (content.includes(`// @vek` + `tor-link: ${oldId}`)) {
        plan.push(`PATCH_FILE: ${fullPath} (replace ${oldId} with ${newId})`);
      }
    }

    // 3. Patch edges in other vektor.jsons
    for (const file of jsonFiles) {
      const fullPath = path.join(this.rootDir, file);
      if (fullPath === manifestFullPath) continue;

      try {
        const manifest = JSON.parse(fs.readFileSync(fullPath, 'utf8')) as VektorManifest;
        if (manifest.edges && manifest.edges.includes(oldId)) {
          plan.push(`PATCH_EDGE: ${fullPath} (edges: ${oldId} -> ${newId})`);
        }
      } catch (e) {}
    }

    return plan;
  }

  public async executeRename(oldId: string, newId: string, newPath?: string): Promise<void> {
    const plan = await this.planRename(oldId, newId, newPath);
    console.log('Vykonávám refaktorizační plán:');
    
    for (const step of plan) {
      console.log(step);
      if (step.startsWith('UPDATE_JSON:')) {
        const file = step.split(' ')[1];
        const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
        manifest.id = newId;
        // Změna story_axis pokud se přesouvá do nové domény
        if (newPath) {
           const parts = newPath.split('/');
           if (parts.length > 0 && ['demand', 'supply', 'sale', 'engine', 'platform'].includes(parts[0])) {
             manifest.story_axis = parts[0];
           } else if (parts.length > 1 && parts[0] === 'spine') {
             manifest.story_axis = parts[1];
           }
        }
        fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
      } else if (step.startsWith('GIT_MV:')) {
        const parts = step.split(' ');
        const oldDir = parts[1];
        const newDir = parts[3];
        fs.mkdirSync(path.dirname(newDir), { recursive: true });
        fs.renameSync(oldDir, newDir);
      } else if (step.startsWith('PATCH_FILE:')) {
        const file = step.split(' ')[1];
        let content = fs.readFileSync(file, 'utf8');
        content = content.replace(new RegExp(`// @vektor-link: ${oldId}`, 'g'), `// @vektor-link: ${newId}`);
        fs.writeFileSync(file, content, 'utf8');
      } else if (step.startsWith('PATCH_EDGE:')) {
        const file = step.split(' ')[1];
        const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (manifest.edges) {
          manifest.edges = manifest.edges.map((e: string) => e === oldId ? newId : e);
        }
        fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
      }
    }

    console.log('Refactoring dokončen.');
  }
}
