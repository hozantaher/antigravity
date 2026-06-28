import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TransactionalRefactorEngine } from './refactor';
import fs from 'fs';
import path from 'path';

describe('TransactionalRefactorEngine', () => {
  const testRoot = path.join(process.cwd(), 'test-sandbox-refactor');

  beforeEach(() => {
    if (fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
    fs.mkdirSync(testRoot, { recursive: true });

    // Setup initial state
    const nodeDir = path.join(testRoot, 'nodes/user');
    fs.mkdirSync(nodeDir, { recursive: true });
    fs.writeFileSync(path.join(nodeDir, 'vektor.json'), JSON.stringify({
      id: 'user',
      edges: []
    }));

    const otherNodeDir = path.join(testRoot, 'nodes/profile');
    fs.mkdirSync(otherNodeDir, { recursive: true });
    fs.writeFileSync(path.join(otherNodeDir, 'vektor.json'), JSON.stringify({
      id: 'profile',
      edges: ['user']
    }));

    fs.writeFileSync(path.join(testRoot, 'nodes/someFile.ts'), '// @vek' + 'tor-link: user\n');
  });

  afterEach(() => {
    if (fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('should plan a rename properly', async () => {
    const refactor = new TransactionalRefactorEngine(testRoot);
    const plan = await refactor.planRename('user', 'client', 'nodes/client');

    expect(plan.some(p => p.includes('UPDATE_JSON') && p.includes('user -> client'))).toBe(true);
    expect(plan.some(p => p.includes('GIT_MV') && p.includes('nodes/client'))).toBe(true);
    expect(plan.some(p => p.includes('PATCH_FILE') && p.includes('someFile.ts'))).toBe(true);
    expect(plan.some(p => p.includes('PATCH_EDGE') && p.includes('user -> client'))).toBe(true);
  });

  it('should throw if old node does not exist', async () => {
    const refactor = new TransactionalRefactorEngine(testRoot);
    await expect(refactor.planRename('non-existent', 'new-id')).rejects.toThrow('not found');
  });
});
