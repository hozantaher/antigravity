import 'dotenv/config';
import { RunPodClient } from './runpod-client';
import { execSync } from 'child_process';
import * as fs from 'fs';
import axios from 'axios';
import * as path from 'path';

const OLLAMA_PORT = 11434;
const MODEL = process.env.RUNPOD_LLM_MODEL || 'qwen2.5:14b-instruct';
const URL_FILE = '/tmp/runpod_llm_url';
const POD_FILE = '/tmp/runpod_llm_pod';

async function pullModel(url: string, timeoutS = 600) {
  console.log(`[Setup] Odesílám požadavek na stáhnutí modelu ${MODEL}...`);
  try {
    // We pass stream: false so the request blocks until the pull finishes
    await axios.post(`${url}/api/pull`, { name: MODEL, stream: false }, { timeout: timeoutS * 1000 });
  } catch (e: any) {
    throw new Error(`[Setup] Chyba při stahování modelu: ${e.message}`);
  }
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

async function up() {
  const rp = new RunPodClient();
  const balance = await rp.balance();
  console.log(`[Setup] Zůstatek RunPod: $${balance.toFixed(2)} · Model: ${MODEL}`);
  
  console.log('[Setup] Provisioning GPU Pod na RunPodu (Ollama Image)...');
  // We can pass a dummy pubkey since we don't need SSH anymore
  const pod = await rp.provision('dummy-key', 45, OLLAMA_PORT);
  fs.writeFileSync(POD_FILE, pod.id, 'utf-8');
  
  console.log(`[Setup] Pod ${pod.id} spuštěn na ${pod.gpu} ($${pod.costPerHour}/hod).`);
  console.log(`[Setup] Čekám na naběhnutí proxy (API: ${pod.proxyUrl})...`);
  
  // Wait for the Ollama API to be reachable
  const isReady = await waitForProxy(pod.proxyUrl, 300);
  if (!isReady) {
    throw new Error('[Setup] Proxy neodpovídá ani po 5 minutách.');
  }

  console.log(`[Setup] Ollama běží! Stahuji model (toto může trvat několik minut)...`);
  await pullModel(pod.proxyUrl);

  fs.writeFileSync(URL_FILE, pod.proxyUrl, 'utf-8');
  console.log(`[Setup] ✅ LLM BĚŽÍ a model je připraven. URL uložena do ${URL_FILE}`);
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
  console.log(`[Teardown] Pod ${podId} byl terminován. LLM je vypnuto.`);
}

const action = process.argv[2];
if (action === '--down') {
  down().catch(console.error);
} else {
  up().catch(console.error);
}
