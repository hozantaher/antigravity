import { describe, it, expect, vi } from 'vitest';
import { brainWorker } from './worker.brain';
import { handsWorker } from './worker.hands';
import { handsQueue } from './queues';
import { http, HttpResponse } from 'msw';
import { server } from '../../../../vitest.setup';

// Mock pro bullmq frontu
vi.mock('./queues', () => ({
  redisConnection: {},
  brainQueue: { add: vi.fn() },
  handsQueue: { add: vi.fn() }
}));

describe('SYMPHONY: Celková asymetrická smyčka (Mesh) přes Worker Processory', () => {
  it('Prove-of-Concept: Lead projde přes BRAIN a spustí e-mail v HANDS', async () => {
    let emailSent = false;
    let sentPayload: any = null;

    server.use(
      http.post('https://api.mailtrap.io/api/send/inbox', async ({ request }) => {
        emailSent = true;
        sentPayload = await request.json();
        return HttpResponse.json({ success: true });
      })
    );

    const newLead = {
      url: 'https://mobile.de/porsche-123',
      source: 'mobile-de',
      dealerContact: 'dealer@porsche.de',
      vehicle: { make: 'Porsche', model: '911', year: 2021, mileage: 18000 }
    };

    // 1. Zavoláme ručně Brain processor (místo přes Redis)
    const mockBrainJob: any = { id: 'job-1', data: { ...newLead, price: 2350000 } };
    // @ts-ignore - Saháme do privátní process property
    await brainWorker.processFn(mockBrainJob);

    // 2. Očekáváme, že Brain poslal práci do Hands fronty
    expect(handsQueue.add).toHaveBeenCalledWith('dispatch-draft', expect.objectContaining({
      dealerEmail: 'dealer@porsche.de'
    }));

    // 3. Zavoláme ručně Hands processor s tím, co vygeneroval Brain
    // @ts-ignore
    const draftPayload = vi.mocked(handsQueue.add).mock.calls[0][1];
    const mockHandsJob: any = { id: 'job-2', data: draftPayload };
    
    // @ts-ignore
    await handsWorker.processFn(mockHandsJob);

    // 4. Ověříme, že mail se chytil
    expect(emailSent).toBe(true);
    expect(sentPayload.to).toBe('dealer@porsche.de');
    expect(sentPayload.body).toContain('2350000 CZK');
  });

  it('Break-the-Concept: Zod Firewall zachytí halucinaci a nepustí dál', async () => {
    const badLead = {
      url: 'https://mobile.de/bad',
      source: 'sbazar',
      dealerContact: 'dealer@porsche.de',
      price: 2350000,
      vehicle: { make: 'Porsche', year: 1800, mileage: 100 }
    };

    const mockBrainJob: any = { id: 'job-bad', data: badLead };
    
    // Zod by měl vyhodit výjimku a procesor spadnout
    // @ts-ignore
    await expect(brainWorker.processFn(mockBrainJob)).rejects.toThrow();
  });
});
