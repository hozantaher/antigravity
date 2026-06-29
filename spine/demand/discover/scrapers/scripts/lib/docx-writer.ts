import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  LevelFormat,
  Header,
  Footer,
  PageNumber,
  BorderStyle,
  convertInchesToTwip,
} from 'docx';

interface Section {
  type: 'heading' | 'paragraph' | 'list-item' | 'separator';
  level?: number;
  text: string;
  ordered?: boolean;
}

export interface DocxOptions {
  /** Header text shown on every page (top-right). Omit to hide header. */
  headerText?: string;
  /** Show centered title at top of first page. Default: true */
  showTitle?: boolean;
  /** Style preset. 'legal' = no colored headings, formal look. Default: 'default' */
  style?: 'default' | 'legal';
}

const BOLD_REGEX = /\*\*(.+?)\*\*/g;

/** Parse **bold** inline formatting into TextRun array */
const parseInline = (text: string, fontOverrides?: Partial<{ size: number; color: string; italics: boolean }>): TextRun[] => {
  const runs: TextRun[] = [];
  BOLD_REGEX.lastIndex = 0;
  let lastIndex = 0;
  let match;

  while ((match = BOLD_REGEX.exec(text)) !== null) {
    if (match.index > lastIndex) {
      runs.push(new TextRun({ text: text.slice(lastIndex, match.index), ...fontOverrides }));
    }
    runs.push(new TextRun({ text: match[1], bold: true, ...fontOverrides }));
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    runs.push(new TextRun({ text: text.slice(lastIndex), ...fontOverrides }));
  }

  return runs.length ? runs : [new TextRun({ text, ...fontOverrides })];
};

/** Parse markdown into flat section list */
const parseMarkdown = (markdown: string): Section[] => {
  const sections: Section[] = [];

  for (const line of markdown.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Horizontal rule
    if (/^-{3,}$/.test(trimmed) || /^\*{3,}$/.test(trimmed)) {
      sections.push({ type: 'separator', text: '' });
      continue;
    }

    // Headings
    const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      sections.push({ type: 'heading', level: headingMatch[1].length, text: headingMatch[2] });
      continue;
    }

    // Ordered list
    const orderedMatch = trimmed.match(/^\d+\.\s+(.+)$/);
    if (orderedMatch) {
      sections.push({ type: 'list-item', text: orderedMatch[1], ordered: true });
      continue;
    }

    // Unordered list
    const unorderedMatch = trimmed.match(/^[-*●]\s+(.+)$/);
    if (unorderedMatch) {
      sections.push({ type: 'list-item', text: unorderedMatch[1], ordered: false });
      continue;
    }

    // Sub-list items (a), b), c), d))
    const subListMatch = trimmed.match(/^[a-z]\)\s+(.+)$/);
    if (subListMatch) {
      sections.push({ type: 'list-item', text: subListMatch[1], ordered: false });
      continue;
    }

    // Regular paragraph
    sections.push({ type: 'paragraph', text: trimmed });
  }

  return sections;
};

const LEGAL_HEADING_STYLES = {
  [HeadingLevel.HEADING_1]: { size: 28, bold: true, font: 'Times New Roman', allCaps: true },
  [HeadingLevel.HEADING_2]: { size: 26, bold: true, font: 'Times New Roman' },
  [HeadingLevel.HEADING_3]: { size: 24, bold: true, font: 'Times New Roman' },
  [HeadingLevel.HEADING_4]: { size: 24, bold: true, font: 'Times New Roman', italics: true },
} as const;

const HEADING_MAP: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
};

const isDisclaimer = (text: string): boolean =>
  text.includes('vygenerován s využitím umělé inteligence') || text.includes('nejedná se o právní poradenství');

export const markdownToDocx = async (markdown: string, title: string, options?: DocxOptions): Promise<Buffer> => {
  const { headerText, showTitle = true, style = 'default' } = options || {};
  const isLegal = style === 'legal';
  const sections = parseMarkdown(markdown);

  const children: Paragraph[] = [];

  if (showTitle) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: title,
            bold: true,
            size: isLegal ? 32 : 36,
            font: 'Times New Roman',
          }),
        ],
        heading: HeadingLevel.TITLE,
        alignment: isLegal ? AlignmentType.LEFT : AlignmentType.CENTER,
        spacing: { after: isLegal ? 200 : 400 },
      }),
    );

    if (isLegal) {
      // Thin line under title
      children.push(
        new Paragraph({
          spacing: { after: 300 },
          border: {
            bottom: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC', space: 1 },
          },
        }),
      );
    }
  }

  // Track numbered list groups — each contiguous run of ordered items gets its own
  // numbering reference so that numbering restarts from 1 after any non-list content.
  let prevWasOrdered = false;
  let numberingGroupId = 0;

  const nextNumberingRef = (): string => {
    if (!prevWasOrdered) numberingGroupId++;
    return `numbering-${numberingGroupId}`;
  };

  for (const section of sections) {
    const isOrdered = section.type === 'list-item' && section.ordered;

    switch (section.type) {
      case 'separator':
        children.push(
          new Paragraph({
            spacing: { before: 200, after: 200 },
            border: {
              bottom: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC', space: 1 },
            },
          }),
        );
        break;

      case 'heading': {
        const headingLevel = HEADING_MAP[section.level || 1] || HeadingLevel.HEADING_1;

        if (isLegal) {
          const headingStyle = LEGAL_HEADING_STYLES[headingLevel] || LEGAL_HEADING_STYLES[HeadingLevel.HEADING_3];
          children.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: section.text,
                  bold: headingStyle.bold,
                  size: headingStyle.size,
                  font: headingStyle.font,
                  allCaps: 'allCaps' in headingStyle ? headingStyle.allCaps : false,
                  italics: 'italics' in headingStyle ? headingStyle.italics : false,
                }),
              ],
              spacing: { before: 360, after: 120 },
            }),
          );
        } else {
          children.push(
            new Paragraph({
              children: parseInline(section.text),
              heading: headingLevel,
              spacing: { before: 240, after: 120 },
            }),
          );
        }
        break;
      }

      case 'list-item':
        children.push(
          new Paragraph({
            children: parseInline(section.text),
            ...(section.ordered ? { numbering: { reference: nextNumberingRef(), level: 0 } } : { bullet: { level: 0 } }),
            spacing: { before: 60, after: 60 },
          }),
        );
        break;

      case 'paragraph': {
        // Detect disclaimer text — render smaller and gray
        if (isLegal && isDisclaimer(section.text.toLowerCase())) {
          children.push(
            new Paragraph({
              children: parseInline(section.text, { size: 18, color: '888888', italics: true }),
              spacing: { before: 300, after: 60 },
              border: {
                top: { style: BorderStyle.SINGLE, size: 1, color: 'DDDDDD', space: 6 },
              },
            }),
          );
        } else {
          children.push(
            new Paragraph({
              children: parseInline(section.text),
              spacing: { before: 120, after: 120 },
            }),
          );
        }
        break;
      }
    }

    prevWasOrdered = !!isOrdered;
  }

  const headerChildren = headerText
    ? [
        new Paragraph({
          children: [
            new TextRun({ text: headerText, italics: true, size: 16, color: 'AAAAAA' }),
          ],
          alignment: AlignmentType.RIGHT,
        }),
      ]
    : [];

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: 'Times New Roman', size: 24 },
          paragraph: { spacing: { line: isLegal ? 312 : 276 } },
        },
      },
    },
    numbering: {
      config: Array.from({ length: numberingGroupId }, (_, i) => ({
        reference: `numbering-${i + 1}`,
        levels: [
          {
            level: 0,
            format: LevelFormat.DECIMAL,
            text: '%1.',
            alignment: AlignmentType.START,
          },
        ],
      })),
    },
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: convertInchesToTwip(isLegal ? 1.2 : 1),
              bottom: convertInchesToTwip(1),
              left: convertInchesToTwip(1.25),
              right: convertInchesToTwip(1),
            },
          },
        },
        headers: headerChildren.length
          ? { default: new Header({ children: headerChildren }) }
          : {},
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({ children: [PageNumber.CURRENT], size: 18, color: '999999' }),
                  new TextRun({ text: ' / ', size: 18, color: '999999' }),
                  new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 18, color: '999999' }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });

  return (await Packer.toBuffer(doc)) as Buffer;
};
