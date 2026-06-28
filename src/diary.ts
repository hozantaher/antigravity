import fs from 'fs';
import path from 'path';
import { VektorManifest } from './types';

export class DiaryManager {
  private rootDir: string;
  private diaryDir: string;
  private manifestPath: string;
  private mdPath: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    this.diaryDir = path.join(this.rootDir, '.vektor', 'diary');
    this.manifestPath = path.join(this.diaryDir, 'vektor.json');
    this.mdPath = path.join(this.diaryDir, 'diary.md');
    this.ensureDiaryExists();
  }

  private ensureDiaryExists() {
    if (!fs.existsSync(this.diaryDir)) {
      fs.mkdirSync(this.diaryDir, { recursive: true });
    }

    if (!fs.existsSync(this.manifestPath)) {
      const manifest: VektorManifest = {
        id: 'diary',
        story_axis: 'meta',
        state: 'met',
        facets: {
          log: ['./diary.md']
        },
        edges: [],
        tags: ['autonomous-diary', 'log']
      };
      fs.writeFileSync(this.manifestPath, JSON.stringify(manifest, null, 2));
    }

    if (!fs.existsSync(this.mdPath)) {
      const header = `# Autonomní Vývojářský Deníček\n\nTento log je automaticky spravován systémem Antigravity.\n\n`;
      fs.writeFileSync(this.mdPath, header);
    }
  }

  public logAction(actor: 'AI' | 'Human', action: string, details: string, affectedNodes: string[] = []) {
    // 1. Zápis do Markdownu
    const timestamp = new Date().toISOString();
    const logEntry = `
## [${timestamp}] ${action}

- **Actor:** ${actor}
- **Affected Nodes:** ${affectedNodes.length > 0 ? affectedNodes.join(', ') : 'None'}
- **Details:** ${details}

`;
    fs.appendFileSync(this.mdPath, logEntry);

    // 2. Aktualizace závislostí ve vektor.json (Edges)
    if (affectedNodes.length > 0) {
      try {
        const manifest = JSON.parse(fs.readFileSync(this.manifestPath, 'utf8')) as VektorManifest;
        let edgesChanged = false;
        if (!manifest.edges) manifest.edges = [];
        
        for (const node of affectedNodes) {
          if (!manifest.edges.includes(node) && node !== 'diary') {
            manifest.edges.push(node);
            edgesChanged = true;
          }
        }

        if (edgesChanged) {
          fs.writeFileSync(this.manifestPath, JSON.stringify(manifest, null, 2));
        }
      } catch (e) {
        console.error('Nepodařilo se aktualizovat vektor.json deníčku', e);
      }
    }
  }
}
