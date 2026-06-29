import { createServer } from 'http';
import type { Server } from 'http';

export interface HealthResponse {
  status: 'ok' | 'degraded';
  uptime_seconds: number;
  service: string;
  timestamp: string;
}

/**
 * Začátek doby běhu služby (pro výpočet uptime)
 */
let startTime = Date.now();

/**
 * Resetovat čas startu (hlavně pro testy)
 */
export function resetStartTime(): void {
  startTime = Date.now();
}

/**
 * Spustit minimální HTTP server na zadaném portu s /healthz endpointem
 */
export function startHealthServer(
  port: number,
  serviceName: string,
): Server {
  const server = createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'method not allowed' }));
      return;
    }

    if (req.url !== '/healthz') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
    const response: HealthResponse = {
      status: 'ok',
      uptime_seconds: uptimeSeconds,
      service: serviceName,
      timestamp: new Date().toISOString(),
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  });

  server.listen(port, '127.0.0.1');

  // Log when ready (asynchronously)
  server.once('listening', () => {
    // eslint-disable-next-line no-console
    console.log(`[health] Server listening on 0.0.0.0:${port}`);
  });

  server.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error(`[health] Server error: ${err}`);
  });

  return server;
}
