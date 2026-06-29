import { Command } from 'commander';
import { UnifiedVectorEngine } from './engine';
import { CyberneticGovernor } from './governor';
import { TransactionalRefactorEngine } from './refactor';
import { MCPServer } from './mcp';
import { ContextAwareScaffolder } from './scaffold';
import { FuzzyVectorRouter } from './router';
import { DiaryManager } from './diary';
import { DocGenerator } from './docs';
import path from 'path';
import fs from 'fs';

const program = new Command();

program
  .name('antigravity')
  .description('CLI pro správu adresářového stromu jako vektorové databáze (Antigravity Engine)')
  .version('1.0.0');

program
  .command('resolve <nodeId>')
  .description('Resolvuje kontext pro daný uzel (dense files, reverse links, hrany)')
  .action(async (nodeId: string) => {
    const root = process.cwd();
    const engine = new UnifiedVectorEngine(root);
    await engine.scan();

    const context = engine.resolveContext(nodeId);
    if (!context) {
      console.error(`Uzel ${nodeId} nebyl nalezen.`);
      process.exit(1);
    }

    console.log(JSON.stringify(context, null, 2));
  });

program
  .command('audit')
  .description('Spustí detekci architektonického driftu a vypíše report')
  .option('--heal', 'Automaticky opraví nalezené drifty')
  .option('--sweep', 'Detekuje osiřelé uzly (mrtvý kód) bez vazeb')
  .action(async (options) => {
    const root = process.cwd();
    const governor = new CyberneticGovernor(root, options.heal, options.sweep);
    const report = await governor.audit();

    if (report.length === 0) {
      console.log('Architektura je 100% čistá. Žádný drift nebyl detekován.');
    } else {
      console.log(report.join('\n'));
      if (!options.heal) {
        process.exit(1);
      }
    }
  });

program
  .command('rename <oldId> <newId> [newPath]')
  .description(
    'Přejmenuje a přesune uzel napříč celou architekturou včetně Gitu a reverzních vazeb'
  )
  .action(async (oldId: string, newId: string, newPath?: string) => {
    const root = process.cwd();
    const refactor = new TransactionalRefactorEngine(root);
    try {
      await refactor.executeRename(oldId, newId, newPath);
    } catch (e: any) {
      console.error(`Chyba refaktoringu: ${e.message}`);
      process.exit(1);
    }
  });

program
  .command('mcp')
  .description(
    'Spustí Model Context Protocol (MCP) server na standardním vstupu/výstupu pro integraci s AI (Claude/Cursor)'
  )
  .action(() => {
    const root = process.cwd();
    const mcpServer = new MCPServer(root);
    mcpServer.listen();
  });

program
  .command('create <nodeId> <pathHint>')
  .description(
    'Vytvoří nový uzel stromu, odhadne kontext a vygeneruje boilerplate i reverzní linky'
  )
  .action((nodeId: string, pathHint: string) => {
    const root = process.cwd();
    const scaffolder = new ContextAwareScaffolder(root);
    try {
      const report = scaffolder.generateNode(nodeId, pathHint);
      console.log(report.join('\n'));
    } catch (e: any) {
      console.error(`Chyba při zakládání uzlu: ${e.message}`);
      process.exit(1);
    }
  });

program
  .command('search <query>')
  .description('Fuzzy sémantické hledání v repozitáři přes vektorové uzly')
  .action(async (query: string) => {
    const root = process.cwd();
    const router = new FuzzyVectorRouter(root);
    try {
      const results = await router.search(query);
      if (results.length === 0) {
        console.log('Žádné výsledky.');
      } else {
        console.log(JSON.stringify(results, null, 2));
      }
    } catch (e: any) {
      console.error(`Chyba při hledání: ${e.message}`);
      process.exit(1);
    }
  });

program
  .command('diary <action> [message...]')
  .description('Správa autonomního deníčku (např. log)')
  .action((action: string, messageArgs: string[]) => {
    const root = process.cwd();
    const diary = new DiaryManager(root);
    if (action === 'log') {
      const message = messageArgs.join(' ');
      diary.logAction('Human', 'MANUAL_LOG', message);
      console.log('Záznam úspěšně zapsán do deníčku.');
    } else {
      console.error(`Neznámá akce '${action}'. Použijte např. "log".`);
      process.exit(1);
    }
  });

program
  .command('map')
  .description(
    'Vygeneruje docs/reference/topology-map.md s mapou vektorového stromu (Mermaid graf) pro AI agenty'
  )
  .option('--gravity', 'Vygeneruje speciální gravitační mapu založenou na reverse links (docs/reference/gravity-map.md)')
  .action(async (options) => {
    const root = process.cwd();
    const engine = new UnifiedVectorEngine(root);
    await engine.scan();
    
    if (options.gravity) {
      const md = engine.generateGravityMap();
      const outPath = path.join(root, 'docs', 'reference', 'gravity-map.md');
      fs.writeFileSync(outPath, md, 'utf8');
      console.log(`SUCCESS: Gravitational map generated at docs/reference/gravity-map.md`);
    } else {
      const md = engine.generateArchitectureMap();
      const outPath = path.join(root, 'docs', 'reference', 'topology-map.md');
      fs.writeFileSync(outPath, md, 'utf8');
      console.log(`SUCCESS: Architecture map generated at docs/reference/topology-map.md`);
    }
  });

program
  .command('docs')
  .description(
    'Automaticky vygeneruje dokumentaci z vektorových manifestů (docs/reference/autodocs.md)'
  )
  .option('--readme', 'Vygeneruje chybějící README.md soubory přímo do složek jednotlivých uzlů ve /spine/')
  .action(async (options) => {
    const root = process.cwd();
    const generator = new DocGenerator(root);
    if (options.readme) {
      await generator.generateNodeReadmes();
    } else {
      await generator.generate();
    }
  });

program
  .command('migrate <legacyPath>')
  .description('Automaticky vyhodnotí sémantiku legacy složky, přesune kód do /spine/ a opraví importy')
  .action(async (legacyPath: string) => {
    console.log(`Zahajuji experimentální Auto-Lift & Shift pro: ${legacyPath}`);
    // TBD: Plná implementace AI migrace (Fáze 2.1) v migrate.ts
    console.log(`Upozornění: Příkaz 'migrate' vyžaduje integraci na LLM klienta pro sémantickou analýzu.`);
  });

program.parse(process.argv);
