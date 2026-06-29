// @vektor-link: engine-drive

export interface DriveConfig {
  mode: 'read' | 'write';
  target: string;
  rateLimitMs: number;
}

export class EngineDriveAPI {
  private activeSessions: Map<string, Date> = new Map();

  /**
   * Spustí sekvenci pro čtení (např. scrapování inzerátů)
   */
  public async executeRead(config: DriveConfig): Promise<void> {
    this.enforceRatePolicy(config);
    console.log(`[Drive] Starting READ sequence against ${config.target}`);
    // Simulace čtení
    this.recordSession(config.target);
  }

  /**
   * Spustí sekvenci pro zápis (např. úprava našich inzerátů)
   */
  public async executeWrite(config: DriveConfig): Promise<void> {
    this.enforceRatePolicy(config);
    console.log(`[Drive] Starting WRITE sequence against ${config.target}`);
    // Simulace zápisu
    this.recordSession(config.target);
  }

  private enforceRatePolicy(config: DriveConfig) {
    const lastRun = this.activeSessions.get(config.target);
    if (lastRun) {
      const elapsed = Date.now() - lastRun.getTime();
      if (elapsed < config.rateLimitMs) {
        throw new Error(`Rate limit exceeded for ${config.target}. Wait ${config.rateLimitMs - elapsed}ms.`);
      }
    }
  }

  private recordSession(target: string) {
    this.activeSessions.set(target, new Date());
  }
}

export default new EngineDriveAPI();
