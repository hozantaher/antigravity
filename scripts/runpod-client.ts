import axios from 'axios';

export class RunPodClient {
  private apiKey: string;
  private endpoint = 'https://api.runpod.io/graphql';

  constructor() {
    this.apiKey = process.env.RUNPOD_API_KEY || '';
    if (!this.apiKey) {
      console.warn('[RunPodClient] Chybí RUNPOD_API_KEY. Pokračuji v mock režimu.');
    }
  }

  private async query(gql: string, variables: any = {}) {
    if (!this.apiKey) return null; // Mock fallback
    
    try {
      const response = await axios.post(
        `${this.endpoint}?api_key=${this.apiKey}`,
        { query: gql, variables },
        { headers: { 'Content-Type': 'application/json' } }
      );
      
      if (response.data.errors) {
        throw new Error(`RunPod GraphQL Error: ${JSON.stringify(response.data.errors)}`);
      }
      return response.data.data;
    } catch (err: any) {
      if (err.response && err.response.data) {
        console.error('RunPod API Failed with:', JSON.stringify(err.response.data, null, 2));
      }
      throw err;
    }
  }

  public async balance(): Promise<number> {
    if (!this.apiKey) return 10.0;
    const q = `query { myself { id } }`;
    await this.query(q);
    return 0; // Balance field no longer exists on User
  }

  public async provision(
    pubKey: string,
    diskGb: number,
    port: number,
    gpuTypeId = 'NVIDIA RTX A5000',
    cloudType = 'SECURE',
  ): Promise<any> {
    if (!this.apiKey) {
      // MOCK
      return {
        id: `mock-pod-${Math.random().toString(36).substr(2, 6)}`,
        ip: '127.0.0.1',
        port: 2222,
        proxyUrl: `https://mock-proxy-url-11434.proxy.runpod.net`,
        gpu: 'Mock-RTX-3090',
        costPerHour: 0.20
      };
    }

    const q = `
      mutation podFindAndDeployOnDemand($input: PodFindAndDeployOnDemandInput!) {
        podFindAndDeployOnDemand(input: $input) {
          id
          machine { podHostId }
          costPerHr
        }
      }
    `;
    const vars = {
      input: {
        cloudType,
        gpuCount: 1,
        volumeInGb: 0, // one-shot běh nepotřebuje perzistentní volume → menší nárok na stroj
        containerDiskInGb: diskGb,
        minVcpuCount: 2,
        minMemoryInGb: 15,
        gpuTypeId,
        name: 'Antigravity LLM Brain',
        imageName: 'ollama/ollama', // Oficialni image s rovnou běžícím API
        dockerArgs: '',
        ports: `${port}/http`,
        volumeMountPath: '/workspace',
        env: [
          { key: 'PUBLIC_KEY', value: pubKey },
          { key: 'OLLAMA_HOST', value: '0.0.0.0' }
        ]
      }
    };
    
    const res = await this.query(q, vars);
    const pod = res.podFindAndDeployOnDemand;
    
    return {
      id: pod.id,
      ip: 'x.x.x.x', // V produkci je potřeba počkat na start a získat IP z pod(id) query
      port: 22,
      proxyUrl: `https://${pod.id}-${port}.proxy.runpod.net`,
      gpu: 'NVIDIA RTX 3090',
      costPerHour: pod.costPerHr
    };
  }

  public async terminate(podId: string) {
    if (!this.apiKey) return;
    const q = `
      mutation podTerminate($input: PodTerminateInput!) {
        podTerminate(input: $input)
      }
    `;
    await this.query(q, { input: { podId } });
  }
}
