import fs from 'fs';
import path from 'path';
import { VektorManifest } from './types';

export class ContextAwareScaffolder {
  private rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  public generateNode(nodeId: string, pathHint: string): string[] {
    const report: string[] = [];
    const fullPath = path.join(this.rootDir, pathHint);

    // 1. Context Inference
    const parts = pathHint.split(path.sep);
    const storyAxis = parts[0] || 'unknown';
    report.push(`INFERRED: Story Axis = '${storyAxis}'`);

    // 2. Scaffold Folder Structure
    if (fs.existsSync(fullPath)) {
      throw new Error(`Path ${fullPath} already exists.`);
    }
    fs.mkdirSync(fullPath, { recursive: true });
    report.push(`CREATED: Directory ${fullPath}`);

    // 3. Generate vektor.json
    const manifest: VektorManifest = {
      id: nodeId,
      story_axis: storyAxis,
      state: 'pending',
      facets: {
        ui: [`./${nodeId}.vue`],
      },
      edges: [],
    };
    fs.writeFileSync(path.join(fullPath, 'vektor.json'), JSON.stringify(manifest, null, 2));
    report.push(`CREATED: vektor.json (State: pending)`);

    // 4. Generate boilerplate dense file
    const uiContent = `<template>\n  <div>${nodeId}</div>\n</template>\n`;
    fs.writeFileSync(path.join(fullPath, `${nodeId}.vue`), uiContent);
    report.push(`CREATED: Boilerplate UI facet (${nodeId}.vue)`);

    // 5. Smart Link Injection (Backend stub)
    const backendDir = path.join(this.rootDir, '@server', 'api', storyAxis);
    fs.mkdirSync(backendDir, { recursive: true });
    const backendFile = path.join(backendDir, `${nodeId}.ts`);
    const backendContent = `// @vek` + `tor-link: ${nodeId}\nexport default function() {\n  // TODO: implement logic\n}\n`;
    fs.writeFileSync(backendFile, backendContent);
    report.push(`CREATED: Framework-pinned backend stub at ${backendFile} with reverse link`);

    return report;
  }
}
