import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import { VektorManifest } from './types';
import { TransactionalRefactorEngine } from './refactor';

export class BatchMigrator {
  private rootDir: string;
  private refactorEngine: TransactionalRefactorEngine;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    this.refactorEngine = new TransactionalRefactorEngine(rootDir);
  }

  public async migrateAllLegacy(): Promise<void> {
    const legacyFiles = await glob('products/**/vektor.json', {
      cwd: this.rootDir,
      ignore: 'node_modules/**',
    });

    if (legacyFiles.length === 0) {
      console.log('Žádné uzly k migraci (v karanténě products/) nenalezeny.');
      return;
    }

    console.log(`Nalezeno ${legacyFiles.length} uzlů. Zahajuji dávkový (Batch) Lift & Shift...\\n`);

    let successCount = 0;
    for (const file of legacyFiles) {
      const fullPath = path.join(this.rootDir, file);
      try {
        const manifest = JSON.parse(fs.readFileSync(fullPath, 'utf8')) as VektorManifest;
        const axis = manifest.story_axis || 'unknown';
        const id = manifest.id;
        const targetDir = path.join('spine', axis, id);

        console.log(`🚀 Přesunuji uzel: ${id} -> ${targetDir}`);
        
        await this.refactorEngine.executeRename(id, id, targetDir);
        successCount++;
      } catch (e: any) {
        console.error(`⚠️ Chyba při migraci uzlu v ${file}: ${e.message}`);
      }
    }
    
    console.log(`\\n✅ Transakce dokončena. Úspěšně přesunuto ${successCount} z ${legacyFiles.length} uzlů do páteře.`);
  }
}
