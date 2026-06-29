import { CyberneticGovernor } from '../src/governor';
import fs from 'fs';
import path from 'path';

async function run() {
  console.log('Spouštím Inverted Fault Harness...');
  const rootDir = process.cwd();
  
  // Vytvoříme validní uzel 'sale' a 'supply'
  const spineDir = path.join(rootDir, 'spine');
  const dummyDir = path.join(spineDir, 'inverted-fault');
  
  if (!fs.existsSync(dummyDir)) fs.mkdirSync(dummyDir, { recursive: true });
  
  const manifest = {
    id: "inverted-fault",
    story_axis: "spine",
    state: "pending",
    facets: {
      logic: ["./logic.ts"]
    },
    edges: []
  };
  fs.writeFileSync(path.join(dummyDir, 'vektor.json'), JSON.stringify(manifest, null, 2));
  
  // Vložíme kód s legitimním importem a netypickým magic commentem
  // Governor vyžaduje regex: /\/\/\s*@vektor-link:\s*([\w-]+)/g
  // Pokud přidáme mezeru uvnitř slova, nebo něco podobného, mohlo by to spustit false positive
  
  const logicCode = `
  // Toto je validní komentář:
  // @vektor-link: sale
  
  // Toto je také validní, ale velmi zvláštně naformátovaný:
  //      @vektor-link:     supply   
  
  export const hello = "world";
  `;
  
  fs.writeFileSync(path.join(dummyDir, 'logic.ts'), logicCode);
  
  const governor = new CyberneticGovernor(rootDir, false, false);
  const report = await governor.audit();
  
  const relevantReports = report.filter(r => r.includes('inverted-fault') || r.includes('logic.ts'));
  
  console.log('\n--- Governor Report pro Inverted Fault ---');
  if (relevantReports.length > 0) {
    console.log(relevantReports.join('\n'));
    console.log('❌ Detekován False Positive! Governor ohlásil chybu na validním kódu.');
  } else {
    console.log('✅ Governor úspěšně přešel Inverted Fault (žádné False Positives).');
  }
  
  // Úklid
  fs.rmSync(dummyDir, { recursive: true, force: true });
}

run();
