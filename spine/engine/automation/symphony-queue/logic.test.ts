import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SymphonyQueue } from './logic';
import { Queue, Worker } from 'bullmq';

vi.mock('bullmq', () => {
  return {
    Queue: vi.fn(function() {
      return { add: vi.fn() };
    }),
    Worker: vi.fn(function() {
      return { on: vi.fn() };
    }),
    QueueEvents: vi.fn(function() {
      return { on: vi.fn() };
    })
  };
});

vi.mock('ioredis', () => {
  return {
    default: vi.fn(function() {
      return {};
    })
  };
});

describe('SymphonyQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('měl by zařadit příležitost do fronty', async () => {
    // Arrange
    const opportunity = {
      id: 'ext_999',
      assetId: '999',
      expectedProfit: 10000,
      metadata: {}
    };

    // Získáme referenci na mockovanou instanci fronty exportovanou z modulu
    const { arbitrageQueue } = await import('./logic');

    // Act
    await SymphonyQueue.enqueue(opportunity);

    // Assert
    expect(arbitrageQueue.add).toHaveBeenCalledTimes(1);
    expect(arbitrageQueue.add).toHaveBeenCalledWith('arbitrage-deal', opportunity);
  });

  it('měl by spustit workera, který se zavěsí na daný handler', () => {
    // Arrange
    const handlerMock = vi.fn();

    // Act
    SymphonyQueue.subscribe(handlerMock);

    // Assert
    expect(Worker).toHaveBeenCalledTimes(1);
    const workerMockInstance = vi.mocked(Worker).mock.results[0]?.value;
    expect(workerMockInstance.on).toHaveBeenCalledWith('completed', expect.any(Function));
    expect(workerMockInstance.on).toHaveBeenCalledWith('error', expect.any(Function));
  });
});
