import { launchBrowser, createBrowserContext, handleCookieConsent, closeBrowser } from './browser.js';

// Mock playwright
vi.mock('playwright', () => {
  const mockRoute = vi.fn().mockResolvedValue(undefined);
  const mockAddInitScript = vi.fn().mockResolvedValue(undefined);
  const mockContext = {
    route: mockRoute,
    addInitScript: mockAddInitScript,
  };
  const mockBrowser = {
    newContext: vi.fn().mockResolvedValue(mockContext),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return {
    chromium: {
      launch: vi.fn().mockResolvedValue(mockBrowser),
    },
  };
});

describe('launchBrowser', () => {
  it('launches with headless mode', async () => {
    const { chromium } = await import('playwright');
    const browser = await launchBrowser(true);
    expect(chromium.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        headless: true,
        channel: 'chrome',
      }),
    );
    expect(browser).toBeDefined();
  });

  it('launches with headed mode', async () => {
    const { chromium } = await import('playwright');
    await launchBrowser(false);
    expect(chromium.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        headless: false,
      }),
    );
  });

  it('passes anti-detection args', async () => {
    const { chromium } = await import('playwright');
    await launchBrowser(true);
    const call = (chromium.launch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.args).toContain('--disable-blink-features=AutomationControlled');
    expect(call.args).toContain('--no-sandbox');
  });
});

describe('createBrowserContext', () => {
  it('creates context with expected settings', async () => {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    const context = await createBrowserContext(browser);

    expect(browser.newContext).toHaveBeenCalledWith(
      expect.objectContaining({
        viewport: { width: 1920, height: 1080 },
        locale: 'cs-CZ',
        timezoneId: 'Europe/Prague',
      }),
    );
    expect(context).toBeDefined();
  });

  it('adds init script and routes', async () => {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    const context = await createBrowserContext(browser);

    expect(context.addInitScript).toHaveBeenCalled();
    expect(context.route).toHaveBeenCalled();
    // Should block multiple ad domains
    expect((context.route as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(5);
  });

  it('aborts requests for blocked domains through route handlers', async () => {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    const context = await createBrowserContext(browser);

    const firstRouteCall = (context.route as ReturnType<typeof vi.fn>).mock.calls[0];
    const routeHandler = firstRouteCall[1] as (route: { abort: () => Promise<void> | void }) => Promise<void>;
    const abort = vi.fn().mockResolvedValue(undefined);

    await routeHandler({ abort });
    expect(abort).toHaveBeenCalledTimes(1);
  });
});

describe('handleCookieConsent', () => {
  it('tries to click consent button', async () => {
    const mockPage = {
      evaluate: vi.fn().mockResolvedValue(true),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn().mockReturnValue({
        first: vi.fn().mockReturnValue({
          isVisible: vi.fn().mockResolvedValue(false),
          click: vi.fn().mockResolvedValue(undefined),
        }),
      }),
    };

    await handleCookieConsent(mockPage as any);
    expect(mockPage.evaluate).toHaveBeenCalled();
  });

  it('tries fallback selectors when shadow DOM fails', async () => {
    const mockIsVisible = vi.fn().mockResolvedValue(true);
    const mockClick = vi.fn().mockResolvedValue(undefined);
    const mockPage = {
      evaluate: vi.fn().mockResolvedValue(false),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn().mockReturnValue({
        first: vi.fn().mockReturnValue({
          isVisible: mockIsVisible,
          click: mockClick,
        }),
      }),
    };

    await handleCookieConsent(mockPage as any);
    expect(mockPage.locator).toHaveBeenCalled();
    expect(mockClick).toHaveBeenCalled();
  });

  it('handles errors gracefully', async () => {
    const mockPage = {
      evaluate: vi.fn().mockRejectedValue(new Error('timeout')),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn().mockReturnValue({
        first: vi.fn().mockReturnValue({
          isVisible: vi.fn().mockRejectedValue(new Error('timeout')),
          click: vi.fn(),
        }),
      }),
    };

    // Should not throw
    await handleCookieConsent(mockPage as any);
  });

  it('silently continues when no fallback consent selector is visible', async () => {
    const mockPage = {
      evaluate: vi.fn().mockResolvedValue(false),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn().mockReturnValue({
        first: vi.fn().mockReturnValue({
          isVisible: vi.fn().mockResolvedValue(false),
          click: vi.fn(),
        }),
      }),
    };

    await handleCookieConsent(mockPage as any);
    expect(mockPage.locator).toHaveBeenCalled();
    expect(mockPage.waitForTimeout).not.toHaveBeenCalled();
  });
});

describe('closeBrowser', () => {
  it('closes browser', async () => {
    const mockBrowser = { close: vi.fn().mockResolvedValue(undefined) };
    await closeBrowser(mockBrowser as any);
    expect(mockBrowser.close).toHaveBeenCalled();
  });

  it('handles null browser', async () => {
    await closeBrowser(null);
    // No error = success
  });

  it('handles close error gracefully', async () => {
    const mockBrowser = { close: vi.fn().mockRejectedValue(new Error('already closed')) };
    await closeBrowser(mockBrowser as any);
    // No error = success
  });
});
