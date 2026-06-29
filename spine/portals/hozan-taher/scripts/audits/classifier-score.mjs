#!/usr/bin/env node
// classifier-score.mjs — Sprint B2: compute accuracy from operator-filled CSV
//
// Reads a CSV that was produced by classifier-accuracy.mjs and then filled in
// by the operator (ground_truth_label_BLANK column). Computes:
//   - Overall accuracy (correct / total)
//   - Per-label precision and recall
//   - Low-confidence breakdown (llm_confidence < 0.7 where populated)
//   - Confusion matrix (llm_label × ground_truth_label)
//
// Writes a Markdown report to reports/classifier-accuracy/YYYY-MM-DD-classifier-score.md
// and prints a summary to stdout.
//
// Usage: node scripts/audits/classifier-score.mjs <path-to-filled-csv>
// Or via pnpm: pnpm run audit:classifier-score <path-to-filled-csv>

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const VALID_LABELS = new Set(['interested', 'meeting', 'later', 'objection', 'negative', 'ooo'])
const CONFIDENCE_THRESHOLD = 0.7

// ── CSV parser ─────────────────────────────────────────────────────────────
// Minimal RFC-4180 parser: handles quoted fields with embedded commas/newlines/
// double-double-quote escapes. Does NOT handle multi-line field newlines within
// the same row (not needed for this use case — body is pre-truncated).
function parseCsv(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const rows = []
  for (const line of lines) {
    if (!line.trim()) continue
    const fields = []
    let i = 0
    while (i < line.length) {
      if (line[i] === '"') {
        // Quoted field
        let j = i + 1
        let val = ''
        while (j < line.length) {
          if (line[j] === '"' && line[j + 1] === '"') {
            val += '"'
            j += 2
          } else if (line[j] === '"') {
            j++
            break
          } else {
            val += line[j]
            j++
          }
        }
        fields.push(val)
        i = j
        if (line[i] === ',') i++
      } else {
        // Unquoted field
        const end = line.indexOf(',', i)
        if (end === -1) {
          fields.push(line.slice(i))
          break
        } else {
          fields.push(line.slice(i, end))
          i = end + 1
        }
      }
    }
    rows.push(fields)
  }
  return rows
}

// ── Metrics ────────────────────────────────────────────────────────────────
function computeMetrics(records) {
  const labels = Array.from(
    new Set([...records.map(r => r.llm_label), ...records.map(r => r.ground_truth)].filter(Boolean))
  ).sort()

  // Overall accuracy
  const total = records.length
  const correct = records.filter(r => r.llm_label === r.ground_truth).length
  const accuracy = total > 0 ? correct / total : 0

  // Per-label precision and recall
  // Precision(L) = TP(L) / (TP(L) + FP(L)) — of predictions L, how many correct
  // Recall(L)    = TP(L) / (TP(L) + FN(L)) — of ground-truth L, how many found
  const perLabel = {}
  for (const label of labels) {
    const tp = records.filter(r => r.llm_label === label && r.ground_truth === label).length
    const fp = records.filter(r => r.llm_label === label && r.ground_truth !== label).length
    const fn = records.filter(r => r.llm_label !== label && r.ground_truth === label).length

    const precision = (tp + fp) > 0 ? tp / (tp + fp) : null
    const recall    = (tp + fn) > 0 ? tp / (tp + fn) : null
    const f1 = (precision != null && recall != null && (precision + recall) > 0)
      ? 2 * precision * recall / (precision + recall)
      : null

    perLabel[label] = { tp, fp, fn, precision, recall, f1 }
  }

  // Low-confidence breakdown (only records where llm_confidence is populated)
  const withConf = records.filter(r => r.llm_confidence != null && !isNaN(r.llm_confidence))
  const lowConf = withConf.filter(r => r.llm_confidence < CONFIDENCE_THRESHOLD)
  const lowConfCorrect = lowConf.filter(r => r.llm_label === r.ground_truth).length
  const highConf = withConf.filter(r => r.llm_confidence >= CONFIDENCE_THRESHOLD)
  const highConfCorrect = highConf.filter(r => r.llm_label === r.ground_truth).length

  // Confusion matrix: rows = llm_label, cols = ground_truth
  const matrix = {}
  for (const r of records) {
    if (!r.llm_label || !r.ground_truth) continue
    if (!matrix[r.llm_label]) matrix[r.llm_label] = {}
    matrix[r.llm_label][r.ground_truth] = (matrix[r.llm_label][r.ground_truth] || 0) + 1
  }

  return { labels, total, correct, accuracy, perLabel, lowConf, lowConfCorrect, highConf, highConfCorrect, withConf, matrix }
}

// ── Report rendering ────────────────────────────────────────────────────────
function pct(n) {
  if (n == null) return 'N/A'
  return (n * 100).toFixed(1) + '%'
}

function renderMarkdown(metrics, inputFile, dateStr) {
  const { labels, total, correct, accuracy, perLabel, lowConf, lowConfCorrect, highConf, highConfCorrect, withConf, matrix } = metrics
  const targetMet = accuracy >= 0.9 ? 'MET' : 'NOT MET'
  const targetEmoji = accuracy >= 0.9 ? '' : ' — below 90% target'

  const lines = [
    `# Classifier Accuracy Report — ${dateStr}`,
    '',
    `**Input file:** \`${basename(inputFile)}\`  `,
    `**Generated:** ${new Date().toISOString()}  `,
    `**Target:** ≥90% accuracy at confidence ≥0.7  `,
    '',
    `## Overall Accuracy`,
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Correct predictions | ${correct} / ${total} |`,
    `| Overall accuracy | **${pct(accuracy)}** |`,
    `| Target (≥90%) | **${targetMet}**${targetEmoji} |`,
    '',
  ]

  // Confidence breakdown (only if llm_confidence column was populated)
  if (withConf.length > 0) {
    lines.push(`## Confidence Breakdown`)
    lines.push('')
    lines.push(`| Bucket | Count | Correct | Accuracy |`)
    lines.push(`|--------|-------|---------|----------|`)
    lines.push(`| High (≥${CONFIDENCE_THRESHOLD}) | ${highConf.length} | ${highConfCorrect} | ${highConf.length > 0 ? pct(highConfCorrect / highConf.length) : 'N/A'} |`)
    lines.push(`| Low (<${CONFIDENCE_THRESHOLD}) | ${lowConf.length} | ${lowConfCorrect} | ${lowConf.length > 0 ? pct(lowConfCorrect / lowConf.length) : 'N/A'} |`)
    lines.push(`| No confidence | ${total - withConf.length} | — | — |`)
    lines.push('')
  } else {
    lines.push(`> Note: \`llm_confidence\` column is not yet populated (classifier does not persist confidence scores in this version).`)
    lines.push(`> See KT-B3 for confidence tracking initiative.`)
    lines.push('')
  }

  // Per-label precision/recall
  lines.push(`## Per-Label Precision / Recall`)
  lines.push('')
  lines.push(`| Label | TP | FP | FN | Precision | Recall | F1 |`)
  lines.push(`|-------|----|----|----|-----------|---------|----|`)
  for (const label of labels) {
    const m = perLabel[label]
    if (!m) continue
    lines.push(`| ${label} | ${m.tp} | ${m.fp} | ${m.fn} | ${pct(m.precision)} | ${pct(m.recall)} | ${pct(m.f1)} |`)
  }
  lines.push('')

  // Confusion matrix
  const matrixLabels = Array.from(
    new Set([...Object.keys(matrix), ...labels])
  ).sort()

  if (matrixLabels.length > 0) {
    lines.push(`## Confusion Matrix`)
    lines.push('')
    lines.push(`_Rows = LLM prediction, Columns = Ground truth_`)
    lines.push('')
    lines.push(`| LLM \\ GT | ${matrixLabels.join(' | ')} |`)
    lines.push(`|${'-'.repeat(9)}|${matrixLabels.map(() => '---').join('|')}|`)
    for (const pred of matrixLabels) {
      const cells = matrixLabels.map(gt => {
        const n = matrix[pred]?.[gt] || 0
        return n === 0 ? '—' : (pred === gt ? `**${n}**` : String(n))
      })
      lines.push(`| ${pred} | ${cells.join(' | ')} |`)
    }
    lines.push('')
  }

  // Next steps
  lines.push(`## Next Steps`)
  lines.push('')
  if (accuracy < 0.9) {
    lines.push(`- Accuracy is below the 90% target. Review false positives/negatives in the confusion matrix.`)
    lines.push(`- Focus prompt iteration on the labels with lowest recall.`)
    lines.push(`- See \`docs/initiatives/2026-04-27-llm-reply-classifier.md\` for prompt iteration notes.`)
  } else {
    lines.push(`- Target met. No immediate prompt changes needed.`)
    lines.push(`- Consider extending to a larger sample or stratified sampling in the next sprint.`)
  }
  lines.push('')

  return lines.join('\n')
}

// ── Main ────────────────────────────────────────────────────────────────────
function main() {
  const inputFile = process.argv[2]
  if (!inputFile) {
    console.error('[classifier-score] Usage: node scripts/audits/classifier-score.mjs <filled-csv>')
    console.error('  Example: node scripts/audits/classifier-score.mjs reports/classifier-accuracy/2026-05-05-classifier-sample.csv')
    process.exit(1)
  }

  let csvText
  try {
    csvText = readFileSync(inputFile, 'utf8')
  } catch (err) {
    console.error(`[classifier-score] Cannot read input file: ${err.message}`)
    process.exit(1)
  }

  const allRows = parseCsv(csvText)
  if (allRows.length < 2) {
    console.error('[classifier-score] CSV has no data rows (or no header). Nothing to score.')
    process.exit(1)
  }

  // Parse header to find column indices
  const header = allRows[0].map(h => h.trim().toLowerCase())
  const COL = {
    id: header.indexOf('id'),
    llm_label: header.indexOf('llm_label'),
    llm_confidence: header.indexOf('llm_confidence'),
    ground_truth: header.findIndex(h => h.startsWith('ground_truth')),
    notes: header.findIndex(h => h.startsWith('notes')),
  }

  if (COL.llm_label < 0 || COL.ground_truth < 0) {
    console.error('[classifier-score] CSV must have columns: llm_label, ground_truth_label_BLANK')
    console.error('  Got headers:', header.join(', '))
    process.exit(1)
  }

  // Parse data rows
  const records = []
  const skipped = []
  for (let i = 1; i < allRows.length; i++) {
    const row = allRows[i]
    if (!row || row.every(c => !c.trim())) continue

    const id = COL.id >= 0 ? row[COL.id]?.trim() : String(i)
    const llmLabel = row[COL.llm_label]?.trim().toLowerCase() || ''
    const confRaw = COL.llm_confidence >= 0 ? row[COL.llm_confidence]?.trim() : ''
    const gt = row[COL.ground_truth]?.trim().toLowerCase() || ''

    if (!gt) {
      skipped.push({ row: i + 1, id, reason: 'ground_truth_label empty (not filled by operator)' })
      continue
    }
    if (!VALID_LABELS.has(gt)) {
      skipped.push({ row: i + 1, id, reason: `unknown ground_truth label "${gt}" — valid: ${[...VALID_LABELS].join(', ')}` })
      continue
    }

    const llm_confidence = confRaw ? parseFloat(confRaw) : null

    records.push({ id, llm_label: llmLabel, llm_confidence, ground_truth: gt })
  }

  if (skipped.length > 0) {
    console.warn(`[classifier-score] Skipped ${skipped.length} row(s):`)
    for (const s of skipped) {
      console.warn(`  row ${s.row} (id=${s.id}): ${s.reason}`)
    }
  }

  if (records.length === 0) {
    console.error('[classifier-score] No scoreable records found. Has the operator filled in the ground_truth_label_BLANK column?')
    process.exit(1)
  }

  const metrics = computeMetrics(records)
  const { total, correct, accuracy, perLabel, labels } = metrics

  // ── Stdout summary ────────────────────────────────────────────────────────
  console.log()
  console.log('═══════════════════════════════════════════════════')
  console.log(' Classifier Accuracy — Sprint B2 Report')
  console.log('═══════════════════════════════════════════════════')
  console.log()
  console.log(`  Overall accuracy : ${pct(accuracy)}  (${correct}/${total} correct)`)
  console.log(`  Target ≥90%      : ${accuracy >= 0.9 ? 'MET ✓' : 'NOT MET ✗ — below target'}`)
  console.log()
  console.log('  Per-label precision / recall:')
  for (const label of labels) {
    const m = perLabel[label]
    if (!m) continue
    console.log(`    ${label.padEnd(12)} precision=${pct(m.precision).padStart(6)}  recall=${pct(m.recall).padStart(6)}  F1=${pct(m.f1).padStart(6)}`)
  }
  console.log()

  // ── Write Markdown report ─────────────────────────────────────────────────
  const dateStr = new Date().toISOString().slice(0, 10)
  const outDir = join(__dirname, '../../reports/classifier-accuracy')
  mkdirSync(outDir, { recursive: true })
  const outPath = join(outDir, `${dateStr}-classifier-score.md`)

  const mdText = renderMarkdown(metrics, inputFile, dateStr)
  writeFileSync(outPath, mdText, 'utf8')
  console.log(`  Report written → ${outPath}`)
  console.log()

  // Exit 1 if target not met so CI can gate
  if (accuracy < 0.9) {
    console.error(`[classifier-score] Target not met: ${pct(accuracy)} < 90%`)
    process.exit(1)
  }
}

main()
