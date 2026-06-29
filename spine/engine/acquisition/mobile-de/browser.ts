import { type Browser, type BrowserContext, type Page, chromium } from 'playwright';
import { randomFrom } from '../shared/fetch.js';

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
];

// Only block heavy ad/tracking domains (keep images for anti-detection)
const BLOCKED_DOMAINS = [
  '**/doubleclick.net/**',
  '**/googlesyndication.com/**',
  '**/google-analytics.com/**',
  '**/facebook.net/**',
  '**/facebook.com/tr/**',
  '**/hotjar.com/**',
  '**/criteo.com/**',
  '**/outbrain.com/**',
  '**/taboola.com/**',
  '**/adsrvr.org/**',
  '**/adnxs.com/**',
  '**/rubiconproject.com/**',
  '**/pubmatic.com/**',
  '**/adsafeprotected.com/**',
  '**/amazon-adsystem.com/**',
  '**/stickyadstv.com/**',
];

export const launchBrowser = async (headless: boolean): Promise<Browser> => {
  const browser = await chromium.launch({
    headless,
    channel: 'chrome',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-infobars',
      '--window-size=1920,1080',
    ],
  });
  return browser;
};

export const createBrowserContext = async (browser: Browser): Promise<BrowserContext> => {
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    locale: 'cs-CZ',
    timezoneId: 'Europe/Prague',
    userAgent: randomFrom(USER_AGENTS),
    extraHTTPHeaders: {
      'Accept-Language': 'cs-CZ,cs;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  });

  // Anti-detection init script
  /* v8 ignore start -- callback runs in browser context */
  await context.addInitScript(() => {
    // Hide webdriver flag
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

    // Spoof chrome runtime to look like a real Chrome browser
    const win = window as unknown as Record<string, unknown>;
    if (!win.chrome) {
      win.chrome = {
        runtime: {},
        loadTimes: () => ({}),
        csi: () => ({}),
      };
    }

    // Spoof plugins to have realistic entries
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const arr = [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
          { name: 'Native Client', filename: 'internal-nacl-plugin' },
        ];
        (arr as unknown as { length: number }).length = 3;
        return arr;
      },
    });

    // Spoof languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['cs-CZ', 'cs', 'en-US', 'en'],
    });

    // Spoof permissions query to not reveal automation
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters: PermissionDescriptor) => {
      if (parameters.name === 'notifications') {
        return Promise.resolve({ state: 'denied', onchange: null } as PermissionStatus);
      }
      return originalQuery.call(window.navigator.permissions, parameters);
    };
  });
  /* v8 ignore stop */

  // Block heavy ad/tracking resources for speed
  for (const pattern of BLOCKED_DOMAINS) {
    await context.route(pattern, (route) => route.abort());
  }

  return context;
};

// Handle cookie consent banner (Usercentrics or similar)
export const handleCookieConsent = async (page: Page) => {
  try {
    // Try Usercentrics shadow DOM consent button
    /* v8 ignore start -- callback runs in browser context */
    const accepted = await page.evaluate(() => {
      const ucRoot = document.getElementById('usercentrics-root');
      if (ucRoot?.shadowRoot) {
        const buttons = ucRoot.shadowRoot.querySelectorAll('button');
        for (const btn of buttons) {
          const text = btn.textContent?.trim()?.toLowerCase() || '';
          if (
            text.includes('accept') ||
            text.includes('přijmout') ||
            text.includes('akzeptieren') ||
            text.includes('souhlasím')
          ) {
            btn.click();
            return true;
          }
        }
      }
      return false;
    });
    /* v8 ignore stop */

    if (accepted) {
      await page.waitForTimeout(1000);
      return;
    }

    // Fallback: try common consent button selectors
    const selectors = [
      '[data-testid="uc-accept-all-button"]',
      '#consent-accept',
      'button[id*="accept"]',
      'button[class*="consent"][class*="accept"]',
      'button:has-text("Přijmout")',
      'button:has-text("Accept")',
    ];

    for (const selector of selectors) {
      try {
        const btn = page.locator(selector).first();
        if (await btn.isVisible({ timeout: 1000 })) {
          await btn.click();
          await page.waitForTimeout(1000);
          return;
        }
      } catch {
        // Try next selector
      }
    }
  } catch {
    // No consent dialog found
  }
};

export const closeBrowser = async (browser: Browser | null) => {
  if (browser) {
    try {
      await browser.close();
    } catch {
      // Browser already closed
    }
  }
};
