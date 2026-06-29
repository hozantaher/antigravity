import { describe, it, expect } from 'vitest';
import { dispatchShadowDraft } from './logic';
import { ArbitrageOpportunity } from '../../../domain/core-types/schemas';
import { http, HttpResponse } from 'msw';
import { server } from '../../../../vitest.setup';

describe('HANDS: Shadow Broker Integration Sandbox', () => {
  const mockOpportunity: ArbitrageOpportunity = {
    id: 'opp-999',
    assetId: 'mobile-de-123',
    price: 500000,
    estimatedValue: 600000,
    expectedProfit: 100000,
    metadata: {}
  };

  it('Odešle Shadow Draft přes Sandbox Mailtrap (nepošle skutečný email)', async () => {
    let capturedPayload: any = null;

    // Zachytíme HTTP požadavek na Mailtrap a zkontrolujeme, co tam bot posílá
    server.use(
      http.post('https://api.mailtrap.io/api/send/inbox', async ({ request }) => {
        capturedPayload = await request.json();
        return HttpResponse.json({ success: true });
      })
    );

    const draft = await dispatchShadowDraft(mockOpportunity, 'test.dealer@example.com');
    
    // Zkontrolujeme, že draft má správný formát a UUID
    expect(draft.status).toBe('pending');
    expect(draft.draftId).toBeDefined();

    // Zkontrolujeme, že se e-mail reálně nedostal ven (na reálné SMTP), 
    // ale skončil v MSW pasti a obsahuje správný magický link.
    expect(capturedPayload).not.toBeNull();
    expect(capturedPayload.to).toBe('test.dealer@example.com');
    expect(capturedPayload.body).toContain(draft.draftId);
    expect(capturedPayload.body).toContain('500000 CZK');
  });

  it('Zablokuje odeslání, pokud chybí Sandbox (Ochrana proti spamu)', async () => {
    // Schválně nespecifikujeme kazetu pro Mailtrap
    // Vitest by měl test shodit díky `vitest.setup.ts` ochraně.
    await expect(
      dispatchShadowDraft(mockOpportunity, 'real.person@example.com')
    ).rejects.toThrow();
  });
});
