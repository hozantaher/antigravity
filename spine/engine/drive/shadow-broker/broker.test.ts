import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ShadowBroker } from './broker';
import { SymphonyQueue } from '../../automation/symphony-queue/index';
import { PrivacyGateway } from '../../../platform/security/privacy-gateway/index';

vi.mock('../../automation/symphony-queue/index', () => ({
  SymphonyQueue: {
    subscribe: vi.fn(),
    enqueue: vi.fn() // pro jistotu
  }
}));

vi.mock('../../../platform/security/privacy-gateway/index', () => ({
  PrivacyGateway: vi.fn(function() {
    return { generateMagicLink: vi.fn(() => 'https://app.auction24.cz/claim?token=mocked') };
  })
}));

describe('ShadowBroker', () => {
  let broker: ShadowBroker;

  beforeEach(() => {
    vi.clearAllMocks();
    broker = new ShadowBroker();
  });

  it('měl by se přihlásit k odběru SymphonyQueue při inicializaci', () => {
    // Assert
    expect(SymphonyQueue.subscribe).toHaveBeenCalledTimes(1);
    expect(SymphonyQueue.subscribe).toHaveBeenCalledWith(expect.any(Function));
  });

  it('měl by exekuovat příležitost a vygenerovat magický link', async () => {
    // Arrange
    const gatewayMock = vi.mocked(PrivacyGateway).mock.results[0]?.value || new PrivacyGateway();
    (broker as any).gateway = gatewayMock;
    
    // Získáme callback zaregistrovaný do subscribe
    const subscribeCall = vi.mocked(SymphonyQueue.subscribe).mock.calls[0][0] as Function;
    
    // Act
    await subscribeCall({
      id: 'ext_123',
      assetId: '12345',
      expectedProfit: 50000,
      metadata: { title: 'BMW', price: 100000, url: 'http://example.com' }
    });

    // Assert
    expect(gatewayMock.generateMagicLink).toHaveBeenCalledTimes(1);
    expect(gatewayMock.generateMagicLink).toHaveBeenCalledWith(
      expect.stringContaining('draft_'),
      'seller_12345@example.com'
    );
  });
});
