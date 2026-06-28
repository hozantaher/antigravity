import { Command } from 'commander';
import { UnifiedVectorEngine } from './engine';
import { CyberneticGovernor } from './governor';
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

program.parse(process.argv);
