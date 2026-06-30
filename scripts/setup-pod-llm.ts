import 'dotenv/config';
import { RunPodClient } from './runpod-client';
import { execSync } from 'child_process';
import * as fs from 'fs';
import axios from 'axios';
import * as path from 'path';

const OLLAMA_PORT = 11434;
const MODEL = process.env.RUNPOD_LLM_MODEL || 'qwen2.5:14b-instruct';
const DISK_GB = /(?:32b|70b|72b)/i.test(MODEL) ? 50 : 30; // velký model = víc container disku na pull
const URL_FILE = '/tmp/runpod_llm_url';
const POD_FILE = '/tmp/runpod_llm_pod';
const MODEL_FILE = '/tmp/runpod_llm_model';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pullModel(url: string, timeoutS = 900): Promise<string> {
  // qwen2.5:14b je instruct varianta se stejným chováním → fallback, když přesný tag 404.
  const tags = [MODEL, ...(MODEL !== 'qwen2.5:14b' ? ['qwen2.5:14b'] : [])];
  let lastErr: any;
  for (const tag of tags) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`[Setup] Stahuji ${tag} (pokus ${attempt}/3)...`);
        // stream:false → request blokuje do dokončení; posíláme model i name (různé verze Ollama)
        await axios.post(
          `${url}/api/pull`,
          { model: tag, name: tag, stream: false },
          { timeout: timeoutS * 1000 },
        );
        return tag;
      } catch (e: any) {
        lastErr = e;
        const code = e.response?.status ?? e.message;
        console.log(`[Setup]   pull selhal (${code}); čekám 15 s a zkouším znovu...`);
        await sleep(15000);
      }
    }
  }
  throw new Error(`[Setup] Stahování modelu selhalo i po retry: ${lastErr?.message}`);
}
async function waitForProxy(url: string, timeoutS = 240): Promise<boolean> {
  const deadline = Date.now() + timeoutS * 1000;
  while (Date.now() < deadline) {
    try {
      // Stačí pingnout kořen, který Ollama odpoví 200 "Ollama is running"
      const res = await axios.get(`${url}/`, { timeout: 10000 });
      if (res.status === 200) {
        return true;
      }
    } catch (e) {
      // Ignore errors during polling
    }
    await new Promise(r => setTimeout(r, 8000));
  }
  return false;
}

// Fallback seznam: COMMUNITY (levnější/dostupnější) → SECURE. 24/20/16GB stačí na qwen2.5:14b.
const GPU_CANDIDATES: { gpu: string; cloud: string }[] = [
  { gpu: 'NVIDIA GeForce RTX 3090', cloud: 'COMMUNITY' },
  { gpu: 'NVIDIA GeForce RTX 4090', cloud: 'COMMUNITY' },
  { gpu: 'NVIDIA GeForce RTX 5090', cloud: 'COMMUNITY' },
  { gpu: 'NVIDIA RTX A5000', cloud: 'COMMUNITY' },
  { gpu: 'NVIDIA RTX 4000 Ada Generation', cloud: 'COMMUNITY' },
  { gpu: 'NVIDIA GeForce RTX 3090', cloud: 'SECURE' },
  { gpu: 'NVIDIA GeForce RTX 4090', cloud: 'SECURE' },
  { gpu: 'NVIDIA GeForce RTX 5090', cloud: 'SECURE' },
  { gpu: 'NVIDIA RTX 4000 Ada Generation', cloud: 'SECURE' },
  { gpu: 'NVIDIA L4', cloud: 'SECURE' },
  { gpu: 'NVIDIA RTX 2000 Ada Generation', cloud: 'SECURE' },
];

// VRAM (GB) per GPU — aby se velký model nenasadil na kartu, kde OOMne při inferenci.
const GPU_VRAM: Record<string, number> = {
  'NVIDIA GeForce RTX 5090': 32,
  'NVIDIA GeForce RTX 4090': 24,
  'NVIDIA GeForce RTX 3090': 24,
  'NVIDIA RTX A5000': 24,
  'NVIDIA L4': 24,
  'NVIDIA RTX 4000 Ada Generation': 20,
  'NVIDIA RTX 2000 Ada Generation': 16,
};

async function up() {
  const rp = new RunPodClient();
  console.log(`[Setup] Model: ${MODEL}`);

  // RUNPOD_GPU override → vyzkoušej preferovanou GPU první (community i secure), pak fallback list.
  const preferred = process.env.RUNPOD_GPU;
  const minVram = /32b/i.test(MODEL) ? 24 : /(?:70b|72b)/i.test(MODEL) ? 48 : 0;
  const candidates = (
    preferred
      ? [{ gpu: preferred, cloud: 'COMMUNITY' }, { gpu: preferred, cloud: 'SECURE' }, ...GPU_CANDIDATES]
      : GPU_CANDIDATES
  ).filter((c) => (GPU_VRAM[c.gpu] ?? 24) >= minVram);
  if (!candidates.length) {
    throw new Error(`[Setup] Model ${MODEL} chce GPU ≥${minVram}GB, žádná taková v seznamu — vezmi menší model nebo doplň větší GPU.`);
  }

  let pod: any = null;
  for (const c of candidates) {
    try {
      console.log(`[Setup] Zkouším ${c.gpu} (${c.cloud})...`);
      pod = await rp.provision('dummy-key', DISK_GB, OLLAMA_PORT, c.gpu, c.cloud);
      console.log(`[Setup] ✓ Nasazeno: ${c.gpu} (${c.cloud})`);
      break;
    } catch (e: any) {
      // Pokračuj na DALŠÍ variantu při JAKÉKOLIV provision chybě (supply constraint, "machine does
      // not have the resources", …) — ne jen u supply. Throw až když selžou všechny (níže).
      const msg = String(e.message || e).replace(/\s+/g, ' ').slice(0, 90);
      console.log(`[Setup]   ${c.gpu} (${c.cloud}) nešlo: ${msg} — zkouším další...`);
      continue;
    }
  }
  if (!pod) throw new Error('[Setup] Žádná GPU varianta není momentálně dostupná.');
  fs.writeFileSync(POD_FILE, pod.id, 'utf-8');
  
  console.log(`[Setup] Pod ${pod.id} spuštěn na ${pod.gpu} ($${pod.costPerHour}/hod).`);
  console.log(`[Setup] Čekám na naběhnutí proxy (API: ${pod.proxyUrl})...`);
  
  // Wait for the Ollama API to be reachable
  const isReady = await waitForProxy(pod.proxyUrl, 300);
  if (!isReady) {
    throw new Error('[Setup] Proxy neodpovídá ani po 5 minutách.');
  }

  console.log(`[Setup] Ollama běží! Warmup 10 s, pak stahuji model (může trvat několik minut)...`);
  await sleep(10000);
  const actualModel = await pullModel(pod.proxyUrl);

  fs.writeFileSync(URL_FILE, pod.proxyUrl, 'utf-8');
  fs.writeFileSync(MODEL_FILE, actualModel, 'utf-8');
  console.log(`[Setup] ✅ LLM BĚŽÍ, model ${actualModel} připraven. URL → ${URL_FILE}`);
  console.log(`[Setup] Proxy URL: ${pod.proxyUrl}`);
}

async function down() {
  if (!fs.existsSync(POD_FILE)) {
    console.log(`[Teardown] Žádný běžící pod nebyl nalezen (${POD_FILE} chybí).`);
    return;
  }
  const podId = fs.readFileSync(POD_FILE, 'utf-8').trim();
  const rp = new RunPodClient();
  await rp.terminate(podId);
  fs.unlinkSync(POD_FILE);
  if (fs.existsSync(URL_FILE)) fs.unlinkSync(URL_FILE);
  if (fs.existsSync(MODEL_FILE)) fs.unlinkSync(MODEL_FILE);
  console.log(`[Teardown] Pod ${podId} byl terminován. LLM je vypnuto.`);
}

const action = process.argv[2];
if (action === '--down') {
  down().catch(console.error);
} else {
  up().catch(console.error);
}
