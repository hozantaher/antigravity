const mockSend = vi.fn().mockResolvedValue([{ statusCode: 202 }]);
const mockSetApiKey = vi.fn();

vi.mock('@sendgrid/mail', () => ({
  default: { send: mockSend, setApiKey: mockSetApiKey },
}));

// Re-import after mock to reset module state
let sendResultEmail: typeof import('./email.js').sendResultEmail;

describe('email', () => {
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env.SENDGRID_API_KEY = 'SG.test-key';
    process.env.SENDGRID_FROM_EMAIL = 'test@rozporuj.com';
    const mod = await import('./email.js');
    sendResultEmail = mod.sendResultEmail;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('sendResultEmail', () => {
    const params = {
      to: 'user@test.cz',
      firstName: 'Jan',
      downloadUrl: 'https://storage.example.com/odpor.pdf',
      docxUrl: 'https://storage.example.com/odpor.docx',
    };

    it('sends email with correct recipient and subject', async () => {
      await sendResultEmail(params);
      expect(mockSend).toHaveBeenCalledOnce();
      const call = mockSend.mock.calls[0][0];
      expect(call.to).toBe('user@test.cz');
      expect(call.from).toBe('test@rozporuj.com');
      expect(call.subject).toBe('Váš odpor proti pokutě je připraven');
    });

    it('HTML contains firstName', async () => {
      await sendResultEmail(params);
      const html = mockSend.mock.calls[0][0].html;
      expect(html).toContain('Jan');
    });

    it('HTML contains both download links', async () => {
      await sendResultEmail(params);
      const html = mockSend.mock.calls[0][0].html;
      expect(html).toContain('https://storage.example.com/odpor.pdf');
      expect(html).toContain('https://storage.example.com/odpor.docx');
      expect(html).toContain('Stáhnout PDF');
      expect(html).toContain('Stáhnout DOCX');
    });

    it('HTML contains AI disclaimer', async () => {
      await sendResultEmail(params);
      const html = mockSend.mock.calls[0][0].html;
      expect(html).toContain('umělé inteligence');
    });

    it('escapes HTML in firstName', async () => {
      await sendResultEmail({ ...params, firstName: '<script>alert(1)</script>' });
      const html = mockSend.mock.calls[0][0].html;
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
    });

    it('escapes HTML in URLs', async () => {
      await sendResultEmail({ ...params, downloadUrl: 'https://example.com/a"onload="alert(1)' });
      const html = mockSend.mock.calls[0][0].html;
      expect(html).not.toContain('"onload="');
      expect(html).toContain('&quot;onload=&quot;');
    });

    it('calls setApiKey once on first invocation', async () => {
      await sendResultEmail(params);
      expect(mockSetApiKey).toHaveBeenCalledWith('SG.test-key');
    });

    it('does not call setApiKey on second invocation', async () => {
      await sendResultEmail(params);
      await sendResultEmail(params);
      expect(mockSetApiKey).toHaveBeenCalledTimes(1);
    });

    it('uses default from email when env var is not set', async () => {
      delete process.env.SENDGRID_FROM_EMAIL;
      vi.resetModules();
      const mod = await import('./email.js');
      await mod.sendResultEmail(params);
      expect(mockSend.mock.calls[0][0].from).toBe('noreply@rozporuj.com');
    });

    it('throws when SENDGRID_API_KEY is missing', async () => {
      delete process.env.SENDGRID_API_KEY;
      vi.resetModules();
      const mod = await import('./email.js');
      await expect(mod.sendResultEmail(params)).rejects.toThrow('SENDGRID_API_KEY is required');
    });
  });
});

// -------------------------------------------------------------------------
// M8 — ensureInit atomic: concurrent callers must share a single init promise
// -------------------------------------------------------------------------

describe('email - M8 ensureInit atomicity', () => {
  const mockSend = vi.fn().mockResolvedValue([{ statusCode: 202 }]);
  const mockSetApiKey = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.doMock('@sendgrid/mail', () => ({
      default: { send: mockSend, setApiKey: mockSetApiKey },
    }));
    process.env.SENDGRID_API_KEY = 'SG.concurrent-key';
  });

  afterEach(() => {
    vi.doUnmock('@sendgrid/mail');
  });

  it('10 concurrent first calls result in exactly one setApiKey call', async () => {
    const { sendResultEmail } = await import('./email.js');
    const params = { to: 'a@b.cz', firstName: 'A', downloadUrl: 'https://u.com/p.pdf', docxUrl: 'https://u.com/d.docx' };

    await Promise.all(Array.from({ length: 10 }, () => sendResultEmail(params)));

    expect(mockSetApiKey).toHaveBeenCalledTimes(1);
    expect(mockSetApiKey).toHaveBeenCalledWith('SG.concurrent-key');
  });

  it('second sequential call does not call setApiKey again', async () => {
    const { sendResultEmail } = await import('./email.js');
    const params = { to: 'a@b.cz', firstName: 'A', downloadUrl: 'https://u.com/p.pdf', docxUrl: 'https://u.com/d.docx' };
    await sendResultEmail(params);
    await sendResultEmail(params);
    expect(mockSetApiKey).toHaveBeenCalledTimes(1);
  });

  it('throws when SENDGRID_API_KEY missing even with atomic init guard', async () => {
    delete process.env.SENDGRID_API_KEY;
    vi.resetModules();
    vi.doMock('@sendgrid/mail', () => ({ default: { send: mockSend, setApiKey: mockSetApiKey } }));
    const { sendResultEmail } = await import('./email.js');
    const params = { to: 'a@b.cz', firstName: 'A', downloadUrl: 'u', docxUrl: 'u' };
    await expect(sendResultEmail(params)).rejects.toThrow('SENDGRID_API_KEY is required');
  });
});
