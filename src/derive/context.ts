import * as fs from 'fs';
import * as path from 'path';
import { DerivedNode } from './structure';

/**
 * Context bubble — grounding pro LLM (P3).
 *
 * Rozšiřuje engine.resolveContext (které je 1-hop, src/engine.ts:91-127) o:
 *  - extrakci EXPORTOVANÝCH SYMBOLŮ z kódu uzlu (na čem se dá story „uzemnit"),
 *  - k-hop BFS přes edges (ne jen 1-hop),
 *  - kompaktní textový blok pro prompt.
 *
 * Smysl: storyteller (P4) dostane reálné symboly/soubory; grounding-gate pak odmítne narativu,
 * která nereferencuje NIC z uzlu (první obrana proti generické halucinaci „Bijící srdce modulu").
 */

export interface NodeBubble {
  id: string;
  path: string;
  story_axis: string;
  role: string;
  semantic_layer: string;
  files: string[];
  symbols: string[];
  neighbors: { id: string; symbols: string[] }[];
  snippet: string;
  /** Slovník reálných tokenů (symboly + názvy souborů) pro grounding check v P4. */
  groundingTokens: Set<string>;
}

const EXPORT_RE =
  /export\s+(?:default\s+)?(?:async\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
const NAMED_RE = /export\s*\{([^}]+)\}/g;

/** Vytáhne exportované symboly ze souboru (regex; konzistentní se stylem governor.ts). */
export const extractSymbols = (content: string, file: string): string[] => {
  const out = new Set<string>();
  if (file.endsWith('.vue')) {
    // SFC: jméno komponenty = basename v PascalCase
    out.add(path.basename(file).replace(/\.vue$/, ''));
  }
  let m: RegExpExecArray | null;
  EXPORT_RE.lastIndex = 0;
  while ((m = EXPORT_RE.exec(content))) if (m[1]) out.add(m[1]);
  NAMED_RE.lastIndex = 0;
  while ((m = NAMED_RE.exec(content))) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) out.add(name);
    }
  }
  return [...out];
};

const readFileSafe = (p: string): string => {
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return '';
  }
};

const allNodeFiles = (node: DerivedNode): string[] =>
  Object.values(node.facets).flat().length
    ? Object.values(node.facets).flat()
    : node.files;

/** Symboly celého uzlu (přes všechny jeho soubory). */
const nodeSymbols = (node: DerivedNode, targetDir: string): string[] => {
  const syms = new Set<string>();
  for (const rel of allNodeFiles(node)) {
    const abs = path.join(targetDir, node.path, rel.replace(/^\.\//, ''));
    for (const s of extractSymbols(readFileSafe(abs), abs)) syms.add(s);
  }
  return [...syms];
};

export interface BubbleOptions {
  hops?: number; // default 1
  maxSymbols?: number; // default 40
  snippetLines?: number; // default 30
}

export const buildBubble = (
  node: DerivedNode,
  allNodes: DerivedNode[],
  targetDir: string,
  opts: BubbleOptions = {},
): NodeBubble => {
  const hops = opts.hops ?? 1;
  const maxSymbols = opts.maxSymbols ?? 40;
  const byId = new Map(allNodes.map((n) => [n.id, n]));

  const symbols = nodeSymbols(node, targetDir).slice(0, maxSymbols);

  // k-hop BFS přes edges
  const seen = new Set<string>([node.id]);
  let frontier = [...node.edges];
  const neighborIds: string[] = [];
  for (let h = 0; h < hops && frontier.length; h++) {
    const next: string[] = [];
    for (const id of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      neighborIds.push(id);
      const nb = byId.get(id);
      if (nb) next.push(...nb.edges);
    }
    frontier = next;
  }
  const neighbors = neighborIds.map((id) => {
    const nb = byId.get(id);
    return { id, symbols: nb ? nodeSymbols(nb, targetDir).slice(0, 8) : [] };
  });

  // úryvek nejdelšího logic/api souboru (nejpravděpodobnější jádro)
  const candidates = [...(node.facets.logic ?? []), ...(node.facets.api ?? []), ...node.files];
  let snippet = '';
  if (candidates[0]) {
    const abs = path.join(targetDir, node.path, candidates[0].replace(/^\.\//, ''));
    snippet = readFileSafe(abs).split('\n').slice(0, opts.snippetLines ?? 30).join('\n');
  }

  const groundingTokens = new Set<string>([
    node.id,
    ...symbols.map((s) => s.toLowerCase()),
    ...allNodeFiles(node).map((f) => path.basename(f).replace(/\.[^.]+$/, '').toLowerCase()),
  ]);

  return {
    id: node.id,
    path: node.path,
    story_axis: node.story_axis,
    role: node.role,
    semantic_layer: node.semantic_layer,
    files: allNodeFiles(node),
    symbols,
    neighbors,
    snippet,
    groundingTokens,
  };
};

/** Kompaktní textový blok do promptu. */
export const bubbleToPrompt = (b: NodeBubble): string => {
  const lines = [
    `UZEL: ${b.id}  (osa: ${b.story_axis}, role: ${b.role}, vrstva: ${b.semantic_layer})`,
    `CESTA: ${b.path}`,
    `SOUBORY (${b.files.length}): ${b.files.slice(0, 20).join(', ')}`,
    `EXPORTOVANÉ SYMBOLY: ${b.symbols.join(', ') || '—'}`,
    `SOUSEDÉ: ${b.neighbors.map((n) => `${n.id}${n.symbols.length ? ` [${n.symbols.slice(0, 4).join(', ')}]` : ''}`).join('; ') || '—'}`,
  ];
  if (b.snippet) lines.push(`ÚRYVEK JÁDRA:\n${b.snippet}`);
  return lines.join('\n');
};
