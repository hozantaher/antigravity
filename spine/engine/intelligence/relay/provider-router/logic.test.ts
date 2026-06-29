import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RelayEngine } from './logic';
import OpenAI from 'openai';
import * as fs from 'fs';

vi.mock('openai');
vi.mock('fs');

describe('RelayEngine', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('měl by vytvořit mock odhad, pokud chybí API klíč a RunPod URL', async () => {
    // Arrange
    process.env.OPENAI_API_KEY = 'mock-key';
    delete process.env.RUNPOD_LLM_URL;
    vi.mocked(fs.existsSync).mockReturnValue(false);
    
    const relay = new RelayEngine();

    // Act
    const audiScore = await relay.evaluateArbitrageScore('Audi A4', 100000);
    const otherScore = await relay.evaluateArbitrageScore('Skoda Fabia', 100000);

    // Assert
    expect(audiScore).toBe(150000); // 1.5 multiplier
    expect(Math.round(otherScore)).toBe(110000); // 1.1 multiplier
    expect(OpenAI).toHaveBeenCalledTimes(1); // constructor called, ale ne create
  });

  it('měl by zavolat LLM API, pokud je dostupný klíč', async () => {
    // Arrange
    process.env.OPENAI_API_KEY = 'real-key';
    const mockCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: '150 000 CZK' } }]
    });
    vi.mocked(OpenAI).mockImplementation(function() {
      return {
        chat: { completions: { create: mockCreate } }
      } as any;
    } as any);

    const relay = new RelayEngine();

    // Act
    const score = await relay.evaluateArbitrageScore('Test Auto', 100000);

    // Assert
    expect(score).toBe(150000);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-4o',
      messages: expect.any(Array)
    }));
  });

  it('měl by přečíst RunPod URL ze souboru, pokud existuje', () => {
    // Arrange
    vi.mocked(fs.readFileSync).mockReturnValue('http://runpod.test');
    
    // Act
    new RelayEngine();

    // Assert
    expect(fs.readFileSync).toHaveBeenCalledWith('/tmp/runpod_llm_url', 'utf-8');
    expect(OpenAI).toHaveBeenCalledWith(expect.objectContaining({
      baseURL: 'http://runpod.test/v1',
      apiKey: 'ollama'
    }));
  });
});
