import { describe, it, expect } from 'vitest';
import { ApiTokenManager } from './logic';

describe('ApiTokenManager PoC', () => {
  it('should generate and validate a token correctly', () => {
    const manager = new ApiTokenManager();
    const clientId = 'client_123';
    
    const { rawToken, tokenHash } = manager.generateToken(clientId);
    
    // Token should exist and be 64 characters long (32 bytes hex)
    expect(rawToken).toBeDefined();
    expect(rawToken.length).toBe(64);
    
    // Hash should be 64 characters long (SHA-256)
    expect(tokenHash).toBeDefined();
    expect(tokenHash.length).toBe(64);
    
    // Should validate successfully with the raw token
    const validClient = manager.validateToken(rawToken);
    expect(validClient).toBe(clientId);
    
    // Should fail validation with an invalid token
    const invalidClient = manager.validateToken('invalid_token');
    expect(invalidClient).toBeNull();
  });
});
