import axios from 'axios';

export class FastCrawler {
  static async fetchHtml(url: string): Promise<string> {
    console.log(`[FastCrawler] Stahuji HTML (via Axios): ${url}`);
    try {
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          'Accept-Language': 'cs,en-US;q=0.7,en;q=0.3'
        },
        timeout: 10000
      });
      return response.data;
    } catch (err: any) {
      console.error(`[FastCrawler] Selhání stahování HTML z ${url}:`, err.message);
      return '';
    }
  }
}
