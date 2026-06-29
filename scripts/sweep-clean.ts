import { execSync } from 'child_process';
import * as fs from 'fs';

console.log('Zahajuji odstraňování osiřelých uzlů (Dead Code Elimination)...');
try {
  execSync('npm run ag:audit -- --sweep', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
} catch (e: any) {
  const output = e.stdout || e.message || '';
  const lines = output.split('\n');
  let deletedCount = 0;
  for (const line of lines) {
    if (line.includes('cesta: ')) {
      const match = line.match(/cesta: ([^)]+)\)/);
      if (match && match[1]) {
        const p = match[1];
        if (fs.existsSync(p)) {
          console.log(`🗑️ Odstraňuji osiřelý uzel: ${p}`);
          fs.rmSync(p, { recursive: true, force: true });
          deletedCount++;
        }
      }
    }
  }
  console.log(`\n✅ Odstraněno ${deletedCount} mrtvých uzlů.`);
}
