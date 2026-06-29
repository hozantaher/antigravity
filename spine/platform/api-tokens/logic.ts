import { randomBytes, createHash } from 'crypto';

export class ApiTokenManager {
  private inMemoryLedger: Map<string, string> = new Map(); // tokenHash -> clientId

  /**
   * Generates a new API token for a client
   * @returns { rawToken: string, tokenHash: string }
   */
  public generateToken(clientId: string) {
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(rawToken);
    
    // Store ONLY the hash, not the raw token
    this.inMemoryLedger.set(tokenHash, clientId);
    
    return { rawToken, tokenHash };
  }

  /**
   * Validates if a raw token is valid
   * @returns clientId if valid, null if invalid
   */
  public validateToken(rawToken: string): string | null {
    const hash = this.hashToken(rawToken);
    return this.inMemoryLedger.get(hash) || null;
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
