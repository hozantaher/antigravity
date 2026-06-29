#!/usr/bin/env tsx
/**
 * DOCX + PDF conversion step for e2e-worker.sh
 *
 * Reads markdown from a file, converts to DOCX and PDF,
 * writes output files and prints a JSON summary to stdout.
 */
import { readFileSync, writeFileSync } from 'fs';
import { markdownToDocx } from './lib/docx-writer.js';
import { docxToPdf } from '../worker/pdf.js';

const [mdPath, docxPath, pdfPath] = process.argv.slice(2);

if (!mdPath || !docxPath || !pdfPath) {
  console.error('Usage: e2e-worker-run.ts <markdown-file> <docx-output> <pdf-output>');
  process.exit(1);
}

const run = async () => {
  const markdown = readFileSync(mdPath, 'utf-8');

  console.error('Converting markdown → DOCX...');
  const docxBuffer = await markdownToDocx(markdown, 'Odpor proti pokutě — E2E Test', {
    style: 'legal',
    showTitle: false,
    headerText: 'Rozporuj.com',
  });
  writeFileSync(docxPath, docxBuffer);

  console.error('Converting DOCX → PDF (LibreOffice)...');
  const pdfBuffer = await docxToPdf(docxBuffer);
  writeFileSync(pdfPath, pdfBuffer);

  console.log(JSON.stringify({ docxSize: docxBuffer.length, pdfSize: pdfBuffer.length }));
};

run().catch((e) => {
  console.error(`FATAL: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
