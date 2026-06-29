import jwt from 'jsonwebtoken';

export class PrivacyGateway {
  private readonly secretKey = process.env.JWT_SECRET || 'fallback-dev-secret-key-123';

  /**
   * Vygeneruje "Magický Link" (JWT) pro Shadow Draft.
   * Prodejce po kliknutí získá okamžitý autentizovaný přístup k draftu inzerátu.
   */
  public generateMagicLink(draftId: string, emailOrPhone: string): string {
    const token = jwt.sign(
      {
        draftId,
        contact: emailOrPhone,
        intent: 'shadow-broker-claim',
      },
      this.secretKey,
      { expiresIn: '72h' } // Link vyprší za 3 dny
    );

    // Běžně by to byla URL našeho dashboardu/bff
    return `https://app.auction24.cz/claim?token=${token}`;
  }

  public verifyMagicLinkPayload(token: string): any {
    try {
      return jwt.verify(token, this.secretKey);
    } catch (e) {
      console.error('[PrivacyGateway] Neplatný nebo vypršelý Magický Link:', e);
      return null;
    }
  }
}
