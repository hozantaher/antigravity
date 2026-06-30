import * as fs from 'fs';
import * as path from 'path';
import { crawlNodes } from './structure';

/**
 * Strukturní fáze před dopočítáním vektorů/stories.
 *
 *  FÁZE A (assessStructure) — „zaštěrkat" s existující strukturou: zjisti, jestli projekt UŽ JE
 *    vektor-tree (má node manifesty), nebo je to syrový repo, který se teprve musí zestrukturovat.
 *  FÁZE B (materializeStructure) — „změnit strukturu": tam, kde uzel chybí manifest, vytvoř
 *    structure-only `vektor.json` (id/axis/facets/edges/role/proofSignal/state). Idempotentní:
 *    existující manifest NIKDY nepřepíše (zachová story). Žádné destruktivní přesuny souborů.
 */

export type StructureState = 'migrated' | 'partial' | 'unmigrated';

export interface StructureAssessment {
  state: StructureState;
  codeNodes: number; // uzly odvozené z kódu (heuristika)
  manifestNodes: number; // adresáře s vektor.json
  missing: string[]; // code-uzly bez manifestu
  alreadyMigrated: boolean;
}

/** FÁZE A — posoudí, nakolik už struktura odpovídá vektor-tree. */
export const assessStructure = (targetDir: string): StructureAssessment => {
  const heur = crawlNodes(targetDir, { nodeStrategy: 'heuristic' });
  const manifestDirs = new Set(
    crawlNodes(targetDir, { nodeStrategy: 'manifest' }).map((n) => n.path),
  );
  const missing = heur.filter((n) => !manifestDirs.has(n.path)).map((n) => n.path);
  const covered = heur.length - missing.length;

  let state: StructureState;
  if (heur.length === 0) state = manifestDirs.size > 0 ? 'migrated' : 'unmigrated';
  else if (missing.length === 0) state = 'migrated';
  else if (covered / heur.length >= 0.5) state = 'partial';
  else state = 'unmigrated';

  return {
    state,
    codeNodes: heur.length,
    manifestNodes: manifestDirs.size,
    missing,
    alreadyMigrated: state === 'migrated',
  };
};

export interface MigrationResult {
  created: string[]; // cesty, kde vznikl (nebo by vznikl) structure manifest
  skipped: string[]; // už měly manifest
  total: number;
}

/** FÁZE B — materializuje chybějící node manifesty (structure-only). write:false = dry-run plán. */
export const materializeStructure = (
  targetDir: string,
  opts: { write?: boolean } = {},
): MigrationResult => {
  const nodes = crawlNodes(targetDir, { nodeStrategy: 'heuristic' });
  const created: string[] = [];
  const skipped: string[] = [];

  for (const n of nodes) {
    const mp = path.join(targetDir, n.path, 'vektor.json');
    if (fs.existsSync(mp)) {
      skipped.push(n.path); // idempotence: nikdy nepřepiš existující (může mít story)
      continue;
    }
    const manifest = {
      id: n.id,
      story_axis: n.story_axis,
      semantic_layer: n.semantic_layer,
      state: n.state,
      role: n.role,
      facets: n.facets,
      edges: n.edges,
      proofSignal: n.proofSignal,
    };
    if (opts.write) {
      fs.mkdirSync(path.dirname(mp), { recursive: true });
      fs.writeFileSync(mp, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
    }
    created.push(n.path);
  }
  return { created, skipped, total: nodes.length };
};
