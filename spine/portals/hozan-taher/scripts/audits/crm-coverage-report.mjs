#!/usr/bin/env node
// crm-coverage-report.mjs — per-segment CRM coverage analysis
// Shows which segments have highest CRM overlap, useful for operator
// deciding which segment to launch next.
//
// Usage:
//   pnpm crm:coverage          # Markdown output (default)
//   pnpm crm:coverage --json   # JSON output
//
// Prerequisites:
//   DATABASE_URL env var (loaded from apps/outreach-dashboard/.env).
//
// Output:
//   - Per-segment: company_count, crm_blocked, % overlap, status breakdown
//   - Top 5 sectors most-blocked by CRM
//   - Top 5 regions most-blocked by CRM
//   - Recommendations for launch sequence

import pg from 'pg'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// ── env bootstrap ──────────────────────────────────────────────────────────
const here = dirname(fileURLToPath(import.meta.url))
const envPath = join(here, '..', '..', 'apps', 'outreach-dashboard', '.env')
if (existsSync(envPath)) {
  readFileSync(envPath, 'utf8')
    .split('\n')
    .forEach(l => {
      const [k, ...v] = l.split('=')
      if (k && v.length && !process.env[k.trim()]) {
        process.env[k.trim()] = v.join('=').trim()
      }
    })
}

const DB_URL = process.env.DATABASE_URL

if (!DB_URL) {
  console.error('✗ DATABASE_URL not set')
  process.exit(1)
}

// ── arg parsing ────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const asJson = args.includes('--json')

// ── query data ─────────────────────────────────────────────────────────────
const pool = new pg.Pool({ connectionString: DB_URL })

try {
  // Main CTE: per-segment membership + CRM coverage stats
  const result = await pool.query(`
WITH segment_stats AS (
  -- Per-segment: total members, crm-blocked count, status breakdown
  SELECT
    s.id,
    s.name,
    s.description,
    COUNT(DISTINCT sm.company_id) as total_members,
    COUNT(DISTINCT CASE WHEN co.crm_client_id IS NOT NULL THEN sm.company_id END) as crm_blocked_count,
    COUNT(DISTINCT CASE WHEN cr.crm_status = 'Aktuální' THEN sm.company_id END) as status_aktualni,
    COUNT(DISTINCT CASE WHEN cr.crm_status = 'Potenciální' THEN sm.company_id END) as status_potencialni,
    COUNT(DISTINCT CASE WHEN cr.crm_status = 'Začínáme' THEN sm.company_id END) as status_zaciname,
    COUNT(DISTINCT CASE WHEN cr.crm_status = 'Nezajímavý' THEN sm.company_id END) as status_nezajimavý,
    COUNT(DISTINCT CASE WHEN co.crm_client_id IS NULL THEN sm.company_id END) as crm_available_count,
    -- For sector/region rankings, aggregate top values within segment
    ARRAY_AGG(DISTINCT COALESCE(co.sector_primary, 'unknown') ORDER BY COALESCE(co.sector_primary, 'unknown')) FILTER (WHERE co.crm_client_id IS NOT NULL) as blocked_sectors_list,
    ARRAY_AGG(DISTINCT COALESCE(co.region_normalized, 'unknown') ORDER BY COALESCE(co.region_normalized, 'unknown')) FILTER (WHERE co.crm_client_id IS NOT NULL) as blocked_regions_list
  FROM segments s
  LEFT JOIN segment_memberships sm ON s.id = sm.segment_id
  LEFT JOIN companies co ON sm.company_id = co.id
  LEFT JOIN crm_clients cr ON co.crm_client_id = cr.id
  GROUP BY s.id, s.name, s.description
  HAVING COUNT(DISTINCT sm.company_id) > 0
  ORDER BY s.name
),
-- Top 5 sectors by blocked count across all segments
top_sectors AS (
  SELECT
    COALESCE(co.sector_primary, 'unknown') as sector,
    COUNT(*) as blocked_count,
    COUNT(*) FILTER (WHERE cr.crm_status = 'Aktuální') as aktualni_count,
    COUNT(*) FILTER (WHERE cr.crm_status = 'Potenciální') as potencialni_count
  FROM segment_memberships sm
  JOIN companies co ON sm.company_id = co.id
  LEFT JOIN crm_clients cr ON co.crm_client_id = cr.id
  WHERE co.crm_client_id IS NOT NULL
  GROUP BY co.sector_primary
  ORDER BY blocked_count DESC
  LIMIT 5
),
-- Top 5 regions by blocked count across all segments
top_regions AS (
  SELECT
    COALESCE(co.region_normalized, 'unknown') as region,
    COUNT(*) as blocked_count,
    COUNT(*) FILTER (WHERE cr.crm_status = 'Aktuální') as aktualni_count,
    COUNT(*) FILTER (WHERE cr.crm_status = 'Potenciální') as potencialni_count
  FROM segment_memberships sm
  JOIN companies co ON sm.company_id = co.id
  LEFT JOIN crm_clients cr ON co.crm_client_id = cr.id
  WHERE co.crm_client_id IS NOT NULL
  GROUP BY co.region_normalized
  ORDER BY blocked_count DESC
  LIMIT 5
)
SELECT
  'segments'::text as result_type,
  ROW_TO_JSON(t.*) as data
FROM segment_stats t
UNION ALL
SELECT
  'top_sectors'::text,
  ROW_TO_JSON(t.*)
FROM top_sectors t
UNION ALL
SELECT
  'top_regions'::text,
  ROW_TO_JSON(t.*)
FROM top_regions t
  `)

  const segments = []
  const topSectors = []
  const topRegions = []

  for (const row of result.rows) {
    if (row.result_type === 'segments') {
      segments.push(row.data)
    } else if (row.result_type === 'top_sectors') {
      topSectors.push(row.data)
    } else if (row.result_type === 'top_regions') {
      topRegions.push(row.data)
    }
  }

  // ── Format output ────────────────────────────────────────────────────────
  if (asJson) {
    const output = {
      generated_at: new Date().toISOString(),
      segments: segments.map(s => ({
        id: s.id,
        name: s.name,
        total_members: s.total_members,
        crm_blocked_count: s.crm_blocked_count,
        crm_blocked_pct: s.total_members > 0 ? ((s.crm_blocked_count / s.total_members) * 100).toFixed(1) : 0,
        crm_available_count: s.crm_available_count,
        status_breakdown: {
          aktualni: s.status_aktualni,
          potencialni: s.status_potencialni,
          zaciname: s.status_zaciname,
          nezajimavý: s.status_nezajimavý,
        },
        recommendation: getRecommendation(s.total_members, s.crm_blocked_count),
      })),
      top_sectors_blocked: topSectors.map(s => ({
        sector: s.sector || 'unknown',
        blocked_count: s.blocked_count,
        status_breakdown: {
          aktualni: s.aktualni_count,
          potencialni: s.potencialni_count,
        },
      })),
      top_regions_blocked: topRegions.map(r => ({
        region: r.region || 'unknown',
        blocked_count: r.blocked_count,
        status_breakdown: {
          aktualni: r.aktualni_count,
          potencialni: r.potencialni_count,
        },
      })),
    }
    console.log(JSON.stringify(output, null, 2))
  } else {
    // Markdown format
    const lines = []
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ')

    lines.push('# CRM Coverage Report')
    lines.push('')
    lines.push(`Generated: ${now}`)
    lines.push('')

    if (segments.length === 0) {
      lines.push('**No segments with members yet.**')
      lines.push('')
    } else {
      lines.push('## Segment Coverage')
      lines.push('')
      lines.push('| Segment | Members | CRM Blocked | % | Available | Recommendation |')
      lines.push('|---------|---------|------------|---|-----------|-----------------|')

      for (const seg of segments) {
        const pct = seg.total_members > 0
          ? ((seg.crm_blocked_count / seg.total_members) * 100).toFixed(1)
          : 0
        const recommendation = getRecommendation(seg.total_members, seg.crm_blocked_count)
        lines.push(`| ${seg.name} | ${seg.total_members} | ${seg.crm_blocked_count} | ${pct}% | ${seg.crm_available_count} | ${recommendation} |`)
      }
      lines.push('')

      // Detailed breakdown per segment
      lines.push('## Segment Details')
      lines.push('')

      for (const seg of segments) {
        const pct = seg.total_members > 0
          ? ((seg.crm_blocked_count / seg.total_members) * 100).toFixed(1)
          : 0
        lines.push(`### ${seg.name}`)
        lines.push(`Total: **${seg.total_members}** companies | CRM-blocked: **${seg.crm_blocked_count}** (${pct}%) | Available: **${seg.crm_available_count}**`)
        lines.push('')
        lines.push('#### CRM Status Breakdown')
        lines.push(`- Aktuální: ${seg.status_aktualni}`)
        lines.push(`- Potenciální: ${seg.status_potencialni}`)
        lines.push(`- Začínáme: ${seg.status_zaciname}`)
        lines.push(`- Nezajímavý: ${seg.status_nezajimavý}`)
        lines.push('')
      }
    }

    // Top sectors blocked
    if (topSectors.length > 0) {
      lines.push('## Top 5 Sectors Most CRM-Blocked')
      lines.push('')
      lines.push('| Sector | Blocked | Aktuální | Potenciální |')
      lines.push('|--------|---------|----------|-------------|')

      for (const sec of topSectors) {
        const sectorName = sec.sector || 'unknown'
        lines.push(`| ${sectorName} | ${sec.blocked_count} | ${sec.aktualni_count} | ${sec.potencialni_count} |`)
      }
      lines.push('')
    }

    // Top regions blocked
    if (topRegions.length > 0) {
      lines.push('## Top 5 Regions Most CRM-Blocked')
      lines.push('')
      lines.push('| Region | Blocked | Aktuální | Potenciální |')
      lines.push('|--------|---------|----------|-------------|')

      for (const reg of topRegions) {
        const regionName = reg.region || 'unknown'
        lines.push(`| ${regionName} | ${reg.blocked_count} | ${reg.aktualni_count} | ${reg.potencialni_count} |`)
      }
      lines.push('')
    }

    // Footer
    lines.push('## Guidance')
    lines.push('')
    lines.push('- **Low CRM overlap (<20%)**: Segment is safe to launch immediately.')
    lines.push('- **Medium overlap (20-50%)**: Segment is launchable with operator review of affected companies.')
    lines.push('- **High overlap (>50%)**: Coordinate with CRM team before launch; many prospects are active opportunities.')
    lines.push('')

    console.log(lines.join('\n'))
  }

  await pool.end()
  process.exit(0)
} catch (e) {
  console.error('✗ Error:', e.message)
  await pool.end()
  process.exit(1)
}

// ── Helper: generate launch recommendation ────────────────────────────────
function getRecommendation(total, blocked) {
  if (total === 0) return 'No data'
  const pct = (blocked / total) * 100
  if (pct < 20) return '🟢 Safe'
  if (pct < 50) return '🟡 Review'
  return '🔴 Coordinate'
}
