import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { DeepInventoryScraper } from './scraper';

vi.mock('axios');

describe('DeepInventoryScraper', () => {
  let scraper: DeepInventoryScraper;

  beforeEach(() => {
    vi.clearAllMocks();
    scraper = new DeepInventoryScraper();
  });

  it('měl by vyparsovat inzeráty z HTML a vrátit i rawHtml', async () => {
    // Arrange
    const html = `
      <html>
        <body>
          <div class="listing-item" data-id="item_1">
            <h2 class="title">BMW X5</h2>
            <span class="price">500 000 Kč</span>
          </div>
          <article data-id="item_2">
            <h2 class="heading">Skoda Fabia</h2>
            <div class="amount">150000 EUR</div>
          </article>
        </body>
      </html>
    `;
    vi.mocked(axios.get).mockResolvedValue({ data: html });

    // Act
    const { items, rawHtml } = await scraper.scrapeInventory('http://test.com');

    // Assert
    expect(axios.get).toHaveBeenCalledWith('http://test.com', expect.any(Object));
    expect(rawHtml).toBe(html);
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe('BMW X5');
    expect(items[0].price).toBe(500000);
    expect(items[0].id).toBe('item_1');
    expect(items[1].title).toBe('Skoda Fabia');
    expect(items[1].price).toBe(150000);
    expect(items[1].id).toBe('item_2');
  });

  it('měl by vrátit prázdné pole a rawHtml, pokud se nepodaří najít elementy', async () => {
    // Arrange
    const html = `<html><body><p>Žádná auta tady nejsou</p></body></html>`;
    vi.mocked(axios.get).mockResolvedValue({ data: html });

    // Act
    const { items, rawHtml } = await scraper.scrapeInventory('http://test.com');

    // Assert
    expect(rawHtml).toBe(html);
    expect(items).toHaveLength(0);
  });

  it('měl by vrátit prázdné pole a prázdný rawHtml při chybě sítě', async () => {
    // Arrange
    vi.mocked(axios.get).mockRejectedValue(new Error('Network error'));

    // Act
    const { items, rawHtml } = await scraper.scrapeInventory('http://test.com');

    // Assert
    expect(items).toEqual([]);
    expect(rawHtml).toBe('');
  });
});
