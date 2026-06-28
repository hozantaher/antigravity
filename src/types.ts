export interface VektorManifest {
  id: string;
  story_axis?: string;
  state?: 'pending' | 'met';
  facets?: Record<string, string[]>;
  edges?: string[];
}

export interface ResolvedNode {
  id: string;
  path: string;
  state: 'pending' | 'met';
  rollupState: 'pending' | 'met';
  files: string[];          // All resolved files (dense + reverse links)
  neighbors: string[];      // Expanded edges
  manifest: VektorManifest;
}

export interface EdgeDependency {
  sourceId: string;
  targetId: string;
  implicit: boolean; // true if found via AST/imports but missing in edges
}
