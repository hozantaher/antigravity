import fs from 'fs';
import path from 'path';

export class ContextGenerator {
  private root: string;

  constructor(root: string) {
    this.root = root;
  }

  private walkDir(dir: string, callback: (path: string) => void) {
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir).forEach(f => {
      const dirPath = path.join(dir, f);
      const isDirectory = fs.statSync(dirPath).isDirectory();
      isDirectory ? this.walkDir(dirPath, callback) : callback(dirPath);
    });
  }

  public generateDenseContext(dense: boolean = true): string {
    const spineDir = path.join(this.root, 'spine');
    let mdContent = '# 🧠 Antigravity Dense Context Bundle\n\n';

    let coreTypesFiles: string[] = [];
    this.walkDir(path.join(spineDir, 'domain/core-types'), (p: string) => {
      if (p.endsWith('.ts') && !p.endsWith('.test.ts')) coreTypesFiles.push(p);
    });

    mdContent += '## 📜 Core Types (Byznysový slovník)\n\n';
    for (const file of coreTypesFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      const relativePath = path.relative(spineDir, file);
      mdContent += `### \`spine/${relativePath}\`\n\`\`\`typescript\n${content}\n\`\`\`\n\n`;
    }

    let indexFiles: string[] = [];
    this.walkDir(spineDir, (p: string) => {
      if (p.endsWith('index.ts') && !p.includes('core-types')) indexFiles.push(p);
    });

    mdContent += '## 🔌 Veřejné kontrakty uzlů (Node Boundaries)\n\n';
    for (const file of indexFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      const relativePath = path.relative(spineDir, file);
      mdContent += `### \`spine/${relativePath}\`\n\`\`\`typescript\n${content}\n\`\`\`\n\n`;
    }

    if (dense) {
      // Zjednodušené odstraňování prázdných řádků pro kompresi
      mdContent = mdContent.replace(/^\s*[\r\n]/gm, '');
    }

    return mdContent;
  }
}
