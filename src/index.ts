import { Command } from 'commander';
import { UnifiedVectorEngine } from './engine';
import { CyberneticGovernor } from './governor';
import { TransactionalRefactorEngine } from './refactor';
import { MCPServer } from './mcp';
import { ContextAwareScaffolder } from './scaffold';
import path from 'path';

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
  .action(async (options) => {
    const root = process.cwd();
    const governor = new CyberneticGovernor(root, options.heal);
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
  .description('Přejmenuje a přesune uzel napříč celou architekturou včetně Gitu a reverzních vazeb')
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
  .description('Spustí Model Context Protocol (MCP) server na standardním vstupu/výstupu pro integraci s AI (Claude/Cursor)')
  .action(() => {
    const root = process.cwd();
    const mcpServer = new MCPServer(root);
    mcpServer.listen();
  });

program
  .command('create <nodeId> <pathHint>')
  .description('Vytvoří nový uzel stromu, odhadne kontext a vygeneruje boilerplate i reverzní linky')
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

program.parse(process.argv);
