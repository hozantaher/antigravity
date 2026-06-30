import * as fs from 'fs';
import * as path from 'path';
import { crawlNodes, DerivedNode } from './structure';
import { buildBubble } from './context';
import { tellStory, Severka, StoryResult } from './storyteller';
import { LlmProvider } from '../llm/provider';
import { VektorManifestSchema, validateDerived, isStoryComplete } from '../vektor.schema';
import {
  assessStructure,
  materializeStructure,
  StructureAssessment,
  MigrationResult,
} from './migrate';

/**
 * Orchestrátor (P5): dopočítá CHYBĚJÍCÍ STORIES pro storyless uzly libovolného repa.
 *
 * Pipeline: taxonomy intake (severka) → crawl → vyber storyless → bubble → tellStory → validace →
 * merge do manifestu → (dry-run report | write). Tohle nahrazuje stub architect.ts reálným během.
 */

// ── Taxonomy intake (pluggable severka) ──────────────────────────────────────
const readManifest = (file: string): Record<string, any> | null => {
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return VektorManifestSchema.safeParse(m).success ? m : m;
  } catch {
    return null;
  }
};

const walkManifests = (root: string, cb: (file: string, m: Record<string, any>) => void): void => {
  const rec = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) rec(full);
      else if (e.name === 'vektor.json') {
        const m = readManifest(full);
        if (m) cb(full, m);
      }
    }
  };
  rec(root);
};

const firstParagraph = (root: string): string => {
  for (const f of ['docs/story.md', 'README.md', 'readme.md']) {
    const p = path.join(root, f);
    if (fs.existsSync(p)) {
      const txt = fs.readFileSync(p, 'utf-8').replace(/^---[\s\S]*?---/, '').replace(/^#.*$/gm, '');
      const para = txt.split(/\n\s*\n/).map((s) => s.trim()).find((s) => s.length > 40);
      if (para) return para.replace(/\s+/g, ' ').slice(0, 240);
    }
  }
  return 'Projekt bez explicitní severky.';
};

/** Severka: 1) docs/story.md `smer:`; 2) sjednocení existujících pillar hodnot; 3) generický default. */
export const loadSeverka = (targetDir: string): Severka => {
  const storyMd = path.join(targetDir, 'docs/story.md');
  if (fs.existsSync(storyMd)) {
    const txt = fs.readFileSync(storyMd, 'utf-8');
    const fm = txt.split('---')[1] || '';
    const pillars = new Set<string>(['cross']);
    let lore = '';
    let voice: string | undefined;
    let inSmer = false;
    for (const line of fm.split('\n')) {
      if (/^\s*smer:/.test(line)) { inSmer = true; continue; }
      if (inSmer) {
        const m = line.match(/^\s*-\s*(.+?)\s*$/);
        if (m) { pillars.add(m[1]); continue; }
        if (/^\s*\w+:/.test(line)) inSmer = false;
      }
      const id = line.match(/^\s*identita:\s*"?(.+?)"?\s*$/);
      if (id) lore = id[1];
      const sm = line.match(/^\s*smysl:\s*"?(.+?)"?\s*$/);
      if (sm) lore += ' ' + sm[1];
      const hl = line.match(/^\s*hlas:\s*"?(.+?)"?\s*$/);
      if (hl) voice = hl[1];
    }
    if (pillars.size > 1) return { pillars: [...pillars], lore: lore || firstParagraph(targetDir), voice };
  }
  // fallback: sjednocení existujících pillar hodnot v repu
  const found = new Set<string>();
  walkManifests(targetDir, (_f, m) => { if (typeof m.pillar === 'string') found.add(m.pillar); });
  if (found.size) return { pillars: [...found], lore: firstParagraph(targetDir) };
  // generický default
  return { pillars: ['cross', 'core', 'value', 'trust', 'growth', 'reach'], lore: firstParagraph(targetDir) };
};

// ── Orchestrace ──────────────────────────────────────────────────────────────
export interface SynthesizeOptions {
  provider: LlmProvider;
  write?: boolean;
  limit?: number;
  severka?: Severka;
  concurrency?: number; // kolik uzlů paralelně (default 4)
  onProgress?: (done: number, total: number, outcome: NodeOutcome) => void;
}

export interface NodeOutcome {
  id: string;
  path: string;
  status: 'written' | 'valid-dryrun' | 'invalid' | 'no-story' | 'skipped';
  pillar?: string;
  role?: string;
  grounded?: boolean;
  errors?: string[];
  manifest?: Record<string, any>;
}

export interface SynthesizeReport {
  totalNodes: number;
  storylessBefore: number;
  attempted: number;
  produced: number;
  validComplete: number;
  coverageBefore: number;
  coverageProjected: number;
  outcomes: NodeOutcome[];
}

const manifestPath = (targetDir: string, node: DerivedNode): string =>
  path.join(targetDir, node.path, 'vektor.json');

const assembleManifest = (
  node: DerivedNode,
  existing: Record<string, any>,
  story: StoryResult,
): Record<string, any> => ({
  ...existing,
  id: existing.id ?? node.id,
  story_axis: existing.story_axis ?? node.story_axis,
  semantic_layer: existing.semantic_layer ?? node.semantic_layer,
  state: existing.state ?? node.state,
  role: story.role,
  facets: existing.facets ?? node.facets,
  edges: existing.edges ?? node.edges,
  proofSignal: existing.proofSignal ?? node.proofSignal,
  identita: story.identita,
  smysl: story.smysl,
  smer: story.smer,
  duvod: story.duvod,
  myslenka: story.myslenka,
  pillar: story.pillar,
  loreLine: story.loreLine,
  promise: story.promise,
  antiFeature: story.antiFeature,
});

export const synthesize = async (
  targetDir: string,
  opts: SynthesizeOptions,
): Promise<SynthesizeReport> => {
  const severka = opts.severka ?? loadSeverka(targetDir);
  const hasManifests = fs.existsSync(targetDir) &&
    crawlNodes(targetDir, { nodeStrategy: 'manifest' }).length > 0;
  const nodes = crawlNodes(targetDir, { nodeStrategy: hasManifests ? 'manifest' : 'heuristic' });
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // existující manifesty + storyless detekce
  const existingByPath = new Map<string, Record<string, any>>();
  for (const n of nodes) {
    const mp = manifestPath(targetDir, n);
    existingByPath.set(n.path, fs.existsSync(mp) ? readManifest(mp) ?? {} : {});
  }
  const completeBefore = nodes.filter((n) => isStoryComplete(existingByPath.get(n.path)!));
  const storyless = nodes.filter((n) => !isStoryComplete(existingByPath.get(n.path)!));

  const targets = typeof opts.limit === 'number' ? storyless.slice(0, opts.limit) : storyless;

  interface PerNode {
    outcome: NodeOutcome;
    produced: boolean;
    valid: boolean;
  }

  const processNode = async (node: DerivedNode): Promise<PerNode> => {
    const bubble = buildBubble(node, nodes, targetDir);
    const parent = node.path.split('/').slice(0, -1).join('/');
    const siblings = nodes
      .filter((s) => s.id !== node.id && s.path.split('/').slice(0, -1).join('/') === parent)
      .map((s) => ({ id: s.id, promise: existingByPath.get(s.path)?.promise }));

    let story: StoryResult | null = null;
    try {
      story = await tellStory(opts.provider, bubble, severka, siblings, { timeoutMs: 120000 });
    } catch (e: any) {
      return {
        outcome: { id: node.id, path: node.path, status: 'invalid', errors: [String(e.message).slice(0, 120)] },
        produced: false,
        valid: false,
      };
    }
    if (!story) {
      return { outcome: { id: node.id, path: node.path, status: 'no-story' }, produced: false, valid: false };
    }
    const manifest = assembleManifest(node, existingByPath.get(node.path)!, story);
    const v = validateDerived(manifest);
    if (!v.ok) {
      return {
        outcome: { id: node.id, path: node.path, status: 'invalid', pillar: story.pillar, errors: v.errors },
        produced: true,
        valid: false,
      };
    }
    if (opts.write) {
      fs.writeFileSync(manifestPath(targetDir, node), JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
    }
    return {
      outcome: {
        id: node.id,
        path: node.path,
        status: opts.write ? 'written' : 'valid-dryrun',
        pillar: story.pillar,
        role: story.role,
        grounded: story.grounded,
        manifest,
      },
      produced: true,
      valid: true,
    };
  };

  // Bounded concurrency pool (zachovává pořadí ve výsledcích).
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const results: PerNode[] = new Array(targets.length);
  let cursor = 0;
  let done = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= targets.length) break;
      const r = await processNode(targets[i]);
      results[i] = r;
      done += 1;
      opts.onProgress?.(done, targets.length, r.outcome);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, () => worker()));

  const outcomes = results.map((r) => r.outcome);
  const produced = results.filter((r) => r.produced).length;
  const validComplete = results.filter((r) => r.valid).length;

  void byId;
  const total = nodes.length;
  return {
    totalNodes: total,
    storylessBefore: storyless.length,
    attempted: targets.length,
    produced,
    validComplete,
    coverageBefore: completeBefore.length / total,
    coverageProjected: (completeBefore.length + validComplete) / total,
    outcomes,
  };
};

// ── Plný 3-fázový průběh: zaštěrkat se strukturou → změnit ji → vektory+stories ──────────────
export interface PipelineReport {
  assessment: StructureAssessment;
  migration: MigrationResult | null;
  synthesis: SynthesizeReport;
}

export interface PipelineHooks {
  onPhase?: (
    phase: 'assess' | 'migrate' | 'skip-migrate' | 'synthesize-start',
    info: StructureAssessment | MigrationResult | null,
  ) => void;
}

export async function runPipeline(
  targetDir: string,
  opts: SynthesizeOptions,
  hooks: PipelineHooks = {},
): Promise<PipelineReport> {
  // FÁZE A — zaštěrkat s existující strukturou
  const assessment = assessStructure(targetDir);
  hooks.onPhase?.('assess', assessment);

  // FÁZE B — změnit strukturu (jen pokud ještě NEbyla změněna na vektor-tree)
  let migration: MigrationResult | null = null;
  if (assessment.alreadyMigrated) {
    hooks.onPhase?.('skip-migrate', assessment);
  } else {
    migration = materializeStructure(targetDir, { write: opts.write });
    hooks.onPhase?.('migrate', migration);
  }

  // FÁZE C — zařídit vektory + stories
  hooks.onPhase?.('synthesize-start', null);
  const synthesis = await synthesize(targetDir, opts);

  return { assessment, migration, synthesis };
}
