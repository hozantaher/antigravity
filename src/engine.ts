import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import { VektorManifest, ResolvedNode } from './types';

export class UnifiedVectorEngine {
  private rootDir: string;
  private nodes: Map<string, { path: string; manifest: VektorManifest }> = new Map();
  private reverseLinks: Map<string, string[]> = new Map();

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  /**
   * Scans the codebase for vektor.json manifests and reverse magic comments.
   */
  public async scan(): Promise<void> {
    const jsonFiles = await glob('**/vektor.json', {
      cwd: this.rootDir,
      ignore: 'node_modules/**',
    });

    for (const file of jsonFiles) {
      const fullPath = path.join(this.rootDir, file);
      const content = fs.readFileSync(fullPath, 'utf8');
      try {
        const manifest = JSON.parse(content) as VektorManifest;
        const dir = path.dirname(file);
        this.nodes.set(manifest.id, { path: dir, manifest });
      } catch (e) {
        console.error(`Error parsing ${file}`);
      }
    }

    const tsFiles = await glob('**/*.{ts,vue,js}', {
      cwd: this.rootDir,
      ignore: 'node_modules/**',
    });
    for (const file of tsFiles) {
      const fullPath = path.join(this.rootDir, file);
      const content = fs.readFileSync(fullPath, 'utf8');
      const matches = content.matchAll(/\/\/\s*@vektor-link:\s*([\w-]+)/g);
      for (const match of matches) {
        const targetId = match[1];
        if (!this.reverseLinks.has(targetId)) {
          this.reverseLinks.set(targetId, []);
        }
        this.reverseLinks.get(targetId)!.push(file);
      }
    }
  }

  /**
   * Calculates the rollup state for a node (pending infects upwards).
   */
  public getRollupState(nodeId: string): 'pending' | 'met' {
    const node = this.nodes.get(nodeId);
    if (!node) return 'met';

    if (node.manifest.state === 'pending') return 'pending';

    const parts = node.path.split('/');
    // Check if any child in the hierarchy is pending
    for (const [id, data] of this.nodes.entries()) {
      if (data.path.startsWith(node.path + '/') && data.manifest.state === 'pending') {
        return 'pending';
      }
    }
    return 'met';
  }

  /**
   * Resolves a node by expanding its dense files, reverse links, and BFS neighbors.
   */
  public resolveContext(nodeId: string): ResolvedNode | null {
    const node = this.nodes.get(nodeId);
    if (!node) return null;

    const files: string[] = [];

    if (node.manifest.facets) {
      for (const [facet, paths] of Object.entries(node.manifest.facets)) {
        for (const p of paths) {
          files.push(path.join(node.path, p));
        }
      }
    }

    if (this.reverseLinks.has(nodeId)) {
      files.push(...this.reverseLinks.get(nodeId)!);
    }

    const neighbors: string[] = [];
    if (node.manifest.edges) {
      for (const edge of node.manifest.edges) {
        if (this.nodes.has(edge)) {
          neighbors.push(this.nodes.get(edge)!.path);
        }
      }
    }

    return {
      id: nodeId,
      path: node.path,
      state: node.manifest.state || 'met',
      rollupState: this.getRollupState(nodeId),
      files,
      neighbors,
      manifest: node.manifest,
    };
  }

  /**
   * Generates a global architecture map in Markdown (with a Mermaid graph)
   * to provide maximum initial context for AI agents.
   */
  public generateArchitectureMap(): string {
    let md = '# Antigravity Vector-Tree Architecture Map\n\n';
    md +=
      'Tento soubor byl automaticky vygenerován pro poskytnutí maximálního kontextu AI agentům.\n\n';
    md += '## 🗺️ Topologie Uzlů (Mermaid Graf)\n\n';
    md += '```mermaid\n';
    md += 'graph TD\n';

    // Build graph nodes
    for (const [id, node] of this.nodes.entries()) {
      const state = this.getRollupState(id);
      let style = state === 'pending' ? 'stroke:#ff9900,stroke-width:2px' : 'stroke:#00cc66,stroke-width:1px';
      
      // Override style if origin is specified
      if (node.manifest.origin === 'frontier') {
        style = 'stroke:#3399ff,stroke-width:3px,fill:#cce5ff,color:#333';
      } else if (node.manifest.origin === 'auction24') {
        style = 'stroke:#ff9900,stroke-width:3px,fill:#ffe6cc,color:#333';
      } else if (node.manifest.origin === 'hozantaher') {
        style = 'stroke:#9933ff,stroke-width:3px,fill:#e6ccff,color:#333';
      }

      // Quote the label to avoid mermaid syntax errors with special chars if any exist in the future
      md += `  ${id}["${id} (${node.manifest.story_axis || 'unknown'})"]\n`;
      md += `  style ${id} ${style}\n`;
    }

    // Build graph edges
    for (const [id, node] of this.nodes.entries()) {
      if (node.manifest.edges) {
        for (const edge of node.manifest.edges) {
          if (this.nodes.has(edge)) {
            md += `  ${id} --> ${edge}\n`;
          }
        }
      }
    }

    md += '```\n\n';
    md += '## 🗂️ Seznam Uzlů\n\n';

    for (const [id, node] of this.nodes.entries()) {
      const state = this.getRollupState(id);
      md += `### \`${id}\`\n`;
      md += `- **Cesta:** \`${node.path}\`\n`;
      md += `- **Osa příběhu (Story Axis):** ${node.manifest.story_axis || 'N/A'}\n`;
      md += `- **Stav:** ${state}\n`;
      if (node.manifest.origin) {
        md += `- **Původ (Origin):** ${node.manifest.origin}\n`;
      }
      if (node.manifest.tags && node.manifest.tags.length > 0) {
        md += `- **Tagy:** ${node.manifest.tags.join(', ')}\n`;
      }
      if (node.manifest.edges && node.manifest.edges.length > 0) {
        md += `- **Hrany (Edges):** ${node.manifest.edges.join(', ')}\n`;
      }
      md += '\n';
    }

    return md;
  }
}
