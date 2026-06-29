// @vektor-link: network-interceptor

/**
 * @terminology ReverseAPIInterceptor
 * Namísto parsování DOM struktur přes selektory poslouchá `response` eventy na úrovni prohlížeče (Playwright).
 * Pokud detekuje odpověď ze serveru, která obsahuje JSON nebo GraphQL odpovídající inzerátu, 
 * data přímo vyextrahuje a ihned převede na RawListing.
 */
export class ReverseAPIInterceptor {
  public async attachToPage(page: any, onJsonReceived: (data: any) => void) {
    console.log('[ReverseAPIInterceptor] Zavádím síťovou odposlouchávací sondu...');
    
    page.on('response', async (response: any) => {
      const url = response.url();
      const contentType = response.headers()['content-type'] || '';
      
      // Filtrujeme jen API volání vracející JSON
      if (contentType.includes('application/json') && (url.includes('graphql') || url.includes('/api/v1/ad'))) {
        try {
          const body = await response.json();
          // Heuristika pro ověření, že to jsou inzertní data
          if (body && (body.ad || body.data?.listing)) {
             console.log(`[ReverseAPIInterceptor] Zachycen skrytý JSON payload z API: ${url}`);
             onJsonReceived(body);
          }
        } catch (err) {
          // Ignorujeme parsovací chyby (pravděpodobně nekompletní nebo vadný JSON payload)
        }
      }
    });
  }
}
