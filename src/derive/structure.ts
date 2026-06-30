import * as fs from 'fs';
import * as path from 'path';
import { NODE_ROLES, NODE_STATES, SEMANTIC_LAYERS, ProofSignal } from '../vektor.schema';

/**
 * Deterministická derivace STRUKTURY vektor-stromu z libovolného (i bordel) repa.
 *
 * Toto je díra #1 z plánu: stávající engine je hardwired na `spine/**`/cwd a `migrate.ts` vyžaduje
 * už existující `vektor.json`. Tady stavíme orchestrátor pro CIZÍ repo: walk FS → import graf →
 * uzly → derivace graph polí (osa, facety, edges, semantic_layer, role, proofSignal, state).
 *
 * Žádný LLM. Vše, co jde spočítat deterministicky, se počítá tady; narativu dopisuje až P4.
 */

export const BIG_FIVE = ['demand', 'supply', 'sale', 'engine', 'platform'];

// Osa → sémantická vrstva (z README "Ultimate View": CORE=domain, BODY=supply/demand,
// BRAIN=engine, HANDS=sale; platform bereme jako CORE/infrastrukturu).
const AXIS_LAYER: Record<string, (typeof SEMANTIC_LAYERS)[number]> = {
  platform: 'CORE',
  domain: 'CORE',
  supply: 'BODY',
  demand: 'BODY',
  engine: 'BRAIN',
  sale: 'HANDS',
};

const DEFAULT_IGNORE = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.nuxt',
  '.output',
  '.next',
  '.cache',
  '.vektor',
  '.idea',
  '.vscode',
  '.husky',
  '.playwright-mcp',
  '.preview',
  'public',
  'assets',
]);

const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.go', '.py']);
const TEST_RE = /\.(test|spec)\.[tj]sx?$/;
const GROUPING_DIRS = new Set([
  'src',
  'features',
  'spine',
  'frontiers',
  'apps',
  'packages',
  'lib',
  'modules',
  'server',
  'pages',
]);

// Složky, které NEJSOU byznys-uzly (infra/framework). V heuristic módu se nepočítají jako uzel,
// ale jejich soubory zůstávají v import grafu.
const INFRA_NODE_NAMES = new Set([
  'tests', 'test', '__tests__', 'e2e', '_e2e', 'bench', 'load', 'fixtures', 'mocks', '__mocks__',
  'scripts', 'types', 'utils', 'helpers', 'eslint-plugins', 'stylelint-plugins', 'migrations',
  'i18n', 'locales', 'translations', '_dev', 'node_modules',
]);

// Dynamická route segment ([slug], [id], [...all]) nebo konvenční _složka — není byznys-uzel.
const isRouteOrPrivate = (base: string): boolean => /^\[.+\]$/.test(base) || /^_/.test(base);

export interface DeriveOptions {
  axes?: string[]; // povolené osy (default BIG_FIVE)
  ignore?: Set<string>;
  /** 'manifest' = uzel je dir s vektor.json (oracle/existující strom); 'heuristic' = z kódu. */
  nodeStrategy?: 'manifest' | 'heuristic';
}

export interface DerivedNode {
  id: string;
  path: string; // relativní k targetDir (posix)
  story_axis: string;
  semantic_layer: (typeof SEMANTIC_LAYERS)[number];
  role: (typeof NODE_ROLES)[number];
  state: (typeof NODE_STATES)[number];
  facets: Record<string, string[]>;
  edges: string[];
  proofSignal: ProofSignal[];
  inDegree: number;
  files: string[]; // relativní k node path
}

const toPosix = (p: string): string => p.split(path.sep).join('/');

// ── walk ──────────────────────────────────────────────────────────────────────
const walk = (root: string, ignore: Set<string>): string[] => {
  const out: string[] = [];
  const rec = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.') {
        if (ignore.has(e.name)) continue;
      }
      if (ignore.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) rec(full);
      else if (e.isFile()) out.push(full);
    }
  };
  rec(root);
  return out;
};

// ── node discovery ────────────────────────────────────────────────────────────
const discoverNodeDirs = (
  root: string,
  files: string[],
  strategy: 'manifest' | 'heuristic',
): string[] => {
  if (strategy === 'manifest') {
    return files
      .filter((f) => path.basename(f) === 'vektor.json')
      .map((f) => path.dirname(f))
      .sort();
  }
  // heuristic: dir, který PŘÍMO obsahuje ≥1 zdrojový (ne-test) soubor a není čistě grouping bucket
  const dirHasSource = new Map<string, number>();
  for (const f of files) {
    const ext = path.extname(f);
    if (!SOURCE_EXT.has(ext) || TEST_RE.test(f)) continue;
    const d = path.dirname(f);
    dirHasSource.set(d, (dirHasSource.get(d) ?? 0) + 1);
  }
  return [...dirHasSource.keys()]
    .filter((d) => {
      const rel = toPosix(path.relative(root, d));
      if (rel === '') return false; // root není uzel
      const segs = rel.split('/');
      if (segs.some((s) => INFRA_NODE_NAMES.has(s))) return false; // infra (tests/scripts/utils/…)
      if (segs.some(isRouteOrPrivate)) return false; // [slug]/[id]/_helpers — soubory se rolnou na rodiče
      const base = path.basename(d);
      // přeskoč generická vědra na úrovni rootu (jen pokud mají i pod-uzly)
      return !(GROUPING_DIRS.has(base) && d === path.join(root, base));
    })
    .sort();
};

// ── id ────────────────────────────────────────────────────────────────────────
const nodeId = (relDir: string, taken: Set<string>): string => {
  const parts = relDir.split('/').filter((p) => p && !GROUPING_DIRS.has(p));
  let id = parts[parts.length - 1] ?? path.basename(relDir);
  if (taken.has(id) && parts.length >= 2) id = `${parts[parts.length - 2]}-${id}`;
  let final = id;
  let i = 2;
  while (taken.has(final)) final = `${id}-${i++}`;
  taken.add(final);
  return final;
};

// ── axis / layer / role ─────────────────────────────────────────────────────────
export const deriveAxis = (relDir: string, axes: string[]): string => {
  const parts = relDir.split('/').filter(Boolean);
  for (const p of parts) if (axes.includes(p)) return p;
  return parts.find((p) => !GROUPING_DIRS.has(p)) ?? 'platform';
};

const deriveLayer = (axis: string): (typeof SEMANTIC_LAYERS)[number] => AXIS_LAYER[axis] ?? 'BODY';

const isAxisRoot = (relDir: string, axes: string[]): boolean => {
  const parts = relDir.split('/').filter((p) => p && !GROUPING_DIRS.has(p));
  return parts.length === 1 && axes.includes(parts[0]);
};

// ── facets ────────────────────────────────────────────────────────────────────
const facetFor = (file: string): string => {
  if (TEST_RE.test(file)) return 'tests';
  const ext = path.extname(file);
  if (ext === '.vue' || ext === '.tsx' || ext === '.jsx') return 'ui';
  if (/(^|\/)models?(\/|$)/i.test(file) || /\.model\.[tj]s$/.test(file)) return 'models';
  if (/(^|\/)repos?(\/|$)/i.test(file) || /repo\.[tj]s$/i.test(file)) return 'repos';
  if (/(^|\/)(api|server|routes?|server-routes)(\/|$)/i.test(file)) return 'api';
  if (SOURCE_EXT.has(ext)) return 'logic';
  return 'misc';
};

const buildFacets = (nodeDir: string, nodeFiles: string[]): Record<string, string[]> => {
  const facets: Record<string, string[]> = {};
  for (const f of nodeFiles) {
    const rel = './' + toPosix(path.relative(nodeDir, f));
    const key = facetFor(toPosix(path.relative(nodeDir, f)));
    (facets[key] ??= []).push(rel);
  }
  for (const k of Object.keys(facets)) facets[k].sort();
  return facets;
};

// ── import graph ────────────────────────────────────────────────────────────────
const IMPORT_RE = /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;

const resolveImport = (fromFile: string, spec: string): string | null => {
  if (!spec.startsWith('.')) return null; // jen relativní; alias/bare neřešíme deterministicky
  const base = path.resolve(path.dirname(fromFile), spec);
  const cands = [
    base,
    base + '.ts',
    base + '.tsx',
    base + '.js',
    base + '.vue',
    path.join(base, 'index.ts'),
    path.join(base, 'index.js'),
  ];
  for (const c of cands) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch {
      /* ignore */
    }
  }
  return base; // i nevyřešené necháme — namapujeme na nejbližší uzel dle cesty
};

// ── hlavní ────────────────────────────────────────────────────────────────────
export const crawlNodes = (targetDir: string, opts: DeriveOptions = {}): DerivedNode[] => {
  const axes = opts.axes ?? BIG_FIVE;
  const ignore = opts.ignore ?? DEFAULT_IGNORE;
  const strategy = opts.nodeStrategy ?? 'heuristic';
  const root = path.resolve(targetDir);

  const allFiles = walk(root, ignore);
  const nodeDirs = discoverNodeDirs(root, allFiles, strategy);

  // mapování soubor → nejbližší uzel (nejdelší prefix dir)
  const sortedNodeDirs = [...nodeDirs].sort((a, b) => b.length - a.length);
  const fileToNode = (file: string): string | null => {
    for (const nd of sortedNodeDirs) {
      if (file === nd || file.startsWith(nd + path.sep)) return nd;
    }
    return null;
  };

  // soubory per uzel (přímé i vnořené, ale přiřazené nejbližšímu uzlu)
  const filesByNode = new Map<string, string[]>();
  for (const f of allFiles) {
    const ext = path.extname(f);
    if (!SOURCE_EXT.has(ext)) continue;
    const nd = fileToNode(f);
    if (nd) (filesByNode.get(nd) ?? filesByNode.set(nd, []).get(nd)!).push(f);
  }

  const dirToId = new Map<string, string>();
  const taken = new Set<string>();
  for (const nd of nodeDirs) dirToId.set(nd, nodeId(toPosix(path.relative(root, nd)), taken));

  // edges + in-degree z import grafu
  const edgesByNode = new Map<string, Set<string>>();
  const inDegree = new Map<string, number>();
  for (const nd of nodeDirs) {
    edgesByNode.set(nd, new Set());
    inDegree.set(nd, 0);
  }
  for (const [nd, files] of filesByNode) {
    for (const f of files) {
      let content = '';
      try {
        content = fs.readFileSync(f, 'utf-8');
      } catch {
        continue;
      }
      let m: RegExpExecArray | null;
      IMPORT_RE.lastIndex = 0;
      while ((m = IMPORT_RE.exec(content))) {
        const spec = m[1] ?? m[2];
        if (!spec) continue;
        const resolved = resolveImport(f, spec);
        if (!resolved) continue;
        const targetNd = fileToNode(resolved);
        if (targetNd && targetNd !== nd) {
          const tid = dirToId.get(targetNd)!;
          edgesByNode.get(nd)!.add(tid);
          inDegree.set(targetNd, (inDegree.get(targetNd) ?? 0) + 1);
        }
      }
    }
  }

  // práh pro primary: referencován ≥2 jinými uzly (jinak supporting). Stage = osa-root.
  const nodes: DerivedNode[] = [];
  for (const nd of nodeDirs) {
    const rel = toPosix(path.relative(root, nd));
    const id = dirToId.get(nd)!;
    const axis = deriveAxis(rel, axes);
    const files = (filesByNode.get(nd) ?? []).filter((f) => fileToNode(f) === nd);
    const facets = buildFacets(nd, files);
    const indeg = inDegree.get(nd) ?? 0;

    let role: (typeof NODE_ROLES)[number];
    if (isAxisRoot(rel, axes)) role = 'stage';
    else if (indeg >= 2) role = 'primary';
    else role = 'supporting';

    const hasTests = Boolean(facets.tests?.length);
    const state: (typeof NODE_STATES)[number] = hasTests ? 'met' : 'pending';
    const proofSignal: ProofSignal[] = hasTests
      ? [{ nazev: `${id} tests`, zdroj: `test/${id}`, stav: 'met' }]
      : [];

    nodes.push({
      id,
      path: rel,
      story_axis: axis,
      semantic_layer: deriveLayer(axis),
      role,
      state,
      facets,
      edges: [...edgesByNode.get(nd)!].sort(),
      proofSignal,
      inDegree: indeg,
      files: files.map((f) => './' + toPosix(path.relative(nd, f))).sort(),
    });
  }
  return nodes.sort((a, b) => a.path.localeCompare(b.path));
};
