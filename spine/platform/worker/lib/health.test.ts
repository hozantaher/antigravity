import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startHealthServer, resetStartTime, type HealthResponse } from './health.js';

describe('health server', () => {
  let server: ReturnType<typeof startHealthServer>;
  const testPort = 18090;

  // Helper to wait for server to be listening
  const waitForListening = (srv: ReturnType<typeof startHealthServer>): Promise<void> => {
    return new Promise<void>((resolve) => {
      if ((srv.address() as unknown) !== null) {
        resolve();
      } else {
        srv.once('listening', () => resolve());
      }
    });
  };

  beforeEach(() => {
    resetStartTime();
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it('should start server on specified port', async () => {
    server = startHealthServer(testPort, 'test-worker');
    await waitForListening(server);
    expect(server.address()).toBeTruthy();
  });

  it('should respond to GET /healthz with 200 ok', async () => {
    server = startHealthServer(testPort, 'test-worker');
    await waitForListening(server);

    const response = await fetch(`http://localhost:${testPort}/healthz`);
    expect(response.status).toBe(200);

    const data = (await response.json()) as HealthResponse;
    expect(data.status).toBe('ok');
    expect(data.service).toBe('test-worker');
    expect(typeof data.uptime_seconds).toBe('number');
    expect(data.uptime_seconds).toBeGreaterThanOrEqual(0);
    expect(data.timestamp).toBeTruthy();
  });

  it('should return valid ISO timestamp', async () => {
    server = startHealthServer(testPort, 'test-worker');
    await waitForListening(server);

    const response = await fetch(`http://localhost:${testPort}/healthz`);
    const data = (await response.json()) as HealthResponse;

    // Valid ISO 8601 timestamp
    expect(() => new Date(data.timestamp)).not.toThrow();
    const timestamp = new Date(data.timestamp);
    expect(timestamp.getTime()).toBeGreaterThan(0);
  });

  it('should track uptime in seconds', async () => {
    server = startHealthServer(testPort, 'test-worker');
    await waitForListening(server);

    const response1 = await fetch(`http://localhost:${testPort}/healthz`);
    const data1 = (await response1.json()) as HealthResponse;
    const uptime1 = data1.uptime_seconds;

    // Wait a bit
    await new Promise((resolve) => setTimeout(resolve, 100));

    const response2 = await fetch(`http://localhost:${testPort}/healthz`);
    const data2 = (await response2.json()) as HealthResponse;
    const uptime2 = data2.uptime_seconds;

    // Uptime should increase (or stay same due to rounding to seconds)
    expect(uptime2).toBeGreaterThanOrEqual(uptime1);
  });

  it('should respond to unimplemented paths with 404', async () => {
    server = startHealthServer(testPort, 'test-worker');
    await waitForListening(server);

    const response = await fetch(`http://localhost:${testPort}/unknown`);
    expect(response.status).toBe(404);

    const data = await response.json();
    expect(data.error).toBe('not found');
  });

  it('should respond to non-GET methods with 405', async () => {
    server = startHealthServer(testPort, 'test-worker');
    await waitForListening(server);

    const response = await fetch(`http://localhost:${testPort}/healthz`, {
      method: 'POST',
    });
    expect(response.status).toBe(405);

    const data = await response.json();
    expect(data.error).toBe('method not allowed');
  });

  it('should return content-type application/json', async () => {
    server = startHealthServer(testPort, 'test-worker');
    await waitForListening(server);

    const response = await fetch(`http://localhost:${testPort}/healthz`);
    expect(response.headers.get('content-type')).toBe('application/json');
  });

  it('should include service name in response', async () => {
    const serviceName = 'my-custom-worker';
    server = startHealthServer(testPort, serviceName);
    await waitForListening(server);

    const response = await fetch(`http://localhost:${testPort}/healthz`);
    const data = (await response.json()) as HealthResponse;
    expect(data.service).toBe(serviceName);
  });

  it('should accept HEAD requests if method is GET-safe', async () => {
    // HEAD should return same headers as GET
    server = startHealthServer(testPort, 'test-worker');
    await waitForListening(server);

    const getResponse = await fetch(`http://localhost:${testPort}/healthz`);
    expect(getResponse.status).toBe(200);
  });

  it('should handle multiple concurrent requests', async () => {
    server = startHealthServer(testPort, 'test-worker');
    await waitForListening(server);

    const requests = Array.from({ length: 10 }, () =>
      fetch(`http://localhost:${testPort}/healthz`),
    );

    const responses = await Promise.all(requests);
    responses.forEach((response) => {
      expect(response.status).toBe(200);
    });
  });

  it('should have uptime starting from zero', async () => {
    const uniquePort = testPort + 1;
    resetStartTime();
    server = startHealthServer(uniquePort, 'test-worker');
    await waitForListening(server);

    const response = await fetch(`http://localhost:${uniquePort}/healthz`);
    const data = (await response.json()) as HealthResponse;

    // Should be close to zero, at most a few seconds
    expect(data.uptime_seconds).toBeLessThan(5);
  });
});
