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
    const jsonFiles = await glob('**/vektor.json', { cwd: this.rootDir, ignore: 'node_modules/**' });
    
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

    const tsFiles = await glob('**/*.{ts,vue,js}', { cwd: this.rootDir, ignore: 'node_modules/**' });
    for (const file of tsFiles) {
      const fullPath = path.join(this.rootDir, file);
      const content = fs.readFileSync(fullPath, 'utf8');
      const match = content.match(/\/\/\s*@vektor-link:\s*([\w-]+)/);
      if (match) {
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
      manifest: node.manifest
    };
  }
}
