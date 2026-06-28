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
    const jsonFiles = await glob('**/vektor.json', { cwd: this.rootDir, ignore: 'node_modules/**' });
    for (const file of jsonFiles) {
      const fullPath = path.join(this.rootDir, file);
      try {
        const manifest = JSON.parse(fs.readFileSync(fullPath, 'utf8')) as VektorManifest;
        if (manifest.id === oldId) {
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
    const tsFiles = await glob('**/*.{ts,vue,js}', { cwd: this.rootDir, ignore: 'node_modules/**' });
    for (const file of tsFiles) {
      const fullPath = path.join(this.rootDir, file);
      const content = fs.readFileSync(fullPath, 'utf8');
      if (content.includes(`// @vektor-link: ${oldId}`)) {
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
    // This is a simplified execution of the plan
    // In a real ACID environment, we would copy, patch, test, and commit.
    const plan = await this.planRename(oldId, newId, newPath);
    console.log("Vykonávám refaktorizační plán:");
    plan.forEach(step => console.log(step));

    // To be fully implemented: the actual fs/git execution logic.
    console.log("Refactoring (dry-run) dokončen.");
  }
}
