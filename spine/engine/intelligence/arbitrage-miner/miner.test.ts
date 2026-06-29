import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ArbitrageMiner } from './miner';
import { DeepInventoryScraper } from '../../../demand/acquisition/deep-inventory/index';
import { RelayEngine } from '../relay/index';
import { SymphonyQueue } from '../../automation/symphony-queue/index';

// Mocks
vi.mock('../../../demand/acquisition/deep-inventory/index', () => ({
  DeepInventoryScraper: vi.fn(function() {
    return { scrapeInventory: vi.fn() };
  })
}));

vi.mock('../relay/index', () => ({
  RelayEngine: vi.fn(function() {
    return { evaluateArbitrageScore: vi.fn() };
  })
}));

vi.mock('../../automation/symphony-queue/index', () => ({
  SymphonyQueue: {
    enqueue: vi.fn()
  }
}));

describe('ArbitrageMiner', () => {
  let miner: ArbitrageMiner;

  beforeEach(() => {
    vi.clearAllMocks();
    miner = new ArbitrageMiner();
  });

  it('měl by odeslat do fronty inzerát, pokud odhadovaná hodnota přesáhne cenu o více než 20%', async () => {
    // Arrange
    const mockScraperInstance = vi.mocked(DeepInventoryScraper).mock.results[0]?.value || new DeepInventoryScraper();
    mockScraperInstance.scrapeInventory.mockResolvedValue([
      { id: '1', title: 'Test Auto', price: 100000, sourceUrl: 'http://test.com/1' },
      { id: '2', title: 'Špatné Auto', price: 200000, sourceUrl: 'http://test.com/2' }
    ]);
    
    // Pro id '1' (cena 100k) bude odhad 130k -> > 1.2 * 100k -> arbitráž (zisk 30k)
    // Pro id '2' (cena 200k) bude odhad 210k -> < 1.2 * 200k -> žádná arbitráž
    const mockRelayInstance = vi.mocked(RelayEngine).mock.results[0]?.value || new RelayEngine();
    mockRelayInstance.evaluateArbitrageScore.mockImplementation(async (title: string, price: number) => {
      if (title === 'Test Auto') return 130000;
      if (title === 'Špatné Auto') return 210000;
      return price;
    });

    // Replace the instances in the miner with our mocks so we can control them
    // (In TS we can bypass private for testing or just rely on the module mock replacing constructor calls)
    (miner as any).scraper = mockScraperInstance;
    (miner as any).relay = mockRelayInstance;

    // Act
    await miner.mineMarket('http://market.com');

    // Assert
    expect(mockScraperInstance.scrapeInventory).toHaveBeenCalledWith('http://market.com');
    expect(mockRelayInstance.evaluateArbitrageScore).toHaveBeenCalledTimes(2);
    
    // Zkontrolovat, že se zařadil pouze ten první inzerát
    expect(SymphonyQueue.enqueue).toHaveBeenCalledTimes(1);
    expect(SymphonyQueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      id: '1',
      expectedProfit: 30000
    }));
  });
});
