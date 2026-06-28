import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import { VektorManifest } from './types';

export interface SearchResult {
  nodeId: string;
  path: string;
  score: number;
}

export class FuzzyVectorRouter {
  private rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  public async search(query: string): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const q = query.toLowerCase();

    const jsonFiles = await glob('**/vektor.json', {
      cwd: this.rootDir,
      ignore: 'node_modules/**',
    });

    for (const file of jsonFiles) {
      const fullPath = path.join(this.rootDir, file);
      try {
        const manifest = JSON.parse(fs.readFileSync(fullPath, 'utf8')) as VektorManifest;
        let score = 0;

        if (manifest.id.toLowerCase().includes(q)) score += 10;
        if (manifest.story_axis?.toLowerCase().includes(q)) score += 5;
        if (file.toLowerCase().includes(q)) score += 3;

        if (manifest.tags) {
          for (const tag of manifest.tags) {
            if (tag.toLowerCase().includes(q)) score += 8;
          }
        }

        if (score > 0) {
          results.push({
            nodeId: manifest.id,
            path: path.dirname(file),
            score,
          });
        }
      } catch (e) {}
    }

    return results.sort((a, b) => b.score - a.score);
  }
}
