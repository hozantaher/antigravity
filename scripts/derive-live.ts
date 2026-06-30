/**
 * Jeden příkaz: nahodí RunPod LLM → spustí synthesizer nad cílovým repem → VŽDY pod vypne.
 *
 *   npx ts-node scripts/derive-live.ts <targetDir> [--limit N] [--write]
 *
 * Default = dry-run (nic nezapíše, jen ukáže vygenerované manifesty live).
 * Teardown běží i při chybě/Ctrl-C (finally), takže pod nezůstane točit peníze.
 * Předpoklad: RUNPOD_API_KEY v .env (gitignored).
 */
import 'dotenv/config';
import { spawnSync } from 'child_process';
import * as fs from 'fs';

const URL_FILE = '/tmp/runpod_llm_url';
const passthru = process.argv.slice(2);
// --model <tag>: model pro provisioning (setup-pod-llm čte RUNPOD_LLM_MODEL); vyřízni z passthru
const mi = passthru.indexOf('--model');
if (mi >= 0 && passthru[mi + 1]) {
  process.env.RUNPOD_LLM_MODEL = passthru[mi + 1];
  passthru.splice(mi, 2);
}
// --gpu "<gpuTypeId>": vynutí konkrétní GPU pro provisioning (setup-pod-llm čte RUNPOD_GPU)
const gi = passthru.indexOf('--gpu');
if (gi >= 0 && passthru[gi + 1]) {
  process.env.RUNPOD_GPU = passthru[gi + 1];
  passthru.splice(gi, 2);
}

const npx = (args: string[]) => spawnSync('npx', args, { stdio: 'inherit' }).status ?? 1;

const main = () => {
  if (!passthru.length || passthru[0].startsWith('--')) {
    console.error(
      'Použití: npx ts-node scripts/derive-live.ts <targetDir> [--limit N] [--concurrency N] [--write] [--model <tag>] [--gpu "<name>"]',
    );
    process.exit(1);
  }
  if (!process.env.RUNPOD_API_KEY) {
    console.error('✗ Chybí RUNPOD_API_KEY v .env');
    process.exit(2);
  }

  try {
    // Vyčisti stale /tmp z dřívějšího (už mrtvého) podu — jinak by check níže uvěřil staré URL
    // a synthesizer by jel proti mrtvému endpointu (→ tiše samé "no-story").
    for (const f of [URL_FILE, '/tmp/runpod_llm_pod', '/tmp/runpod_llm_model']) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
    console.log('▶ [1/3] Provisioning RunPod LLM (GPU pod + model pull, několik minut)...');
    npx(['ts-node', 'scripts/setup-pod-llm.ts']);

    if (!fs.existsSync(URL_FILE)) {
      console.error('✗ Pod se nepodařilo nahodit (žádná dostupná GPU varianta?). Končím.');
      return;
    }
    console.log(`▶ [2/3] LLM běží (${fs.readFileSync(URL_FILE, 'utf-8').trim()}). Spouštím synthesizer...\n`);
    npx(['ts-node', '--transpile-only', 'scripts/synthesize-cli.ts', ...passthru]);
  } finally {
    console.log('\n▶ [3/3] Teardown podu (zastavuji účtování)...');
    npx(['ts-node', 'scripts/setup-pod-llm.ts', '--down']);
  }
};

main();
