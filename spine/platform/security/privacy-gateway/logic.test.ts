import { describe, it, expect, beforeEach } from 'vitest';
import { PrivacyGateway } from './logic';
import jwt from 'jsonwebtoken';

describe('PrivacyGateway', () => {
  let gateway: PrivacyGateway;

  beforeEach(() => {
    gateway = new PrivacyGateway();
  });

  it('měl by vygenerovat validní JWT magický link', () => {
    // Arrange
    const draftId = 'draft_123';
    const email = 'seller@example.com';

    // Act
    const link = gateway.generateMagicLink(draftId, email);

    // Assert
    expect(link).toContain('https://app.auction24.cz/claim?token=');
    const token = link.split('token=')[1];
    expect(token).toBeDefined();

    // Verify token payload
    const payload = gateway.verifyMagicLinkPayload(token) as any;
    expect(payload.draftId).toBe(draftId);
    expect(payload.contact).toBe(email);
    expect(payload.intent).toBe('shadow-broker-claim');
  });

  it('měl by vrátit null pro neplatný token', () => {
    // Act
    const payload = gateway.verifyMagicLinkPayload('invalid.token.here');

    // Assert
    expect(payload).toBeNull();
  });

  it('měl by vrátit null pro token podepsaný jiným klíčem', () => {
    // Arrange
    const badToken = jwt.sign({ draftId: '123' }, 'wrong-secret-key');

    // Act
    const payload = gateway.verifyMagicLinkPayload(badToken);

    // Assert
    expect(payload).toBeNull();
  });
});
