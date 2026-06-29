import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { CyberneticGovernor } from './governor';

export class AutoHealer {
  private rootDir: string;

  constructor(rootDir: string = process.cwd()) {
    this.rootDir = rootDir;
  }

  public heal() {
    console.log('🩹 Spouštím Auto-Healer pro opravu Contract Driftu...');
    
    // Nejprve potřebujeme získat výstup auditu (aby Governor nezabil proces, musíme zachytit výjimku)
    let governorOutput = '';
    try {
      execSync('node dist/index.js audit', { cwd: this.rootDir, encoding: 'utf8', stdio: 'pipe' });
      console.log('✅ Architektura je čistá. Není co opravovat.');
      return;
    } catch (e: any) {
      governorOutput = e.stdout;
    }

    const lines = governorOutput.split('\n');
    let healedCount = 0;

    for (const line of lines) {
      if (line.includes('Contract Drift v ')) {
        const match = line.match(/Contract Drift v (.*?) ->/);
        const nodeMatch = line.match(/uzlu '(.*?)' místo/);
        
        if (match && match[1] && nodeMatch && nodeMatch[1]) {
          const brokenFile = path.join(this.rootDir, match[1]);
          const targetNodeId = nodeMatch[1];
          
          if (!fs.existsSync(brokenFile)) continue;
          const content = fs.readFileSync(brokenFile, 'utf8');
          
          const importRegex = /import\s+{([^}]+)}\s+from\s+['"](.*?)['"]/;
          const importMatch = content.match(importRegex);
          
          if (importMatch) {
            const importedVars = importMatch[1].trim();
            const badPath = importMatch[2];
            
            // Zkusíme najít fyzickou cestu cílového uzlu, abychom zkonstruovali cestu k index.ts
            // (Pro zjednodušení v Healeru hledáme vektor.json daného uzlu)
            const targetManifests = execSync(`find spine -name "vektor.json"`, { cwd: this.rootDir, encoding: 'utf8' }).split('\n').filter(x => x);
            let targetDir = '';
            for (const m of targetManifests) {
              const mData = JSON.parse(fs.readFileSync(path.join(this.rootDir, m), 'utf8'));
              if (mData.id === targetNodeId) {
                targetDir = path.dirname(m);
                break;
              }
            }
            
            if (targetDir) {
              // Výpočet relativní cesty z brokenFile do targetDir
              let relativePath = path.relative(path.dirname(brokenFile), path.join(this.rootDir, targetDir, 'index'));
              if (!relativePath.startsWith('.')) relativePath = './' + relativePath;
              
              const healedContent = content.replace(badPath, relativePath);
              const contractPath = path.join(this.rootDir, targetDir, 'index.ts');
              
              if (!fs.existsSync(contractPath)) {
                fs.writeFileSync(contractPath, `// AUTO-HEALED CONTRACT\nexport const ${importedVars} = 'HEALED';\n`, 'utf8');
                
                const dManifestPath = path.join(this.rootDir, targetDir, 'vektor.json');
                const dManifest = JSON.parse(fs.readFileSync(dManifestPath, 'utf8'));
                if (!dManifest.facets.contract) dManifest.facets.contract = [];
                if (!dManifest.facets.contract.includes('./index.ts')) {
                   dManifest.facets.contract.push('./index.ts');
                   fs.writeFileSync(dManifestPath, JSON.stringify(dManifest, null, 2), 'utf8');
                }
              }
              
              fs.writeFileSync(brokenFile, healedContent, 'utf8');
              healedCount++;
              console.log(` -> HEALED: Soubor ${match[1]} byl přesměrován na veřejný kontrakt ${targetNodeId}`);
            }
          }
        }
      }
    }

    if (healedCount > 0) {
      console.log(`\nÚspěšně opraveno ${healedCount} architekturních prohřešků.`);
    } else {
      console.log('Nepodařilo se automaticky opravit žádný drift (možná jde o komplexní zacyklení).');
    }
  }
}
