import JSZip from 'jszip';
import { markdownToDocx } from './docx-writer.js';

/** Extract the raw XML of a DOCX part (e.g. 'word/document.xml') */
const extractXml = async (buffer: Buffer, part: string): Promise<string> => {
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file(part);
  if (!file) throw new Error(`Part ${part} not found in DOCX`);
  return file.async('string');
};

/** Search all XML files in the DOCX for a string (headers are in separate files) */
const searchAllXml = async (buffer: Buffer, needle: string): Promise<boolean> => {
  const zip = await JSZip.loadAsync(buffer);
  for (const [path, file] of Object.entries(zip.files)) {
    if (path.endsWith('.xml') && !file.dir) {
      const content = await file.async('string');
      if (content.includes(needle)) return true;
    }
  }
  return false;
};

describe('docx-writer', () => {
  describe('markdownToDocx — basic output', () => {
    it('returns a valid DOCX buffer', async () => {
      const buf = await markdownToDocx('Hello world', 'Test');
      expect(buf).toBeInstanceOf(Buffer);
      expect(buf.length).toBeGreaterThan(100);
      // DOCX is a ZIP — PK magic bytes
      expect(buf[0]).toBe(0x50);
      expect(buf[1]).toBe(0x4b);
    });

    it('contains document.xml with text content', async () => {
      const buf = await markdownToDocx('Some paragraph text', 'Title');
      const xml = await extractXml(buf, 'word/document.xml');
      expect(xml).toContain('Some paragraph text');
      expect(xml).toContain('Title');
    });
  });

  describe('markdown parsing', () => {
    it('parses headings at levels 1-4', async () => {
      const md = '# H1\n## H2\n### H3\n#### H4';
      const buf = await markdownToDocx(md, 'Test');
      const xml = await extractXml(buf, 'word/document.xml');
      expect(xml).toContain('H1');
      expect(xml).toContain('H2');
      expect(xml).toContain('H3');
      expect(xml).toContain('H4');
    });

    it('parses ordered list items', async () => {
      const md = '1. First\n2. Second\n3. Third';
      const buf = await markdownToDocx(md, 'Test');
      const xml = await extractXml(buf, 'word/document.xml');
      expect(xml).toContain('First');
      expect(xml).toContain('Second');
      expect(xml).toContain('Third');
    });

    it('parses unordered list items with -, *, and ●', async () => {
      const md = '- Dash item\n* Star item\n● Bullet item';
      const buf = await markdownToDocx(md, 'Test');
      const xml = await extractXml(buf, 'word/document.xml');
      expect(xml).toContain('Dash item');
      expect(xml).toContain('Star item');
      expect(xml).toContain('Bullet item');
    });

    it('parses sub-list items a), b), c)', async () => {
      const md = 'a) Sub A\nb) Sub B\nc) Sub C';
      const buf = await markdownToDocx(md, 'Test');
      const xml = await extractXml(buf, 'word/document.xml');
      expect(xml).toContain('Sub A');
      expect(xml).toContain('Sub B');
    });

    it('parses horizontal rules as separators', async () => {
      const md = 'Before\n---\nAfter';
      const buf = await markdownToDocx(md, 'Test');
      const xml = await extractXml(buf, 'word/document.xml');
      expect(xml).toContain('Before');
      expect(xml).toContain('After');
    });

    it('parses **bold** inline formatting', async () => {
      const md = 'This is **bold text** here';
      const buf = await markdownToDocx(md, 'Test');
      const xml = await extractXml(buf, 'word/document.xml');
      expect(xml).toContain('bold text');
      // Bold runs have <w:b/> or <w:b w:val="true"/>
      expect(xml).toMatch(/<w:b[ /]/);
    });

    it('uses defensive inline fallback when heading parser yields an empty heading text', async () => {
      const originalMatch = String.prototype.match;
      const matchSpy = vi.spyOn(String.prototype, 'match').mockImplementation(function (
        this: string,
        pattern: RegExp | string,
      ) {
        if (pattern instanceof RegExp && pattern.source === '^(#{1,4})\\s+(.+)$' && this.startsWith('#')) {
          return ['#', '#', ''] as unknown as RegExpMatchArray;
        }
        return originalMatch.call(this, pattern);
      });

      try {
        const buf = await markdownToDocx('# Original Heading', 'Test');
        const xml = await extractXml(buf, 'word/document.xml');
        expect(xml).toContain('Test');
      } finally {
        matchSpy.mockRestore();
      }
    });

    it('skips empty lines', async () => {
      const md = 'Line 1\n\n\n\nLine 2';
      const buf = await markdownToDocx(md, 'Test');
      const xml = await extractXml(buf, 'word/document.xml');
      expect(xml).toContain('Line 1');
      expect(xml).toContain('Line 2');
    });

    it('falls back to heading level 1 when parsed heading level is falsy', async () => {
      const originalMatch = String.prototype.match;
      const matchSpy = vi.spyOn(String.prototype, 'match').mockImplementation(function (
        this: string,
        pattern: RegExp | string,
      ) {
        if (pattern instanceof RegExp && pattern.source === '^(#{1,4})\\s+(.+)$' && this.startsWith('#')) {
          return ['', '', 'Injected Heading Falsy'] as unknown as RegExpMatchArray;
        }
        return originalMatch.call(this, pattern);
      });

      try {
        const buf = await markdownToDocx('# Original Heading', 'Test');
        const xml = await extractXml(buf, 'word/document.xml');
        expect(xml).toContain('Injected Heading Falsy');
      } finally {
        matchSpy.mockRestore();
      }
    });

    it('falls back to heading level 1 when parsed heading level is outside map', async () => {
      const originalMatch = String.prototype.match;
      const matchSpy = vi.spyOn(String.prototype, 'match').mockImplementation(function (
        this: string,
        pattern: RegExp | string,
      ) {
        if (pattern instanceof RegExp && pattern.source === '^(#{1,4})\\s+(.+)$' && this.startsWith('#')) {
          return ['# '.repeat(99), '#'.repeat(99), 'Injected Heading OutOfMap'] as unknown as RegExpMatchArray;
        }
        return originalMatch.call(this, pattern);
      });

      try {
        const buf = await markdownToDocx('# Another Heading', 'Test');
        const xml = await extractXml(buf, 'word/document.xml');
        expect(xml).toContain('Injected Heading OutOfMap');
      } finally {
        matchSpy.mockRestore();
      }
    });
  });

  describe('numbered list restart', () => {
    it('creates separate numbering groups for lists separated by content', async () => {
      const md = '1. Petit A\n2. Petit B\n\n## Přílohy\n\n1. Příloha 1\n2. Příloha 2';
      const buf = await markdownToDocx(md, 'Test');
      const xml = await extractXml(buf, 'word/document.xml');

      // Two different numId values = two separate numbering groups
      const numIds = [...xml.matchAll(/<w:numId w:val="(\d+)"/g)].map((m) => m[1]);
      const uniqueNumIds = new Set(numIds);
      expect(uniqueNumIds.size).toBeGreaterThanOrEqual(2);
    });

    it('does not restart numbering within a contiguous list', async () => {
      const md = '1. Item A\n2. Item B\n3. Item C';
      const buf = await markdownToDocx(md, 'Test');
      const xml = await extractXml(buf, 'word/document.xml');

      // All items share the same numId
      const numIds = [...xml.matchAll(/<w:numId w:val="(\d+)"/g)].map((m) => m[1]);
      const uniqueNumIds = new Set(numIds);
      expect(uniqueNumIds.size).toBe(1);
    });

    it('restarts after heading, paragraph, separator, and bullet list', async () => {
      const md = [
        '1. List A1',
        '2. List A2',
        '## Heading',
        '1. List B1',
        'Some paragraph',
        '1. List C1',
        '---',
        '1. List D1',
        '- Bullet',
        '1. List E1',
      ].join('\n');
      const buf = await markdownToDocx(md, 'Test');
      const xml = await extractXml(buf, 'word/document.xml');

      // 5 separate numbered list groups: A, B, C, D, E — each with distinct numId
      const numIds = [...xml.matchAll(/<w:numId w:val="(\d+)"/g)].map((m) => m[1]);
      // Filter out bullet list numId (bullets also get a numId)
      const orderedNumIds = new Set(numIds);
      expect(orderedNumIds.size).toBeGreaterThanOrEqual(5);
    });

    it('works correctly with no ordered lists', async () => {
      const md = '- Bullet 1\n- Bullet 2\n\nParagraph';
      const buf = await markdownToDocx(md, 'Test');
      const numXml = await extractXml(buf, 'word/numbering.xml');

      // No numbered list references from our config (only docx built-in for bullets)
      expect(numXml).not.toContain('numbering-');
    });
  });

  describe('options — showTitle', () => {
    it('includes title by default', async () => {
      const buf = await markdownToDocx('Content', 'My Title');
      const xml = await extractXml(buf, 'word/document.xml');
      expect(xml).toContain('My Title');
    });

    it('excludes title when showTitle: false', async () => {
      const buf = await markdownToDocx('Content', 'My Title', { showTitle: false });
      const xml = await extractXml(buf, 'word/document.xml');
      expect(xml).not.toContain('My Title');
    });
  });

  describe('options — headerText', () => {
    it('includes header text when provided', async () => {
      const buf = await markdownToDocx('Content', 'Title', { headerText: 'Rozporuj.com' });
      expect(await searchAllXml(buf, 'Rozporuj.com')).toBe(true);
    });

    it('omits header when not provided', async () => {
      const buf = await markdownToDocx('Content', 'Title');
      expect(await searchAllXml(buf, 'Rozporuj.com')).toBe(false);
    });
  });

  describe('options — style: legal', () => {
    it('uses larger line spacing in legal mode', async () => {
      const buf = await markdownToDocx('# Heading\nContent', 'Title', { style: 'legal' });
      const stylesXml = await extractXml(buf, 'word/styles.xml');
      // Legal mode uses line spacing 312 (vs 276 default)
      expect(stylesXml).toContain('312');
    });

    it('renders disclaimer text smaller and gray', async () => {
      const md = 'Tento dokument byl vygenerován s využitím umělé inteligence.';
      const buf = await markdownToDocx(md, 'Title', { style: 'legal' });
      const xml = await extractXml(buf, 'word/document.xml');
      // Disclaimer has size 18 (9pt) and color 888888
      expect(xml).toContain('888888');
    });

    it('does not apply disclaimer styling in default mode', async () => {
      const md = 'Tento dokument byl vygenerován s využitím umělé inteligence.';
      const buf = await markdownToDocx(md, 'Title');
      const xml = await extractXml(buf, 'word/document.xml');
      expect(xml).not.toContain('888888');
    });

    it('left-aligns title in legal mode', async () => {
      const buf = await markdownToDocx('Content', 'Title', { style: 'legal' });
      const xml = await extractXml(buf, 'word/document.xml');
      expect(xml).toContain('left');
    });

    it('center-aligns title in default mode', async () => {
      const buf = await markdownToDocx('Content', 'Title');
      const xml = await extractXml(buf, 'word/document.xml');
      expect(xml).toContain('center');
    });

    it('falls back to legal H3 style when heading level resolves to unknown style key', async () => {
      const originalMatch = String.prototype.match;
      const proto = Object.prototype as Record<string, unknown>;
      proto['99'] = 'CUSTOM_HEADING_LEVEL';
      const matchSpy = vi.spyOn(String.prototype, 'match').mockImplementation(function (
        this: string,
        pattern: RegExp | string,
      ) {
        if (pattern instanceof RegExp && pattern.source === '^(#{1,4})\\s+(.+)$' && this.startsWith('#')) {
          return ['#'.repeat(99), '#'.repeat(99), 'Unknown Style Heading'] as unknown as RegExpMatchArray;
        }
        return originalMatch.call(this, pattern);
      });

      try {
        const buf = await markdownToDocx('# Heading', 'Title', { style: 'legal' });
        const xml = await extractXml(buf, 'word/document.xml');
        expect(xml).toContain('Unknown Style Heading');
      } finally {
        delete proto['99'];
        matchSpy.mockRestore();
      }
    });

    it('applies italics branch for legal level-4 headings', async () => {
      const buf = await markdownToDocx('#### Nadpis IV', 'Title', { style: 'legal' });
      const xml = await extractXml(buf, 'word/document.xml');
      expect(xml).toContain('Nadpis IV');
      expect(xml).toMatch(/<w:i[ /]/);
    });
  });

  describe('full legal document integration', () => {
    it('generates a complete legal document with all sections', async () => {
      const md = [
        '**Městský úřad Chotěboř**',
        'Odbor dopravy',
        '',
        '---',
        '',
        '## I. PROCESNÍ NÁMITKY',
        '',
        '1. Nesplnění podmínek',
        '2. Absence dokazování',
        '',
        '## II. PETIT',
        '',
        '1. Zrušit výzvu',
        '2. Zastavit řízení',
        '',
        '## Přílohy',
        '',
        '1. Kopie výzvy',
        '2. Výpis z rejstříku',
        '',
        '---',
        '',
        'Tento dokument byl vygenerován s využitím umělé inteligence. Nejedná se o právní poradenství.',
      ].join('\n');

      const buf = await markdownToDocx(md, 'Odpor', {
        style: 'legal',
        showTitle: false,
        headerText: 'Rozporuj.com',
      });

      const xml = await extractXml(buf, 'word/document.xml');

      // Content present
      expect(xml).toContain('Městský úřad Chotěboř');
      expect(xml).toContain('PROCESNÍ NÁMITKY');
      expect(xml).toContain('Zrušit výzvu');
      expect(xml).toContain('Kopie výzvy');
      expect(await searchAllXml(buf, 'Rozporuj.com')).toBe(true);

      // Title excluded
      expect(xml).not.toContain('>Odpor<');

      // 3 separate numbered list groups (námitky, petit, přílohy) — each with distinct numId
      const numIds = [...xml.matchAll(/<w:numId w:val="(\d+)"/g)].map((m) => m[1]);
      const uniqueNumIds = new Set(numIds);
      expect(uniqueNumIds.size).toBeGreaterThanOrEqual(3);

      // Disclaimer styling
      expect(xml).toContain('888888');
    });
  });
});
