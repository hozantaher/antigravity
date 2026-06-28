import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { UnifiedVectorEngine } from './engine';
import fs from 'fs';
import path from 'path';

describe('UnifiedVectorEngine', () => {
  const testRoot = path.join(process.cwd(), 'test-sandbox');

  beforeEach(() => {
    // Setup a fake project structure
    if (!fs.existsSync(testRoot)) {
      fs.mkdirSync(testRoot, { recursive: true });
    }
    const nodeDir = path.join(testRoot, 'test-node');
    fs.mkdirSync(nodeDir, { recursive: true });

    fs.writeFileSync(
      path.join(nodeDir, 'vektor.json'),
      JSON.stringify({
        id: 'test-node',
        story_axis: 'test',
        state: 'pending',
      })
    );
  });

  afterEach(() => {
    // Cleanup
    if (fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('should initialize without error', () => {
    const engine = new UnifiedVectorEngine(testRoot);
    expect(engine).toBeDefined();
  });

  it('should scan and find nodes', async () => {
    const engine = new UnifiedVectorEngine(testRoot);
    await engine.scan();
    const context = engine.resolveContext('test-node');
    expect(context).not.toBeNull();
    expect(context?.id).toBe('test-node');
    expect(context?.state).toBe('pending');
  });
});
