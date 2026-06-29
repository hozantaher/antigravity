import { Sentry, sentryTagMiddleware, wrapPoolWithBreadcrumbs, setRouteTags } from './sentry.server.js'
import express from 'express'
import pg from 'pg'
import cors from 'cors'
import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
const __dirname = dirname(fileURLToPath(import.meta.url))
import { AsyncLocalStorage } from 'async_hooks'
import net from 'net'
import tls from 'tls'
import { SocksClient } from 'socks'
import { parseConfigIssues, calcFullCheckScore, isWarmupStale, classifyBounceHealth, formatPipelineAge, buildFullCheckSummary, analyzeHeaderAnonymity, isGreylisted } from './src/lib/mailboxUtils.js'
import { shouldAutoPause, shouldAutoResume, classifySmtpError, isFailoverWorthy, nextProxyCandidate, calcNewDailyCap, shouldAdvanceWarmup, warmupDayToCap, formatDailyReport, processImapReplies, shouldSuppress, isWithinSendWindow, classifySmtpSteps, evaluateGreylistQueueItem, evaluateMailboxGreylistResult, evaluateMailboxAutoResume, computeReverifyBudget, computeNextDailyFire } from './src/lib/automation.js'
import { formatRFC5322Date } from './src/lib/time-chaos.js'
import { verifyEmail } from './src/lib/emailProbe.js'
import { computeCompositeScore, computeExpectedValueScore, DEFAULT_WEIGHTS } from './src/lib/scoring.js'
import { renderTemplatePreview } from './src/lib/template-preview.js'
import { computeDataQuality } from './src/lib/dataQuality.js'
import { planRefreshJobs } from './src/lib/refreshPolicy.js'
import { featureVector, centroid as vecCentroid, lookalikeScore } from './src/lib/lookalike.js'
import { computeReadiness } from './src/lib/readiness.js'
import { aggregateCohorts, findCohort, DEFAULT_MIN_SAMPLE } from './src/lib/cohort.js'
import { probeDns } from './src/lib/mxLookup.js'
import { probeWeb } from './src/lib/webScrape.js'
import { probeJustice } from './src/lib/justiceCz.js'
import { probeVvz } from './src/lib/vvz.js'
import { trainLogistic, extractFeatures, suggestScoringWeights, SCORE_LEARNER_LIMITS } from './src/lib/scoreLearner.js'
import {
  persistFacts as enrichmentPersistFacts,
  SourceRateLimiter,
  CircuitBreaker,
  runWorkerTick,
} from './src/lib/enrichment.js'
import { runGuards, logBootRecovery } from './staleGuard.js'
import { runConfigDrift } from './configDrift.js'
import { classifyProbeReason, summarizeAttempts } from './proxyDiagnostics.js'
import * as authCache from './authCache.js'
import { computeCampaignPreflight } from './campaignPreflight.js'
import { aggregateProxyExhaust } from './proxyExhaustAlert.js'
import * as poolTrend from './poolTrend.js'
import { makeProxyWatchdog } from './proxyWatchdog.js'
import { runMailboxBounceThrottle } from './mailboxBounceThrottle.js'
import { execSync } from 'child_process'
import { runDNSCheck } from './src/lib/dnsCheck.js'
import { createAuthMiddleware } from './src/lib/authMiddleware.js'
import { requireDashboardAuth } from './src/lib/dashboardAuth.js'
import { createErrorMiddleware } from './src/lib/errorMiddleware.js'
import { createRateLimitMiddleware } from './src/lib/rateLimitMiddleware.js'
import { capture500 } from './src/lib/sentryCapture.js'
import { runBootInvariants } from './src/lib/invariant.js'
import { suppressionExistsFor, SUPPRESSION_LOOKUP_SQL } from './src/lib/suppressionFilter.js'
import { mountDsrRoutes } from './src/server-routes/dsr.js'
import { mountDashboardSummaryRoutes } from './src/server-routes/dashboardSummary.js'
import { mountBulkPasswordRoute } from './src/server-routes/bulkPassword.js'
import { mountTemplatePreviewRoute } from './src/server-routes/templatePreview.js'
import { mountTemplatesRoutes } from './src/server-routes/templates.js'
import { mountPrivacyRoutes } from './src/server-routes/privacy.js'
import { mountHealthRoutes } from './src/server-routes/health.js'
import { mountMailboxRoutes } from './src/server-routes/mailboxes.js'
import { mountCampaignsRoutes } from './src/server-routes/campaigns.js'
import { mountCampaignDryRunRoutes } from './src/server-routes/campaignDryRun.js'
import { mountRepliesRoutes } from './src/server-routes/replies.js'
import { mountRepliesStatsRoute } from './src/server-routes/repliesStats.js'
import { mountRepliesExtractRoutes } from './src/server-routes/repliesExtract.js'
import { mountReplyDraftRoute } from './src/server-routes/replyDraft.js'
import { mountSearchRoute } from './src/server-routes/search.js'
import { mountDataQualityRoute } from './src/server-routes/dataQualityChecks.js'
import { mountIngestFreshnessRoute } from './src/server-routes/ingestFreshness.js'
import { mountDataQualityFixRoute } from './src/server-routes/dataQualityFix.js'
import { mountReplyClassifyEndpoint, runAutoClassifyCron } from './src/server-routes/replyClassifyEndpoint.js'
import { callLlmRunnerGenerate, LLM_RUNNER_TIMEOUT_MS } from './src/lib/llmRunnerClient.js'
import { mountVehiclesRoutes } from './src/server-routes/vehicles.js'
import { mountUnsubscribeRoutes, resolveUnsubscribeSecret } from './src/server-routes/unsubscribe.js'
import { mountCompaniesRoutes } from './src/server-routes/companies.js'
import { mountContactsRoutes } from './src/server-routes/contacts.js'
// Story LXY (2026-05-28) — live activity ticker on Home.
import { mountDashboardLiveActivityEndpoint } from './src/server-routes/dashboardLiveActivity.js'
import { mountScoringRoutes } from './src/server-routes/scoring.js'
import { mountLeadsRoutes } from './src/server-routes/leads.js'
import { runEngagementCapAdjustmentCron } from './src/server-routes/engagementCapAdjustment.js'
import { mountSuppressionRoutes } from './src/server-routes/suppression.js'
import { mountSegmentsRoutes } from './src/server-routes/segments.js'
import { mountAnonymityRoutes } from './src/server-routes/anonymityLatest.js'
import { mountMetaRoutes } from './src/server-routes/meta.js'
import { mountProtectionsRoutes } from './src/server-routes/protections.js'
import { mountOperatorMetricsRoutes } from './src/server-routes/operatorMetrics.js'
import { mountThreadsRoutes } from './src/server-routes/threads.js'
import { mountReplyTemplatesRoutes } from './src/server-routes/replyTemplates.js'
import { mountHaltAdvisoryRoutes } from './src/server-routes/haltAdvisory.js'
import { mountCategoriesRoutes } from './src/server-routes/categories.js'
import { mountCategoryTreeRoutes } from './src/server-routes/categoryTree.js'
import { mountCampaignSegmentExpansionRoutes } from './src/server-routes/campaignSegmentExpansion.js'
import { mountDiagnosticsRoutes } from './src/server-routes/diagnostics.js'
import { mountDedupGuardRoutes } from './src/server-routes/dedupGuard.js'
import { mountCrmRoutes } from './src/server-routes/crm.js'
import { mountAttachmentsRoutes } from './src/server-routes/attachments.js'
import { mountReplyMultipartRoutes } from './src/server-routes/replyMultipart.js'
import { mountReplyForwardRoutes } from './src/server-routes/replyForward.js'
import { mountMessageAttachmentsRoutes } from './src/server-routes/messageAttachments.js'
import { mountMailboxBounceStatsRoutes } from './src/server-routes/mailboxBounceStats.js'
import { mountMailboxBounceWarningsRoutes } from './src/server-routes/mailboxBounceWarnings.js'
import { mountMailboxSpamComplaintStatsRoutes } from './src/server-routes/mailboxSpamComplaintStats.js'
import { mountMailboxDeliveryTimeStatsRoutes } from './src/server-routes/mailboxDeliveryTimeStats.js'
import { mountMailboxBlacklistAlertsRoutes } from './src/server-routes/mailboxBlacklistAlerts.js'
import { mountNotificationsRoutes } from './src/server-routes/notifications.js'
import { mountMailboxReputationScoreRoutes } from './src/server-routes/mailboxReputationScore.js'
import { mountMailboxReputationHistoryRoutes } from './src/server-routes/mailboxReputationHistory.js'
import { mountAlertStreamRoutes } from './src/server-routes/alertStream.js'
import { mountDnsAuditRoutes } from './src/server-routes/dnsAudit.js'
import { mountSegmentPreviewRoutes } from './src/server-routes/segmentPreview.js'
import { mountTemplateMetricsRoutes } from './src/server-routes/templateMetrics.js'
import { mountOperatorSettingsRoutes } from './src/server-routes/operatorSettings.js'
import { mountHighRiskDomainsRoutes } from './src/server-routes/highRiskDomains.js'
import { mountICPSectorsRoutes } from './src/server-routes/icpSectors.js'
import { mountContactVerifyCron } from './src/server-routes/contactVerifyCron.js'
import { mountVerifyLoopRoutes } from './src/server-routes/verifyLoop.js'
import { mountMailboxRepinRoute } from './src/server-routes/mailboxesRepin.js'
import { mountTodayUsageRoute } from './src/server-routes/todayUsage.js'
import { runBounceRateMonitorCron, mountBounceRateMonitor } from './src/server-routes/bounceRateMonitor.js'
import { runEgressChaosDetectionCron } from './src/server-routes/egressChaosDetection.js'
import { mountMailboxEgressHistoryRoute } from './src/server-routes/mailboxEgressHistory.js'
import { runPoolCapacityCron, mountPoolCapacityRoutes } from './src/server-routes/poolCapacityMonitor.js'
import { mountRelayPoolCapacityRoute } from './src/server-routes/relayPoolCapacity.js'
import { mountRelayQueueDepthRoute } from './src/server-routes/relayQueueDepth.js'
// AW8-3 — dashboard cycle 3: surface backend hardening events + failed-send triage + key rotation log.
import { mountAuditRecentRoute } from './src/server-routes/auditRecent.js'
import { mountFailedSendsRoutes } from './src/server-routes/failedSends.js'
import { mountCampaignTimelineRoutes } from './src/server-routes/campaignTimeline.js'
import { mountOperatorRotateApiKeyRoutes } from './src/server-routes/operatorRotateApiKey.js'
import { runMullvadEndpointReputationCron, mountEndpointHealthRoute } from './src/server-routes/endpointHealth.js'
// E1 — cron modules (Sprint E1: extracted from server.js inline bodies)
import { runGreylistRetryCron as _runGreylistRetryCron } from './src/crons/runGreylistRetryCron.js'
import { runScoringRecomputeCron as _runScoringRecomputeCron } from './src/crons/runScoringRecomputeCron.js'
import { runStaleHealthCheckCron as _runStaleHealthCheckCron } from './src/crons/runStaleHealthCheckCron.js'
import { runOutboundReplyCron as _runOutboundReplyCron } from './src/crons/runOutboundReplyCron.js'
import { runImapPollCron as _runImapPollCron } from './src/crons/runImapPollCron.js'
import { runWarmupAdvanceCron as _runWarmupAdvanceCron } from './src/crons/runWarmupAdvanceCron.js'
import { runDailyReportCron as _runDailyReportCron } from './src/crons/runDailyReportCron.js'
import { runMailboxHealthCycleCron as _runMailboxHealthCycleCron } from './src/crons/runMailboxHealthCycleCron.js'
import { runCampaignWatchdogCron as _runCampaignWatchdogCron } from './src/crons/runCampaignWatchdogCron.js'
import { runBounceFlipCron as _runBounceFlipCron } from './src/crons/runBounceFlipCron.js'
import { runMailboxBounceThrottleCron as _runMailboxBounceThrottleCron } from './src/crons/runMailboxBounceThrottleCron.js'
import { runBounceAnomalyCron as _runBounceAnomalyCron } from './src/crons/runBounceAnomalyCron.js'
// AV-F9 — Reclaim zombie in_flight campaign_contacts (sender daemon crash safety net).
import {
  runCampaignContactsStaleReclaim as _runCampaignContactsStaleReclaim,
  RECLAIM_CRON_INTERVAL_MS,
} from './src/crons/runCampaignContactsStaleReclaim.js'
import { runMailboxHealingCron as _runMailboxHealingCron } from './src/crons/runMailboxHealingCron.js'
// Auto-capture vehicles named in incoming replies → vehicles inventory (linked to contact/company/crm).
import {
  runVehicleAutoCaptureCron as _runVehicleAutoCaptureCron,
  AUTO_CAPTURE_INTERVAL_MS,
} from './src/crons/runVehicleAutoCaptureCron.js'
import { runEmailReverifyCron as _runEmailReverifyCron } from './src/crons/runEmailReverifyCron.js'
import { runContactStaleReverifyCron as _runContactStaleReverifyCron, CONTACT_REVERIFY_INTERVAL_DAYS, CONTACT_REVERIFY_BATCH_SIZE, CONTACT_REVERIFY_JITTER_S } from './src/crons/runContactStaleReverifyCron.js'
import { runAdaptiveRefreshCron as _runAdaptiveRefreshCron } from './src/crons/runAdaptiveRefreshCron.js'
import { runEnrichmentMVRefreshCron as _runEnrichmentMVRefreshCron } from './src/crons/runEnrichmentMVRefreshCron.js'
import { runAuditLogRetentionCron as _runAuditLogRetentionCron } from './src/crons/runAuditLogRetentionCron.js'
import { runCrmBackfillCron as _runCrmBackfillCron } from './src/crons/runCrmBackfillCron.js'
import { runBlacklistCheckCron as _runBlacklistCheckCron } from './src/crons/runBlacklistCheckCron.js'
import { runHumanBehaviorSimulationCron as _runHumanBehaviorSimulationCron } from './src/crons/runHumanBehaviorSimulationCron.js'
import { runFullInboxScanCron as _runFullInboxScanCron } from './src/crons/runFullInboxScanCron.js'
import { runImapIdleKeepAliveCron as _runImapIdleKeepAliveCron } from './src/crons/runImapIdleKeepAliveCron.js'
import { runFolderOperationsCron as _runFolderOperationsCron } from './src/crons/runFolderOperationsCron.js'
import { runImapInboxAuditCron as _runImapInboxAuditCron } from './src/crons/runImapInboxAuditCron.js'
// AV-F5-A (2026-05-19) — prospect scoring cron + route surface.
import {
  runProspectScoringCron as _runProspectScoringCron,
  PROSPECT_SCORE_CRON_INTERVAL_MS,
} from './src/crons/runProspectScoringCron.js'
import { mountProspectsRoutes } from './src/server-routes/prospects.js'
// 2026-06-26 — machinery-priority sync cron (drift guard for migration 178).
import {
  runCampaignContactPriorityCron as _runCampaignContactPriorityCron,
  PRIORITY_SYNC_CRON_INTERVAL_MS,
} from './src/crons/runCampaignContactPriorityCron.js'
import {
  getRelayBase,
  relaySmtpCheck,
  relaySmtpAuthProbe,
  relaySocks5Probe,
  relayProxyPool,
  relayImapSocksAddr,
  relayImapFetch,
} from './src/lib/relayClient.js'
import { analyzeAnonymity } from './src/lib/anonymityAnalyzer.js'
import { checkAndRecord as checkOpRateLimit } from './src/lib/mailboxOpRateLimit.js'
import { recordAuthFail } from './src/lib/mailboxAuthFailGuard.js'
import { checkBlacklist } from './src/lib/blacklistCheck.js'
import { classifyReplyBody } from './src/lib/replyClassifier.js'
import { semanticClassifyReply } from './src/lib/llmReplyClassifier.js'
import { aggregatePlacementStats } from './src/lib/inboxSpamDetector.js'
import { diffManifests, quickCheck as schemaQuickCheck } from './src/lib/schema-diff.js'
// FUN-1.4 — funnel summary endpoint.
import { mountFunnelSummaryRoute } from './src/server-routes/funnelSummary.js'
import { mountScrapersRoutes } from './src/server-routes/scrapers.js'

const IS_PROD = process.env.NODE_ENV === 'production'
function safeError(e) {
  if (!IS_PROD) return e?.message || 'internal error'
  const msg = e?.message || ''
  if (/not found|already exists|invalid|required|missing/i.test(msg)) return msg
  return 'internal error'
}

try {
  readFileSync(new URL('.env', import.meta.url), 'utf8')
    .split('\n').forEach(l => { const [k,...v]=l.split('='); if(k&&v.length) process.env[k.trim()]=v.join('=').trim() })
} catch {}

// AT-F1 — pg pool resilience. `keepAlive` enables TCP keepalive on every
// pooled connection so the OS sends probes before the proxy (Railway's
// junction.proxy.rlwy.net, ~10 min idle timeout) silently drops the socket
// and `pg` emits an unhandled ETIMEDOUT on the next checkout. The 30s
// initial delay is well under the proxy idle window. Named here per
// feedback_no_magic_thresholds (T0) so the operator can find + tune it.
const PG_KEEPALIVE_INITIAL_DELAY_MS = 30_000
// PG_POOL_MAX: sized for concurrent load — iter56 monkey harness demonstrated
// that 10 connections exhausted under rapid SPA nav (4 routes/s × 4 concurrent
// endpoints per route = up to 16 simultaneous in-flight queries). 20 gives
// headroom without over-committing to Railway Postgres connection limits.
// feedback_no_magic_thresholds T0 — operator can tune via PG_POOL_MAX env.
const PG_POOL_MAX = Number(process.env.PG_POOL_MAX) || 20
const pool = wrapPoolWithBreadcrumbs(new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: PG_POOL_MAX,
  keepAlive: true,
  keepAliveInitialDelayMillis: PG_KEEPALIVE_INITIAL_DELAY_MS,
}))

// ZOMBIE-POOL GUARD (2026-05-28)
// Tracks whether pool.end() has been called. Set by the shutdown handler
// before it calls pool.end(). Read by timed() and watchdogFromBFF to detect
// the "process alive but pool dead" zombie state and crash fast with a clear
// fatal banner rather than silently serving stale data for hours.
//
// This is a module-level let so it survives across the entire process lifetime
// and can be read from closures that close over it (timed, watchdogFromBFF).
let _poolEnded = false

// Called only from the shutdown handler. Marks the pool as ended so any
// subsequent cron tick or heartbeat that fires before the process actually
// exits will self-terminate instead of emitting "Cannot use a pool after
// calling end on the pool" indefinitely.
function markPoolEnded() {
  _poolEnded = true
}

// Called at the start of every cron tick (via timed()) and by watchdogFromBFF.
// If the pool was ended without the process exiting, the BFF is in a zombie
// state: it appears alive but can serve no real data. Crash hard so the
// operator / launchd / node --watch can restart cleanly.
function assertPoolAlive(callerLabel) {
  if (_poolEnded) {
    console.error(
      `[FATAL] ${callerLabel}: pool.end() was called but the process did not exit — ` +
      'zombie BFF detected. Exiting now so the process can be restarted by the supervisor.',
    )
    process.exit(1)
  }
}

// AT-F1 — `pg` emits an `error` event on the Pool for idle-client failures
// (ETIMEDOUT / ECONNRESET when a network blip closes a pooled connection).
// Without a listener, Node escalates to an unhandled rejection and the BFF
// process exits — and `node --watch` does NOT auto-restart on crash, it
// only restarts on file change, so the dashboard sits dead until the
// operator notices and restarts manually. Log + continue; the pool will
// replace the dead client on the next checkout. Sentry capture is
// best-effort and must never throw out of this handler.
pool.on('error', (err) => {
  const code = err?.code || 'UNKNOWN'
  const message = err?.message || String(err)
  console.error(`[pg-pool] error code=${code} message=${message}`)
  try {
    if (typeof Sentry?.captureException === 'function') {
      Sentry.captureException(err, { tags: { source: 'pg-pool' } })
    }
  } catch { /* telemetry must not crash the handler */ }
})

// AT-F1 — log-and-continue on uncaught process events. Without these, a
// stray rejection from any /api handler (or a third-party module that
// throws asynchronously) crashes the BFF and `node --watch` waits idle
// for a file change instead of auto-restarting. We let the process keep
// serving; the offending request fails (5xx) but the rest of the
// dashboard stays up. NOTE: sentry.server.js already attaches similar
// handlers, but ONLY when SENTRY_DSN_BFF is set — locally the operator
// runs without DSN, so without these unconditional handlers the process
// dies. Both can coexist (Node fans events out to all listeners).
process.on('uncaughtException', (err) => {
  const code = err?.code || 'UNKNOWN'
  console.error(`[bff:uncaughtException] code=${code} message=${err?.message || err}`)
  try {
    if (typeof Sentry?.captureException === 'function') {
      Sentry.captureException(err, { tags: { source: 'uncaughtException' } })
    }
  } catch { /* noop */ }
})

process.on('unhandledRejection', (reason) => {
  const code = reason?.code || 'UNKNOWN'
  console.error(`[bff:unhandledRejection] code=${code} message=${reason?.message || reason}`)
  try {
    if (typeof Sentry?.captureException === 'function') {
      const err = reason instanceof Error ? reason : new Error(String(reason))
      Sentry.captureException(err, { tags: { source: 'unhandledRejection' } })
    }
  } catch { /* noop */ }
})
const app = express()
app.disable('x-powered-by')

// F1-2 B3 — trust the first proxy hop so `req.ip` resolves to the real
// client IP (Railway / Cloudflare set X-Forwarded-For). Without this,
// `req.ip` returns the edge-proxy IP for every request, so every
// unsubscribe / public click shares one rate-limit bucket. Override via
// `TRUST_PROXY` env (e.g. '2' for two proxy hops, 'loopback' for tests).
const TRUST_PROXY_ENV = process.env.TRUST_PROXY
const trustProxy = TRUST_PROXY_ENV === undefined ? 1 : (
  /^\d+$/.test(TRUST_PROXY_ENV) ? Number(TRUST_PROXY_ENV) : TRUST_PROXY_ENV
)
app.set('trust proxy', trustProxy)

// S-H3 — Content Security Policy.
// STRICT_HTML_CSP: pro /unsubscribe a /privacy — žádné skripty, jen inline style.
// SPA_CSP: v production (Firebase) BFF servuje SPA — povolíme skripty, fonty, Sentry.
const STRICT_HTML_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ')

const SPA_CSP = [
  "default-src 'self'",
  // 'unsafe-inline' pro Vite inline theme-detection script v index.html
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  // Sentry DSN ingestion + Firebase Auth REST API
  "connect-src 'self' https://*.ingest.sentry.io https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com https://taher-ui-client.firebaseapp.com",
  "img-src 'self' data: blob:",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ')

// Security response headers — v production (SPA mode) použijeme SPA_CSP,
// jinak STRICT_HTML_CSP (local dev: BFF servuje jen API + unsubscribe).
const ACTIVE_CSP = process.env.NODE_ENV === 'production' ? SPA_CSP : STRICT_HTML_CSP

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  // HSTS only meaningful over HTTPS. Browsers ignore on http://localhost.
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  res.setHeader('Content-Security-Policy', ACTIVE_CSP)
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  next()
})

// CORS: allow only the configured frontend origin (falls back to localhost
// Vite dev port). Accepting comma-separated list for multi-env setups.
const CORS_ALLOWED = (process.env.CORS_ORIGIN || 'http://localhost:18180')
  .split(',').map(s => s.trim()).filter(Boolean)
app.use(cors({
  origin(origin, cb) {
    // same-origin / curl / server-to-server: no Origin header
    if (!origin) return cb(null, true)
    if (CORS_ALLOWED.includes(origin)) return cb(null, true)
    return cb(null, false)
  },
  credentials: true,
  allowedHeaders: ['Content-Type', 'X-API-Key', 'Idempotency-Key', 'X-Query-Probe', 'X-Fault'],
}))
// Body-size cap: JSON POST bodies are dashboard config / templates / small
// CSV imports — 1 MB is comfortably above normal traffic and blocks trivial
// abuse without extra dependencies.
app.use(sentryTagMiddleware)
app.use(express.json({ limit: '1mb' }))

// File upload support for XLSX imports (CRM-7)
// S-U1 — abortOnLimit: true causes express-fileupload to reject oversized
// uploads with 413 instead of silently truncating to the limit. Without
// this flag an attacker can upload an arbitrarily large file; the server
// streams the entire body before cutting it, enabling memory pressure and
// partial-parse surprises in ExcelJS. useTempFiles: false keeps files
// in-memory (no disk leakage); createParentPath: false avoids any fs
// traversal side-effects.
import fileUpload from 'express-fileupload'
app.use(fileUpload({
  limits: { fileSize: 10 * 1024 * 1024 },
  abortOnLimit: true,
  useTempFiles: false,
  createParentPath: false,
}))

// L1 — Endpoint coverage instrumentation. Logs every /api/* hit to
// endpoint_hits buffer (flushed every 60s to DB). Powers L2 coverage report.
const ENDPOINT_HITS_BUFFER = new Map()  // route → count
function endpointKey(method, path) {
  // Normalize :id paths so /api/templates/123 + /api/templates/456 share key
  const normalized = path
    .replace(/\/\d+\b/g, '/:id')
    .split('?')[0]
  return `${method} ${normalized}`
}
app.use((req, res, next) => {
  if (req.path.startsWith('/api/') && process.env.SKIP_ENDPOINT_INSTRUMENTATION !== '1') {
    const key = endpointKey(req.method, req.path)
    ENDPOINT_HITS_BUFFER.set(key, (ENDPOINT_HITS_BUFFER.get(key) || 0) + 1)
  }
  next()
})
// Flush buffer every 60s — best-effort
setInterval(async () => {
  if (ENDPOINT_HITS_BUFFER.size === 0) return
  const snapshot = [...ENDPOINT_HITS_BUFFER.entries()]
  ENDPOINT_HITS_BUFFER.clear()
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS endpoint_hits (
      route TEXT NOT NULL,
      hits BIGINT NOT NULL DEFAULT 0,
      window_start TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (route, window_start)
    )`)
    const ts = new Date().toISOString()
    for (const [route, hits] of snapshot) {
      await pool.query(
        `INSERT INTO endpoint_hits(route, hits, window_start) VALUES($1, $2, $3)
         ON CONFLICT (route, window_start) DO UPDATE SET hits = endpoint_hits.hits + EXCLUDED.hits`,
        [route, hits, ts]
      ).catch(() => {})
    }
  } catch (e) {
    // pool may not be ready at boot; swallow
  }
}, 60_000).unref()

// S-H1 — strict DSN parser for /sentry-tunnel. The previous shape used
// `dsn.includes('@sentry.io')` which is bypassable via a host like
// `sentry.io.evil.tld`, plus `dsn.split('/').at(-1)` which interpolated
// arbitrary path segments into the upstream URL — open-path SSRF onto
// any sentry.io/api/* endpoint. Returns null on any rejection so callers
// fail closed.
function parseSentryDSN(dsn) {
  if (typeof dsn !== 'string' || dsn === '') return null
  let url
  try { url = new URL(dsn) } catch { return null }
  if (url.protocol !== 'https:') return null
  const host = url.hostname.toLowerCase()
  // Sentry SaaS hosts: exact `sentry.io` (legacy) and `*.ingest.sentry.io`
  // (org-scoped subdomains used by current SDKs). Reject anything else
  // — including substring tricks like `sentry.io.evil.tld`.
  const okHost = host === 'sentry.io' || host.endsWith('.ingest.sentry.io')
  if (!okHost) return null
  // Path must be a single segment of digits — the projectId.
  const segs = url.pathname.split('/').filter(Boolean)
  if (segs.length !== 1) return null
  if (!/^\d+$/.test(segs[0])) return null
  return { host, projectId: segs[0] }
}

// Sentry tunnel — proxies browser Sentry events through BFF so ad-blockers
// can't intercept them. Only forwards to sentry.io; any other host is rejected.
// Only active when SENTRY_DSN_BFF is configured.
if (process.env.SENTRY_DSN_BFF) {
  app.post('/sentry-tunnel', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
    try {
      const envelope = req.body.toString('utf8')
      const header = JSON.parse(envelope.split('\n')[0])
      const parsed = parseSentryDSN(header?.dsn)
      if (!parsed) {
        return res.status(400).json({ error: 'invalid dsn' })
      }
      const sentryUrl = `https://${parsed.host}/api/${parsed.projectId}/envelope/`
      const upstream = await fetch(sentryUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-sentry-envelope' },
        body: req.body,
      })
      res.status(upstream.status).end()
    } catch (e) {
      res.status(200).end() // never block on Sentry tunnel failure
    }
  })
}
// Override SPA_CSP → STRICT_HTML_CSP pro /privacy (plain HTML, žádné skripty)
app.use('/privacy', (_req, res, next) => {
  res.setHeader('Content-Security-Policy', STRICT_HTML_CSP)
  next()
})
// Public privacy notice — extracted to src/server-routes/privacy.js (T3.2).
// Mounted below alongside other route modules. The route MUST stay public.
mountPrivacyRoutes(app, { pool })

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid json' })
  }
  next(err)
})

// Per-request query counter (test/diagnostic only). Enabled when client sends
// X-Query-Probe: 1. Wraps pool.query via AsyncLocalStorage so concurrent reqs
// don't cross-count. Returns X-Query-Count response header. Catches N+1.
const queryStore = new AsyncLocalStorage()
const __origQuery = pool.query.bind(pool)
pool.query = (...args) => {
  const ctx = queryStore.getStore()
  if (ctx) ctx.count++
  return __origQuery(...args)
}
app.use((req, res, next) => {
  if (req.headers['x-query-probe'] !== '1') return next()
  const ctx = { count: 0 }
  const stamp = () => { if (!res.headersSent) res.setHeader('X-Query-Count', String(ctx.count)) }
  const _json = res.json.bind(res)
  const _end = res.end.bind(res)
  res.json = (b) => { stamp(); return _json(b) }
  res.end = (...a) => { stamp(); return _end(...a) }
  queryStore.run(ctx, next)
})

// Fault injection (test-only). Honors X-Fault: db-down|latency|throw|truncate
// when env FAULT_INJECT_ALLOWED=1. Disabled in production by default.
if (process.env.FAULT_INJECT_ALLOWED === '1') {
  app.use(async (req, res, next) => {
    const f = req.headers['x-fault']
    if (!f) return next()
    if (f === 'db-down') return res.status(503).json({ error: 'database unavailable' })
    if (f === 'latency') { await new Promise(r => setTimeout(r, 1500)); return next() }
    if (f === 'throw')   { return res.status(500).json({ error: 'internal error' }) }
    if (f === 'truncate') {
      const _json = res.json.bind(res)
      res.json = (b) => _json(Array.isArray(b) ? b.slice(0, 1) : (b?.rows ? { ...b, rows: b.rows.slice(0, 1) } : b))
    }
    next()
  })
}

// Idempotency-Key middleware (POST/PUT/PATCH only). Cached 10min in-memory.
// Honors per-method+path+key tuple → handler runs once, replays return same body.
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000
const idempotency = new Map()
function gcIdempotency() {
  const now = Date.now()
  for (const [k, v] of idempotency) if (v.expiresAt < now) idempotency.delete(k)
}
app.use((req, res, next) => {
  const key = req.headers['idempotency-key']
  if (!key || !['POST', 'PUT', 'PATCH'].includes(req.method)) return next()
  gcIdempotency()
  const cacheKey = `${req.method} ${req.path} ${key}`
  const hit = idempotency.get(cacheKey)
  if (hit) {
    res.setHeader('Idempotent-Replay', '1')
    return res.status(hit.status).json(hit.body)
  }
  const _json = res.json.bind(res)
  res.json = (body) => {
    idempotency.set(cacheKey, { status: res.statusCode || 200, body, expiresAt: Date.now() + IDEMPOTENCY_TTL_MS })
    return _json(body)
  }
  next()
})

// ── Auth + Rate limit ──────────────────────────────────────────────
app.use(createRateLimitMiddleware())
// AW-F1 (2026-05-20): HTTP Basic Auth gate for the whole dashboard,
// single account, bcrypt-hashed, opt-in via DASHBOARD_AUTH_ENABLED=true.
// Default disabled → zero behavioral change. Mounts BEFORE the X-API-Key
// middleware so unauthenticated browsers see the Basic challenge first
// (X-API-Key is for machine callers / SSE fallback and stays additive).
// BFF_AUTH_DISABLED=1 and the health/sentry bypass list keep the
// existing test + monitoring surfaces working.
app.use(requireDashboardAuth)
app.use(createAuthMiddleware())

// ── Public unsubscribe (token-gated, no API key) ───────────────────
// Extracted into src/server-routes/unsubscribe.js (T3.1 v3, 2026-05-01).
// Behavior preserved verbatim: same HMAC verify (PR #408 const-time
// crypto.timingSafeEqual), same SQL writes to suppression_list +
// outreach_suppressions + contacts + operator_audit_log, same 10/min/IP
// rate-limit semantics, same Czech HTML response page. Audit test
// `tests/audit/gdpr-cascade-shape.test.js` scans BOTH server.js + the
// route module via multi-file lookup (PR #443). Contract test
// `tests/contract/bff-unsubscribe.contract.test.ts` verifies the
// HTTP-level shape end-to-end.
// Override SPA_CSP → STRICT_HTML_CSP pro /unsubscribe (žádné skripty, plain HTML)
app.use('/unsubscribe', (_req, res, next) => {
  res.setHeader('Content-Security-Policy', STRICT_HTML_CSP)
  next()
})
mountUnsubscribeRoutes(app, { pool, capture500, safeError, Sentry })

// ── GDPR data subject requests (Art. 15 access, Art. 17 erasure) ───
// Extracted into src/server-routes/dsr.js per ADR-008 (T2.6 v3, 2026-05-01).
// Behavior preserved verbatim — same SQL, same response shape, same
// rate-limit semantics. Audit test `tests/audit/gdpr-cascade-shape.test.js`
// scans BOTH server.js + the route module via multi-file lookup (PR #443).
mountDsrRoutes(app, { pool, setRouteTags, capture500, safeError })

// /api/morning-readiness removed (iter-sweep2, 2026-05-30) along with the
// /priprava page — readiness was an advisory mirror of the launch preflight
// (runPreflight.js), which still enforces the same mailbox/template/segment
// checks at campaign send.

// ── Dashboard summary (Sprint Y10) — single aggregate endpoint for `/`
// Home overview: campaign 457 status + replies preview + mailbox health
// + critical notifications + 24h metrics strip. One fetch backs the
// landing page so morning glance renders fast.
mountDashboardSummaryRoutes(app, { pool, capture500, safeError })

// ── Anonymity diagnostics — S5 operator UI ───────────────────────────────
// Aggregate per-mailbox anonymity + human-likeness scores from
// anonymity_test_messages (migrations 022–024). Backs /diagnostika/anonymita.
mountAnonymityRoutes(app, { pool, capture500, safeError })
mountBulkPasswordRoute(app, { pool, capture500, safeError })
mountTemplatePreviewRoute(app, { capture500, safeError })

// ── Operator metrics — OP5.3 hourly snapshot (campaign + mailbox + classifier)
// Proxies to Go orchestrator's in-memory snapshot; falls back to direct-DB
// reduced snapshot when Go is unreachable.
mountOperatorMetricsRoutes(app, { pool, capture500, safeError })

// ── Companies (list, detail, score-trends, stats, autocomplete, facets,
//    verify-email, scoring, EV/DQ/readiness, lookalike, facts) ────────
// T3.7 (2026-05-01) + D2.2 (2026-05-03): all 18 /api/companies/* handlers
// live in ./src/server-routes/companies.js per ADR-008 D2 module sequence.
// Behavior is byte-equivalent to the inline declarations they replaced —
// same SQL, response shape, Sentry capture, and route ordering. Helpers
// that are also called from non-companies code paths (dual-axis ranking,
// scoring/preview, contacts verify, mailbox greylist cron, full-check cron)
// stay inline below and are passed in via deps so call-sites elsewhere
// keep their existing live binding.
mountCompaniesRoutes(app, {
  pool,
  setRouteTags,
  capture500,
  safeError,
  runVerifyAndPersist,
  loadSectorEngagementPriors,
  priorsForSector,
  recomputeScoreForIco,
  computeEngagementForCompany,
  computeExpectedValueScore,
  computeDataQuality,
  computeReadiness,
  loadLookalikeCentroid,
  lookalikeScore,
  enrichmentPersistFacts,
})

// D2.5 (2026-05-02): /api/scoring/* + /api/dual-axis + /api/lookalike/centroid
// extracted into ./src/server-routes/scoring.js per ADR-008 D2 module sequence.
// Helpers (DEFAULT_WEIGHTS, getScoringWeights, recomputeScoreForIco,
// computeEngagementForCompanies, loadSectorEngagementPriors, priorsForSector,
// computeExpectedValueScore, computeReadiness, loadLookalikeCentroid,
// computeCompositeScore, extractFeatures, trainLogistic,
// suggestScoringWeights, SCORE_LEARNER_LIMITS) stay inline below because
// non-scoring code paths (companies routes, full-check + scoring crons)
// also call them.
mountScoringRoutes(app, {
  pool,
  setRouteTags,
  capture500,
  safeError,
  DEFAULT_WEIGHTS,
  getScoringWeights,
  recomputeScoreForIco,
  computeEngagementForCompanies,
  loadSectorEngagementPriors,
  priorsForSector,
  computeExpectedValueScore,
  computeReadiness,
  loadLookalikeCentroid,
  computeCompositeScore,
  extractFeatures,
  trainLogistic,
  suggestScoringWeights,
  SCORE_LEARNER_LIMITS,
})

// ── Email verification ─────────────────────────────────────────────
// Helpers stay here because they are also used by /api/contacts/:id verify
// and the full-check / greylist crons. The /api/companies/* endpoints that
// consume these helpers live in src/server-routes/companies.js (D2.2).
const DOMAIN_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
const _domainProbeLock = new Map() // domain → last probe ts (rate limit 5s/domain)
const DOMAIN_RATE_MS = 5_000

const domainCache = {
  async get(domain) {
    const { rows } = await pool.query(
      `SELECT mx_exists, mx_host, is_catch_all, is_disposable, smtp_connectable, checked_at
       FROM email_domains WHERE domain=$1`, [domain]
    )
    if (!rows.length) return null
    const r = rows[0]
    if (Date.now() - new Date(r.checked_at).getTime() > DOMAIN_CACHE_TTL_MS) return null
    return r
  },
  async set(domain, rec) {
    await pool.query(
      `INSERT INTO email_domains(domain, mx_exists, mx_host, is_catch_all, is_disposable, smtp_connectable)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT (domain) DO UPDATE SET
         mx_exists=EXCLUDED.mx_exists,
         mx_host=EXCLUDED.mx_host,
         is_catch_all=COALESCE(EXCLUDED.is_catch_all, email_domains.is_catch_all),
         is_disposable=EXCLUDED.is_disposable,
         smtp_connectable=EXCLUDED.smtp_connectable,
         checked_at=now()`,
      [domain, rec.mx_exists ?? null, rec.mx_host ?? null, rec.is_catch_all ?? null,
       rec.is_disposable ?? null, rec.smtp_connectable ?? null]
    )
  },
}

const GREYLIST_MAX_ATTEMPTS = 3
const GREYLIST_RETRY_MS     = 10 * 60 * 1000

async function enqueueGreylistRetry(ico, email, result) {
  // Tempfail = mx exists, syntax ok, but smtp_valid couldn't conclude.
  const isTempfail = result?.syntax_valid && result?.mx_exists && result?.smtp_valid == null
  if (!isTempfail) {
    // Final result — clean any pending retry entry.
    await pool.query(`DELETE FROM email_verify_queue WHERE ico=$1 AND LOWER(email)=LOWER($2)`, [ico, email])
      .catch(() => {})
    return
  }
  await pool.query(
    `INSERT INTO email_verify_queue(ico, email, retry_at, attempts, last_response)
     VALUES($1, $2, now() + interval '10 minutes', 1, $3)
     ON CONFLICT(ico, email) DO UPDATE
       SET retry_at = now() + interval '10 minutes',
           attempts = email_verify_queue.attempts + 1,
           last_response = EXCLUDED.last_response`,
    [ico, email, result?.smtp_response ?? null]
  ).catch(() => {})
}

// E1: body extracted to src/crons/runGreylistRetryCron.js
function runGreylistRetryCron() {
  return _runGreylistRetryCron(pool, { runVerifyAndPersist, evaluateGreylistQueueItem, evaluateMailboxGreylistResult, isGreylisted, GREYLIST_MAX_ATTEMPTS })
}

async function runVerifyAndPersist(ico, email, trigger = 'manual') {
  const last = _domainProbeLock.get(email.split('@')[1]?.toLowerCase() ?? '')
  const domain = email.split('@')[1]?.toLowerCase() ?? ''
  if (last && Date.now() - last < DOMAIN_RATE_MS) {
    await new Promise(r => setTimeout(r, DOMAIN_RATE_MS - (Date.now() - last)))
  }
  _domainProbeLock.set(domain, Date.now())

  const result = await verifyEmail(email, {
    enableSMTP: process.env.EMAIL_VERIFY_SMTP !== '0',
    domainCache,
    fromAddr: process.env.EMAIL_VERIFY_FROM || 'probe@example.com',
  })

  const { rows: [prev] } = await pool.query(
    `SELECT email_status FROM companies WHERE ico=$1`, [ico]
  ).catch(() => ({ rows: [{}] }))
  const oldStatus = prev?.email_status ?? null

  await pool.query(
    `UPDATE companies
     SET email_status=$1, email_verified_at=now(), email_verification=$2, email_confidence=$3
     WHERE ico=$4`,
    [result.status, JSON.stringify(result), result.confidence ?? null, ico]
  )
  await pool.query(
    `INSERT INTO email_verification_log(company_ico, email, old_status, new_status, detail, trigger, verification)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [ico, email, oldStatus, result.status, result.detail, trigger, JSON.stringify(result)]
  ).catch(() => {})

  // Greylist queue management: enqueue tempfail, clear on conclusive result.
  if (trigger !== 'greylist_retry' || result?.smtp_valid != null) {
    await enqueueGreylistRetry(ico, email, result)
  } else {
    // Re-attempt from greylist cron and still tempfail — bump retry_at + attempts via INSERT…ON CONFLICT.
    await enqueueGreylistRetry(ico, email, result)
  }

  return result
}

// /api/companies/:ico/verify-email, /api/companies/bulk-verify-email,
// /api/companies/:ico/verification-history — moved to mountCompaniesRoutes.

// ── Sophisticated scoring ──────────────────────────────────────────
async function getScoringWeights() {
  try {
    const { rows } = await pool.query(`SELECT weights FROM scoring_config WHERE id=1`)
    return { ...DEFAULT_WEIGHTS, ...(rows[0]?.weights || {}) }
  } catch { return DEFAULT_WEIGHTS }
}

function engagementFromAggRow(r) {
  const recent_60d_count = Number(r?.sent_60d) || 0
  const sent = Number(r?.sent) || 0
  if (!sent) return { engagement_score: 0, recent_60d_count }
  const replyBoost = 1.0 * (Number(r.replied) / sent)
  const openBoost  = 0.3 * Math.min(Number(r.opened) / sent, 1)
  const bouncePen  = 0.5 * (Number(r.bounced) / sent)
  const engagement_score = Math.max(0, Math.min(1, replyBoost + openBoost - bouncePen))
  return { engagement_score, recent_60d_count }
}

async function computeEngagementForCompany(companyId) {
  const { rows } = await pool.query(`
    SELECT COUNT(*)::int AS sent,
           COUNT(*) FILTER (WHERE status='replied')::int AS replied,
           COUNT(*) FILTER (WHERE opened_at IS NOT NULL)::int AS opened,
           COUNT(*) FILTER (WHERE status='bounced')::int AS bounced,
           COUNT(*) FILTER (WHERE sent_at > now() - INTERVAL '60 days')::int AS sent_60d
    FROM send_events
    WHERE company_id = $1 AND sent_at > now() - INTERVAL '180 days'
  `, [companyId]).catch(() => ({ rows: [{ sent: 0, sent_60d: 0 }] }))
  return engagementFromAggRow(rows[0] || {})
}

// Batched companion to computeEngagementForCompany: one round-trip for the
// whole id set. Used by handlers that rank a candidate pool (e.g.
// /api/dual-axis with pool=200). Companies absent from send_events still
// get an entry with engagement_score=0 so callers can lookup-or-zero.
async function computeEngagementForCompanies(companyIds) {
  const result = new Map()
  if (!companyIds.length) return result
  const { rows } = await pool.query(`
    SELECT company_id,
           COUNT(*)::int AS sent,
           COUNT(*) FILTER (WHERE status='replied')::int AS replied,
           COUNT(*) FILTER (WHERE opened_at IS NOT NULL)::int AS opened,
           COUNT(*) FILTER (WHERE status='bounced')::int AS bounced,
           COUNT(*) FILTER (WHERE sent_at > now() - INTERVAL '60 days')::int AS sent_60d
      FROM send_events
     WHERE company_id = ANY($1) AND sent_at > now() - INTERVAL '180 days'
     GROUP BY company_id
  `, [companyIds]).catch(() => ({ rows: [] }))
  for (const r of rows) result.set(r.company_id, engagementFromAggRow(r))
  for (const id of companyIds) {
    if (!result.has(id)) result.set(id, { engagement_score: 0, recent_60d_count: 0 })
  }
  return result
}

// Per-sector Bayesian priors for engagement axis. Prevents 1/1 = "100%
// reply rate" overconfidence and lets a sector with naturally lower
// engagement (e.g. heavy industrial) shrink toward its own baseline
// rather than the global one. Min 30 sends per sector to avoid
// prior-of-the-prior noise; sectors below threshold fall back to the
// global ENGAGEMENT_PRIORS.
async function loadSectorEngagementPriors() {
  try {
    const { rows } = await pool.query(`
      SELECT c.sector_primary,
             SUM(CASE WHEN se.status='replied' THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*),0) AS reply_rate,
             SUM(CASE WHEN se.opened_at IS NOT NULL THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*),0) AS open_rate,
             COUNT(*)::int AS n
        FROM send_events se
        JOIN companies c ON c.id = se.company_id
       WHERE se.sent_at > now() - INTERVAL '180 days'
         AND c.sector_primary IS NOT NULL
       GROUP BY c.sector_primary
      HAVING COUNT(*) >= 30
    `)
    const map = new Map()
    for (const r of rows) {
      map.set(r.sector_primary, {
        replyRate: Math.max(0, Math.min(1, Number(r.reply_rate) || 0)),
        openRate:  Math.max(0, Math.min(1, Number(r.open_rate)  || 0)),
      })
    }
    return map
  } catch { return new Map() }
}

function priorsForSector(sectorMap, sectorPrimary) {
  if (!sectorMap || !sectorPrimary) return undefined
  return sectorMap.get(sectorPrimary)
}

async function recomputeScoreForIco(ico, weights = null, sectorPriors = null) {
  const w = weights || await getScoringWeights()
  const { rows: [co] } = await pool.query(`
    SELECT id, ico, icp_tier, email_confidence, sector_confidence, velikost_firmy,
           email, datum_zaniku, v_likvidaci, v_insolvenci, sector_primary,
           total_sent, total_replied, total_opened, total_bounced, last_contacted
    FROM companies WHERE ico=$1
  `, [ico])
  if (!co) return null
  const { engagement_score, recent_60d_count } = await computeEngagementForCompany(co.id)
  const sectorPrior = priorsForSector(sectorPriors, co.sector_primary)
  const opts = sectorPrior ? { engagementPriors: sectorPrior } : {}
  const { score, tier, components } = computeCompositeScore(
    { ...co, engagement_score, recent_60d_count }, w, opts,
  )
  await pool.query(`
    UPDATE companies
       SET composite_score = $1, score_tier = $2, score_components = $3::jsonb,
           engagement_score = $4, scored_at = now()
     WHERE ico = $5
  `, [score, tier, JSON.stringify(components), engagement_score, ico])
  return { ico, score, tier, components, engagement_score }
}

// /api/companies/:ico/recompute-score — moved to mountCompaniesRoutes (D2.2).

// ── Cohort engine — hierarchical priors with sample-size fallback ──
// Cached for 10 min; aggregation over companies × send_events is heavy.
let _cohortCache = { at: 0, byKey: null }
async function getCohortAggregates(maxAgeMs = 10 * 60_000) {
  if (_cohortCache.byKey && Date.now() - _cohortCache.at < maxAgeMs) return _cohortCache.byKey
  const { rows } = await pool.query(`
    SELECT
      COALESCE(NULLIF(c.sector_primary, ''), 'unknown')   AS sector,
      COALESCE(NULLIF(c.velikost_firmy, ''), 'unknown')   AS size,
      COALESCE(NULLIF(c.icp_tier, ''), 'unscored')        AS icp_tier,
      COALESCE(c.total_sent,     0)::int AS sends,
      COALESCE(c.total_replied,  0)::int AS replies,
      COALESCE(c.total_opened,   0)::int AS opens,
      0::int                              AS clicks,
      COALESCE(c.total_bounced,  0)::int AS bounces,
      0::int                              AS conversions
      FROM companies c
     WHERE COALESCE(c.total_sent, 0) > 0
  `)
  const byKey = aggregateCohorts(rows)
  _cohortCache = { at: Date.now(), byKey }
  return byKey
}

app.get('/api/cohorts/lookup', async (req, res) => {
  try {
    const sector   = String(req.query.sector || '').toLowerCase() || 'unknown'
    const size     = String(req.query.size || '').toLowerCase() || 'unknown'
    const icp_tier = String(req.query.icp_tier || '').toLowerCase() || 'unscored'
    const minSample = Math.max(10, Math.min(10_000, Number(req.query.min) || DEFAULT_MIN_SAMPLE))
    const byKey = await getCohortAggregates()
    const r = findCohort({ sector, size, icp_tier }, byKey, minSample)
    if (!r) return res.status(404).json({ error: 'no cohort meets minSample', minSample })
    res.json(r)
  } catch (e) { capture500(res, e, safeError) }
})

// /api/companies/:ico/{expected-value,data-quality,readiness} — moved to
// mountCompaniesRoutes (D2.2). The shared scoring helpers below
// (computeEngagementForCompany, loadSectorEngagementPriors,
// priorsForSector) stay because dual-axis ranking and scoring/preview
// also call them.

// /api/dual-axis — moved to mountScoringRoutes (D2.5).

// Lookalike scoring — caches converter centroid for 30 min, returns similarity
// of a candidate company against the converter feature centroid.
let _lookalikeCentroidCache = null  // { vec, builtAt, n }
const LOOKALIKE_CACHE_MS = 30 * 60 * 1000

async function loadLookalikeCentroid(force = false) {
  if (!force && _lookalikeCentroidCache &&
      Date.now() - _lookalikeCentroidCache.builtAt < LOOKALIKE_CACHE_MS) {
    return _lookalikeCentroidCache
  }
  const { rows: converters } = await pool.query(`
    SELECT id, icp_tier, velikost_firmy, email, website,
           email_confidence, sector_confidence, composite_score, engagement_score
      FROM companies
     WHERE total_replied > 0
     LIMIT 5000
  `)
  if (converters.length === 0) {
    _lookalikeCentroidCache = { vec: null, builtAt: Date.now(), n: 0 }
    return _lookalikeCentroidCache
  }
  const ids = converters.map(c => c.id)
  const { rows: facts } = await pool.query(`
    SELECT company_id, field, value
      FROM company_current_facts
     WHERE company_id = ANY($1)
       AND field IN ('mx_provider','spf','dmarc')
  `, [ids])
  const factsByCo = new Map()
  for (const f of facts) {
    const arr = factsByCo.get(f.company_id) || []
    arr.push({ field: f.field, value: f.value })
    factsByCo.set(f.company_id, arr)
  }
  const vecs = converters.map(c => featureVector(c, factsByCo.get(c.id) || []))
  _lookalikeCentroidCache = { vec: vecCentroid(vecs), builtAt: Date.now(), n: converters.length }
  return _lookalikeCentroidCache
}

// /api/lookalike/centroid — moved to mountScoringRoutes (D2.5).
// loadLookalikeCentroid stays here because mountCompaniesRoutes (deps) and
// mountScoringRoutes (deps) both consume it.

// /api/companies/:ico/lookalike — moved to mountCompaniesRoutes (D2.2).
// loadLookalikeCentroid stays here because /api/lookalike/centroid above
// also calls it.

// G4 (2026-05-03): /api/diagnostics/{segmentation,feature-lift} extracted into
// src/server-routes/diagnostics.js per ADR-008 D2 module sequence. The mount
// call below is co-located with mountCategoriesRoutes() near the rest of the
// G3-era extracts (post-replies). Behavior is byte-equivalent to the prior
// inline declarations.

// On-demand trigger for the adaptive refresh planner. Returns enqueued count.
app.post('/api/enrichment/refresh-plan/run', async (req, res) => {
  try {
    runAdaptiveRefreshCron().catch(e => console.error('[manual] refresh-plan:', e.message))
    res.json({ ok: true, started_at: new Date().toISOString() })
  } catch (e) { capture500(res, e, safeError) }
})

// /api/companies/:ico/facts (POST manual ingest, GET history, GET /current
// MV read) — moved to mountCompaniesRoutes (D2.2).

// /api/scoring/{config,preview} — moved to mountScoringRoutes (D2.5).

const SCORING_BATCH_SIZE = 500
// E1: body extracted to src/crons/runScoringRecomputeCron.js
function runScoringRecomputeCron() {
  return _runScoringRecomputeCron(pool, { getScoringWeights, loadSectorEngagementPriors, recomputeScoreForIco, SCORING_BATCH_SIZE })
}

// /api/scoring/{recompute-all,learn,stats} — moved to mountScoringRoutes (D2.5).

app.get('/api/email-verification/stats', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT email_status, COUNT(*)::int AS cnt
       FROM companies
       WHERE datum_zaniku IS NULL AND email IS NOT NULL
       GROUP BY email_status`
    )
    const out = {}
    for (const r of rows) out[r.email_status ?? 'unverified'] = r.cnt
    const { rows: [stale] } = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM companies
       WHERE email IS NOT NULL
         AND (email_verified_at IS NULL OR email_verified_at < now() - INTERVAL '90 days')`
    )
    res.json({ ...out, stale: stale?.cnt ?? 0 })
  } catch (e) { capture500(res, e, safeError) }
})

// ── Meta (categories) ──────────────────────────────────────────────
// D2.7 (2026-05-02): /api/meta/categories{,/tree,/search,/top} extracted to
// ./src/server-routes/meta.js per ADR-008 D2 module sequence. The two
// route-local in-memory caches (categories tree TTL=90s, search TTL=60s)
// moved with the routes — no other call sites consumed them.
mountMetaRoutes(app, { pool, capture500, safeError })

// ── Segments ───────────────────────────────────────────────────────
// T3.7 (2026-05-01): GET /api/segments + POST /api/segments extracted to
// ./src/server-routes/segments.js per ADR-008 D2. The remaining segment
// endpoints (PATCH /:id, DELETE /:id, /preview, /:id/companies,
// /:id/rebuild) stay inline below — they depend on buildPreviewWhere /
// buildSegmentWhere helpers shared with other surfaces and are out of
// scope for this extraction.
mountSegmentsRoutes(app, { pool, capture500, safeError })
// AV-F5-A (2026-05-19) — GET /api/prospects/top: read-only Top-N over the
// 424k unsent prospect pool, sorted by contacts.prospect_score DESC with
// optional sector + min_score + since_days filters. Feeds F5-B Top
// Prospects page.
mountProspectsRoutes(app, { pool, capture500, safeError })
// K1 — segment builder live count (Sprint K1, #1289).
// GET /api/segments/preview?email_status=...&sectors=...&regions=...&dedup=on
// Returns counts only — PII guard enforced in the route module.
mountSegmentPreviewRoutes(app, { pool, capture500, safeError })
app.patch('/api/segments/:id', async (req, res) => {
  try {
    const { name, description, query } = req.body
    const { rows } = await pool.query(
      `UPDATE segments SET name=COALESCE($1,name), description=COALESCE($2,description),
       query=COALESCE($3,query), updated_at=now() WHERE id=$4
       RETURNING id,name,description,query,company_count,last_built_at,created_at,updated_at`,
      [name||null, description||null, query ? JSON.stringify(query) : null, req.params.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'not found' })
    res.json(rows[0])
  } catch (e) { capture500(res, e, safeError) }
})
app.delete('/api/segments/:id', async (req, res) => {
  try { await pool.query('DELETE FROM segments WHERE id=$1',[req.params.id]); res.json({ok:true}) }
  catch (e) { capture500(res, e, safeError) }
})
app.post('/api/segments/preview', async (req, res) => {
  try {
    const query = req.body?.query || { op: 'AND', conditions: [] }
    const params = []
    const inner = buildPreviewWhere(query, params)
    const where = inner === 'TRUE' ? "exclusion_status = 'pass'" : `exclusion_status = 'pass' AND (${inner})`
    const { rows: [{ count }] } = await pool.query(
      `SELECT COUNT(*) FROM companies WHERE ${where}`, params
    )
    res.json({ count: Number(count) })
  } catch (e) { capture500(res, e, safeError) }
})
// MVP-5 — segment company list. Operator builds a segment via QueryBuilder,
// preview shows count, but until now there was no way to see WHICH companies
// match. Returns up to ?limit=50 (capped at 200) actual rows so operator can
// sanity-check before campaigning.
app.get('/api/segments/:id/companies', async (req, res) => {
  try {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'invalid id' })
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200)
    const { rows: [seg] } = await pool.query(
      `SELECT id, name, query, company_count FROM segments WHERE id=$1`, [req.params.id],
    )
    if (!seg) return res.status(404).json({ error: 'segment not found' })
    // Standalone query (no seg.id prepended) → use buildPreviewWhere which
    // numbers params from $1. buildSegmentWhere assumes $2+ for the rebuild
    // path that prepends seg.id as $1.
    const params = []
    const where = `exclusion_status = 'pass' AND (${buildPreviewWhere(seg.query, params)})`
    const { rows } = await pool.query(
      `SELECT id, ico, name, sector_primary, region_normalized, icp_score, email_status
       FROM companies WHERE ${where}
       ORDER BY icp_score DESC NULLS LAST, id ASC
       LIMIT ${limit}`,
      params,
    )
    res.json({
      ok: true,
      segment_id: seg.id,
      segment_name: seg.name,
      total: seg.company_count ?? null,
      shown: rows.length,
      limit,
      companies: rows,
    })
  } catch (e) { capture500(res, e, safeError) }
})

app.post('/api/segments/:id/rebuild', async (req, res) => {
  try {
    const { rows: [seg] } = await pool.query(
      `SELECT id,query FROM segments WHERE id=$1`, [req.params.id]
    )
    if (!seg) return res.status(404).json({ error: 'not found' })
    const params = []
    const where = `exclusion_status = 'pass' AND (${buildSegmentWhere(seg.query, params)})`
    await pool.query(`DELETE FROM segment_memberships WHERE segment_id=$1`, [seg.id])
    const ins = await pool.query(
      `INSERT INTO segment_memberships(segment_id,company_id) SELECT $1,id FROM companies WHERE ${where}`,
      [seg.id, ...params]
    )
    const n = ins.rowCount || 0
    await pool.query(
      `UPDATE segments SET company_count=$2, last_built_at=now() WHERE id=$1`, [seg.id, n]
    )
    const { rows: [updated] } = await pool.query(
      `SELECT id,name,description,query,company_count,last_built_at,created_at,updated_at FROM segments WHERE id=$1`, [seg.id]
    )
    res.json({ ok: true, companies: n, segment: updated })
  } catch (e) { capture500(res, e, safeError) }
})

const SEGMENT_ALLOWED = ['sector_primary','sector_tags','icp_tier','icp_score',
  'region_normalized','email_status','exclusion_status','engagement_cluster','velikost_firmy',
  'nace_primary']

// Map virtual field names to actual SQL expressions. Most fields map to
// themselves; `nace_primary` exposes nace_codes[1] (the leading code) so
// segments can target a specific NACE without exposing array internals.
const SEGMENT_FIELD_SQL = {
  nace_primary: 'nace_codes[1]',
}
const fieldSql = name => SEGMENT_FIELD_SQL[name] || name

// buildPreviewWhere: params indexed from $1 (for standalone COUNT queries)
function buildPreviewWhere(node, params) {
  const op = (node?.op || '').toUpperCase()
  if (op === 'AND' || op === 'OR') {
    if (!node.conditions?.length) return 'TRUE'
    const parts = node.conditions.map(c => `(${buildPreviewWhere(c, params)})`)
    return parts.join(op === 'AND' ? ' AND ' : ' OR ')
  }
  if (!SEGMENT_ALLOWED.includes(node?.field)) return 'TRUE'
  const col = fieldSql(node.field)
  if (op === 'IN') {
    const vals = [].concat(node.value).filter(Boolean)
    if (!vals.length) return 'FALSE'
    params.push(`{${vals.join(',')}}`)
    return `${col} = ANY($${params.length}::text[])`
  }
  if (op === 'EQ')          { params.push(node.value); return `${col} = $${params.length}` }
  if (op === 'GTE')         { params.push(node.value); return `${col} >= $${params.length}` }
  if (op === 'LTE')         { params.push(node.value); return `${col} <= $${params.length}` }
  if (op === 'STARTS_WITH') { params.push(`${node.value}%`); return `${col} LIKE $${params.length}` }
  return 'TRUE'
}

// buildSegmentWhere: params indexed from $2 (caller prepends seg.id as $1)
function buildSegmentWhere(node, params) {
  const ALLOWED = SEGMENT_ALLOWED
  const op = (node?.op || '').toUpperCase()
  if (op === 'AND' || op === 'OR') {
    if (!node.conditions?.length) return 'TRUE'
    const parts = node.conditions.map(c => `(${buildSegmentWhere(c, params)})`)
    return parts.join(op === 'AND' ? ' AND ' : ' OR ')
  }
  if (!ALLOWED.includes(node?.field)) return 'TRUE'
  const col = fieldSql(node.field)
  if (op === 'IN') {
    const vals = [].concat(node.value).filter(Boolean)
    if (!vals.length) return 'FALSE'
    params.push(`{${vals.join(',')}}`)
    return `${col} = ANY($${params.length + 1}::text[])`
  }
  if (op === 'EQ')          { params.push(node.value); return `${col} = $${params.length + 1}` }
  if (op === 'GTE')         { params.push(node.value); return `${col} >= $${params.length + 1}` }
  if (op === 'LTE')         { params.push(node.value); return `${col} <= $${params.length + 1}` }
  if (op === 'STARTS_WITH') { params.push(`${node.value}%`); return `${col} LIKE $${params.length + 1}` }
  return 'TRUE'
}

// ── Campaigns ──────────────────────────────────────────────────────
// T3.4 (2026-05-01): handlers extracted to ./src/server-routes/campaigns.js
// per ADR-008 D2 module sequence. Behavior is byte-equivalent — Go-forwarding
// + direct-DB fallbacks unchanged. Existing campaign contract tests
// (bff-campaigns*.contract.test.ts) verify the contract from this file.
mountCampaignsRoutes(app, {
  pool,
  setRouteTags,
  capture500,
  safeError,
  Sentry,
})
// Sprint K2 — dry-run enrollment preview (SELECT-only, no state changes).
mountCampaignDryRunRoutes(app, { pool, capture500, safeError })
// Sprint L3 (#1288) — per-contact reply-aware timeline for CampaignDetail.
mountCampaignTimelineRoutes(app, { pool })
// ── Schema drift check (Phase 1 / S2) ──────────────────────────────
//
// GET /api/__schema-check
//
// Compares Go's live `/schema` manifest against the frozen baseline at
// apps/outreach-dashboard/schema-manifest.json. Returns:
//
//   { ok, drift?, last_check_at, baseline_hash, current_hash }
//
//   - ok=true                          — hashes match OR no structural drift
//   - ok=false + drift                 — added/removed tables, column drift, etc.
//   - ok=true + warning='no_baseline'  — first deploy, baseline file absent
//   - 503 + error='go_unreachable'     — Go side unhealthy / network failure
//   - 500 + error='malformed_response' — Go returned non-conforming JSON
//
// Cache: in-memory, 60s TTL keyed by the resolved baseline path. We
// avoid hammering Go on every request — schema drift is a slow signal
// (only changes on deploys) so a stale-by-60s answer is safe. Override
// for tests via SCHEMA_CHECK_BYPASS_CACHE=1.
//
// Auth: piggybacks on the global x-api-key middleware. No extra token
// required — operators already need an API key to reach any other BFF
// route, and exposing the schema diff anonymously would leak table
// names. Tests run with BFF_AUTH_DISABLED=1 (see contract setup.ts).
const SCHEMA_BASELINE_PATH = process.env.SCHEMA_BASELINE_PATH
  || new URL('../schema-manifest.json', import.meta.url).pathname
const SCHEMA_CHECK_TTL_MS = 60_000
let schemaCheckCache = { at: 0, payload: null, status: 200 }
function schemaWriteCache(at, payload, status) {
  // Only persist to cache when bypass mode is OFF. With bypass=1 (test
  // default) the cache must stay empty so fetch counts stay deterministic
  // across tests.
  if (process.env.SCHEMA_CHECK_BYPASS_CACHE === '1') return
  schemaCheckCache = { at, payload, status }
}

function readBaselineFile() {
  // Returns null when the file doesn't exist (first deploy), throws on
  // other I/O errors (corrupt JSON, permission denied — operator should
  // see those instead of a silent "no_baseline" warning).
  try {
    const raw = readFileSync(SCHEMA_BASELINE_PATH, 'utf8')
    return JSON.parse(raw)
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return null
    throw e
  }
}

app.get('/api/__schema-check', async (_req, res) => {
  setRouteTags({ 'schema.check': 'true' })
  const now = Date.now()
  if (
    process.env.SCHEMA_CHECK_BYPASS_CACHE !== '1'
    && schemaCheckCache.payload
    && now - schemaCheckCache.at < SCHEMA_CHECK_TTL_MS
  ) {
    return res.status(schemaCheckCache.status).json(schemaCheckCache.payload)
  }

  const goURL = process.env.GO_SERVER_URL
  if (!goURL) {
    // No Go service configured (legacy single-process dev). Treat as
    // unreachable rather than silently returning ok — operators should
    // know schema check isn't actually verifying anything.
    const payload = { ok: false, error: 'go_unreachable', last_check_at: new Date(now).toISOString() }
    schemaWriteCache(now, payload, 503)
    return res.status(503).json(payload)
  }

  let baseline = null
  try {
    baseline = readBaselineFile()
  } catch (e) {
    Sentry.captureException(e, { tags: { route: 'GET /api/__schema-check', step: 'baseline_read' } })
    return res.status(500).json({ ok: false, error: 'baseline_unreadable', detail: safeError(e) })
  }

  let current = null
  try {
    const r = await fetch(`${goURL.replace(/\/$/, '')}/schema`, {
      headers: { 'x-api-key': process.env.OUTREACH_API_KEY || '' },
      signal: AbortSignal.timeout(5_000),
    })
    if (!r.ok) {
      const payload = { ok: false, error: 'go_unreachable', http_status: r.status, last_check_at: new Date(now).toISOString() }
      schemaWriteCache(now, payload, 503)
      return res.status(503).json(payload)
    }
    current = await r.json()
  } catch (e) {
    const payload = { ok: false, error: 'go_unreachable', detail: safeError(e), last_check_at: new Date(now).toISOString() }
    schemaWriteCache(now, payload, 503)
    return res.status(503).json(payload)
  }

  if (!current || typeof current !== 'object' || typeof current.manifest_hash !== 'string') {
    const payload = { ok: false, error: 'malformed_response', last_check_at: new Date(now).toISOString() }
    schemaWriteCache(now, payload, 500)
    return res.status(500).json(payload)
  }

  if (!baseline) {
    // First deploy: accept current schema as truth. Operator must commit
    // schema-manifest.json before this endpoint becomes a real gate.
    const payload = {
      ok: true,
      warning: 'no_baseline',
      current_hash: current.manifest_hash,
      baseline_hash: null,
      last_check_at: new Date(now).toISOString(),
    }
    schemaWriteCache(now, payload, 200)
    return res.status(200).json(payload)
  }

  // Fast path: hash match → no structural diff needed.
  if (schemaQuickCheck(current, baseline)) {
    const payload = {
      ok: true,
      current_hash: current.manifest_hash,
      baseline_hash: baseline.manifest_hash,
      last_check_at: new Date(now).toISOString(),
    }
    schemaWriteCache(now, payload, 200)
    return res.status(200).json(payload)
  }

  const diff = diffManifests(current, baseline)
  const payload = {
    ok: diff.ok,
    drift: diff.drift,
    current_hash: current.manifest_hash,
    baseline_hash: typeof baseline.manifest_hash === 'string' ? baseline.manifest_hash : null,
    last_check_at: new Date(now).toISOString(),
  }
  schemaWriteCache(now, payload, 200)
  return res.status(200).json(payload)
})

// ── Templates ──────────────────────────────────────────────────────
// D2.6 (2026-05-02): templates CRUD + ranking + preview (6 routes:
// GET/POST /api/templates, GET /api/templates/ranking, PUT/DELETE
// /api/templates/:id, POST /api/templates/preview) extracted into
// server-routes/templates.js per ADR-008 D2 module sequence. The
// email_templates table CREATE stays here — boot-time DDL belongs
// alongside the other CREATE TABLE IF NOT EXISTS shims, and the mounter
// must run after the table exists.
await pool.query(`CREATE TABLE IF NOT EXISTS email_templates(
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ DEFAULT now()
)`).catch(()=>{})

mountTemplatesRoutes(app, { pool, capture500, safeError, renderTemplatePreview })

// ── Mailboxes ──────────────────────────────────────────────────────
// T3.5 (2026-05-01): mailbox CRUD (GET/POST /api/mailboxes,
// PATCH/DELETE /api/mailboxes/:id) extracted into server-routes/mailboxes.js
// per ADR-008 D2. The mounter also owns MB_SELECT + sanitizeMailboxRow +
// isPlaceholderPassword helpers (only used by these handlers). Per-mailbox
// stats, send-test, probes, and warmup routes still live below — they reach
// into helpers (smtpSendWithFallback, relay config) declared further down.
// G1 Batch A (2026-05-03): /api/mailboxes/:id/{stats, warmup PATCH,
// send-log, campaigns, watchdog-events, recover, auth-reset} extracted
// into src/server-routes/mailboxes.js per ADR-008 D2. Heal/diagnostic
// routes (full-check, smtp-check, imap-check, header-probe, pipeline-test,
// proxy-live-check, assign-proxy, send-test, bulk-*, etc.) remain
// inline below — extracted in Batch B.
mountMailboxRoutes(app, { pool, setRouteTags, capture500, safeError })
// AP2: operator repin endpoint — allows forced egress pin change with audit trail.
mountMailboxRepinRoute(app, { pool, setRouteTags, capture500, safeError })
// AC2: per-mailbox daily-limit panel — GET /api/mailboxes/:id/today-usage
mountTodayUsageRoute(app, { pool, capture500, safeError })
// AO6: per-mailbox egress history — GET /api/mailboxes/:id/egress-history?hours=N
mountMailboxEgressHistoryRoute(app, { pool, capture500, safeError })
// AS3/AS4: relay pool capacity gate — GET /api/relay/pool-capacity
// NOTE: mountPoolCapacityRoutes (poolCapacityMonitor.js) at line ~2963 is the
// canonical handler — richer response with per-endpoint pinned_to detail.
// mountRelayPoolCapacityRoute (relayPoolCapacity.js) was a simpler earlier
// implementation; removed here to prevent Express first-match shadowing the
// richer handler. See code-review fix P0.1.

// ── Per-mailbox Prometheus-style metrics snapshot ────────────────
// Emits text-format gauges derived from the live outreach_mailboxes
// state. Intended for scraping from outside the Go backend (which
// owns the counters) — useful when operators only expose the BFF.
app.get('/api/metrics/mailboxes', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT from_address, status, consecutive_bounces,
             COALESCE(canary_remaining, 0)   AS canary_remaining,
             COALESCE(circuit_opened_at IS NOT NULL, false) AS circuit_open
        FROM outreach_mailboxes
       WHERE environment = 'production'
    `)
    const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const statusInt = (s) => ({ active: 1, paused: 2, bounce_hold: 3, retired: 4 })[s] || 0
    const lines = []
    lines.push('# HELP outreach_mailbox_status Mailbox status as int (1=active,2=paused,3=bounce_hold,4=retired)')
    lines.push('# TYPE outreach_mailbox_status gauge')
    for (const r of rows) lines.push(`outreach_mailbox_status{address="${esc(r.from_address)}"} ${statusInt(r.status)}`)
    lines.push('# HELP outreach_mailbox_consecutive_bounces Consecutive bounce count')
    lines.push('# TYPE outreach_mailbox_consecutive_bounces gauge')
    for (const r of rows) lines.push(`outreach_mailbox_consecutive_bounces{address="${esc(r.from_address)}"} ${r.consecutive_bounces}`)
    lines.push('# HELP outreach_mailbox_canary_remaining Canary sends remaining before normal rotation resumes')
    lines.push('# TYPE outreach_mailbox_canary_remaining gauge')
    for (const r of rows) lines.push(`outreach_mailbox_canary_remaining{address="${esc(r.from_address)}"} ${r.canary_remaining}`)
    lines.push('# HELP outreach_mailbox_circuit_open 1 when per-mailbox SMTP circuit breaker is open, else 0')
    lines.push('# TYPE outreach_mailbox_circuit_open gauge')
    for (const r of rows) lines.push(`outreach_mailbox_circuit_open{address="${esc(r.from_address)}"} ${r.circuit_open ? 1 : 0}`)
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
    res.send(lines.join('\n') + '\n')
  } catch (e) {
    if (/relation .* does not exist/i.test(e.message)) {
      res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
      return res.send('')
    }
    return capture500(res, e, safeError)
  }
})

// T3.3 (2026-05-01): /api/health/* surface extracted into server-routes/health.js
// per ADR-008 D2. The mounter declares 9 routes — see that module for handler
// bodies. Mutable state (lastStaleGuardRun, lastConfigDrift) is declared
// further down in this file and exposed via getter/setter closures.
mountHealthRoutes(app, {
  pool,
  capture500,
  safeError,
  getProxyPool: () => getProxyPool(),
  getProxyCache: () => proxyCache,
  aggregateProxyExhaust,
  runConfigDrift,
  getLastStaleGuardRun: () => lastStaleGuardRun,
  getLastConfigDrift:   () => lastConfigDrift,
  setLastConfigDrift:   (v) => { lastConfigDrift = v },
})

// M3 — synthetic_runs query endpoint for dashboard
app.get('/api/synthetic-runs', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 500)
    const r = await pool.query(`
      SELECT id, ran_at, suite, results, pass_count, fail_count, duration_ms
      FROM synthetic_runs
      ORDER BY ran_at DESC
      LIMIT $1
    `, [limit]).catch(() => ({ rows: [] }))

    const stats = {
      total: r.rows.length,
      pass_runs: r.rows.filter(x => x.fail_count === 0).length,
      fail_runs: r.rows.filter(x => x.fail_count > 0).length,
      avg_duration_ms: r.rows.length > 0
        ? Math.round(r.rows.reduce((a, b) => a + (b.duration_ms || 0), 0) / r.rows.length)
        : 0,
    }

    res.json({ ok: true, runs: r.rows, stats })
  } catch (e) { capture500(res, e, safeError) }
})

// /api/health/cron-heartbeats, /api/health/test-quality, /api/health/system
// extracted into server-routes/health.js (T3.3).

// G1 Batch A (2026-05-03): /api/mailboxes/:id/cooldown-log and
// /api/mailboxes/:id/pipeline-results extracted into
// src/server-routes/mailboxes.js. /api/mailboxes/:id/pipeline-test stays
// inline (Batch B) — uses runPipelineTest helper which calls smtpCheck +
// imapCheck declared further down.

// /api/health/watchdog, /api/health/auth-fail-alerts, /api/health/proxy-exhaust
// extracted into server-routes/health.js (T3.3).

// Run Node.js pipeline test and persist result
async function runPipelineTest(mailboxId) {
  const { rows: mbRows } = await pool.query(
    `SELECT m.id, m.from_address AS email, m.smtp_host, m.smtp_port, m.smtp_username, m.password,
            m.imap_host, m.imap_port, m.imap_username, m.proxy_url, m.preferred_country,
            w.warmup_day, w.is_paused, w.last_advanced_at
     FROM outreach_mailboxes m
     LEFT JOIN mailbox_warmup w ON w.mailbox_address = m.from_address
     WHERE m.id = $1`, [mailboxId])
  if (!mbRows.length) { const e = new Error('not found'); e.code = 'not_found'; throw e }
  const row = mbRows[0]

  // Resolve SOCKS5 addr once (AO1 — IMAP must go via Mullvad wgpool)
  const imapSocks = row.imap_host
    ? await getMailboxSOCKS5Addr(row).catch(() => null)
    : null

  const [smtpRes, imapRes, warmupRes] = await Promise.all([
    smtpCheck(row.smtp_host, row.smtp_port, row.smtp_username, row.password)
      .then(r => ({ ok: r.ok, ms: r.ms, steps: r.steps })).catch(e => ({ ok: false, error: e.message })),
    row.imap_host && imapSocks
      ? imapCheck(row.imap_host, row.imap_port || 993, row.imap_username || row.smtp_username, row.password, imapSocks)
          .then(r => ({ ok: r.ok, ms: r.ms, steps: r.steps })).catch(e => ({ ok: false, error: e.message }))
      : (row.imap_host ? { ok: false, error: 'imap_socks_unavailable' } : null),
    Promise.resolve({ ok: row.warmup_day != null && !row.is_paused }),
  ])

  const steps = {
    smtp:        smtpRes,
    imap:        imapRes ?? undefined,
    proxy:       null,
    warmup:      warmupRes,
    anti_trace:  null,
    backpressure: { ok: true },
  }
  const overall_ok = smtpRes.ok && (imapRes == null || imapRes.ok)

  const { rows: inserted } = await pool.query(
    `INSERT INTO mailbox_pipeline_results(mailbox_id, overall_ok, steps, tested_at)
     VALUES($1, $2, $3, now())
     RETURNING id, overall_ok, steps, tested_at`,
    [mailboxId, overall_ok, JSON.stringify(steps)]
  ).catch(async () => ({ rows: [{ id: null, overall_ok, steps, tested_at: new Date().toISOString() }] }))
  return inserted[0]
}

app.post('/api/mailboxes/:id/pipeline-test', async (req, res) => {
  try {
    const out = await runPipelineTest(req.params.id)
    res.json(out)
  } catch (e) {
    if (e.code === 'not_found') return res.status(404).json({ error: 'not found' })
    return capture500(res, e, safeError)
  }
})

// G1 Batch A (2026-05-03): /api/mailboxes/:id/warmup/start extracted
// into src/server-routes/mailboxes.js.

// SMTP-EGRESS-LOCKDOWN R5: BFF no longer dials SOCKS5 directly — the probe
// forwards to anti-trace-relay /v1/auth-check, which does the dial inside
// the relay's runtime assertions (see R7 AssertSocks5 guard).
async function socks5Probe(proxyHost, proxyPort, timeoutMs = 6000, targetHost = 'smtp.seznam.cz', targetPort = 465) {
  return relaySocks5Probe(pool, proxyHost, proxyPort, timeoutMs, targetHost, targetPort)
}

// ── Stale-guard + BFF build metadata ─────────────────────────────
let gitShaCache = null
function getGitSha() {
  if (gitShaCache) return gitShaCache
  try { gitShaCache = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim() } catch { gitShaCache = 'unknown' }
  return gitShaCache
}
const BFF_BOOTED_AT = Date.now()
let lastAntiTraceOkAt = null
let staleGuardTimer = null
let lastStaleGuardRun = null

app.get('/api/version', (_req, res) => {
  res.json({
    git_sha: getGitSha(),
    pid: process.pid,
    booted_at: new Date(BFF_BOOTED_AT).toISOString(),
    uptime_s: Math.round((Date.now() - BFF_BOOTED_AT) / 1000),
  })
})

// Railway healthcheck pings /api/health — must not auth-gate, must not 500.
// AUTH_EXEMPT already passes through; the route was never declared so the
// healthcheck got 404 and Railway refused to promote new deploys. Liveness
// only — no DB / Go / relay dependency.
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', git_sha: getGitSha(), ts: new Date().toISOString() })
})

// /api/health/guards extracted into server-routes/health.js (T3.3).

app.get('/api/dns-audit', async (_req, res) => {
  const { resolveTxt } = await import('node:dns/promises')
  const { rows } = await pool.query(
    `SELECT DISTINCT split_part(smtp_username, '@', 2) AS domain
     FROM outreach_mailboxes WHERE smtp_username LIKE '%@%' AND status != 'archived'`
  )
  const domains = rows.map(r => r.domain).filter(Boolean)
  if (domains.length === 0) {
    return res.json({ status: 'skip', detail: 'no sending domains configured', latency_ms: 0, domains: {} })
  }
  const start = Date.now()
  let overall = 'ok'
  const domainResults = {}
  for (const domain of domains) {
    let spfStatus = 'err', spfDetail = 'no SPF record found'
    let dmarcStatus = 'err', dmarcDetail = 'no DMARC record found'
    try {
      const txts = (await resolveTxt(domain)).flat()
      const spf = txts.find(t => t.startsWith('v=spf1'))
      if (spf) {
        spfStatus = spf.includes('-all') ? 'ok' : 'warn'
        spfDetail = spf
      }
    } catch (e) { spfDetail = 'lookup failed: ' + e.message }
    try {
      const dtxts = (await resolveTxt('_dmarc.' + domain)).flat()
      const dm = dtxts.find(t => t.startsWith('v=DMARC1'))
      if (dm) {
        dmarcStatus = dm.includes('p=none') ? 'warn' : 'ok'
        dmarcDetail = dm
      }
    } catch (e) { dmarcDetail = 'lookup failed: ' + e.message }
    domainResults[domain] = { spf_status: spfStatus, spf_detail: spfDetail, dmarc_status: dmarcStatus, dmarc_detail: dmarcDetail }
    if (spfStatus === 'err' || dmarcStatus === 'err') overall = 'err'
    else if ((spfStatus === 'warn' || dmarcStatus === 'warn') && overall !== 'err') overall = 'warn'
  }
  res.json({ status: overall, latency_ms: Date.now() - start, domains: domainResults })
})

let lastConfigDrift = null
// /api/health/drift extracted into server-routes/health.js (T3.3) — module
// reads/writes via getLastConfigDrift / setLastConfigDrift closures so the
// 5-min cron at runConfigDrift below shares the same cache.

// ── SOCKS5 proxy pool — owned by anti-trace-relay (SMTP-EGRESS-LOCKDOWN R5) ──
// The BFF no longer aggregates proxies or tracks a pool cache. Snapshot is
// fetched on demand from relay /v1/proxy-pool. Blacklist is retained as a
// DB audit table only — the BFF records evictions for operator visibility
// but does not mutate the pool (relay owns pool ranking + refresh).
let proxyCache = null // kept as a read-through cache only; populated by getProxyPool()
let proxyCachedAt = 0
const PROXY_TTL = 15 * 1000 // short cache — relay already caches ~15min internally; 15s for real-time UI

function evictProxy(addr, mailboxId, reason) {
  pool.query(
    `INSERT INTO proxy_blacklist (proxy_addr, mailbox_id, expires_at, reason)
     VALUES ($1, $2, now() + interval '6 hours', $3)
     ON CONFLICT (proxy_addr) DO UPDATE SET
       blacklisted_at = now(),
       expires_at = now() + interval '6 hours',
       mailbox_id = EXCLUDED.mailbox_id,
       reason = EXCLUDED.reason`,
    [addr, mailboxId || null, reason || 'network_error']
  ).catch(e => console.warn('[proxy] blacklist persist:', e.message))
  console.log(`[proxy] evicted ${addr} (reason=${reason || 'network_error'})`)
}

async function hydrateProxyBlacklist() {
  try {
    await pool.query(`DELETE FROM proxy_blacklist WHERE expires_at < now()`)
  } catch (e) { console.warn('[proxy] hydrate blacklist:', e.message) }
}

function isNetworkError(err) {
  const msg = err?.message || String(err)
  if (/ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND/i.test(msg)) return true
  if (/timeout|timed out|socks|proxy|refused|407/i.test(msg)) return true
  if (err?.code && /ECONN|ETIMEDOUT|EHOST|ENET|ENOTFOUND/.test(err.code)) return true
  return false
}

// Centralized proxy-failure recovery. Usage:
//   try { return await op(proxyUrl) }
//   catch (e) {
//     const swapped = await proxyReassignGuard({ mailboxId, err: e, proxyUrl })
//     if (swapped) return await op(swapped.proxy_url)  // retry once with new proxy
//     throw e
//   }
async function proxyReassignGuard({ mailboxId, err, proxyUrl, reason }) {
  if (!isNetworkError(err)) return null
  if (!mailboxId) return null
  const addr = proxyUrl?.replace(/^socks5:\/\//, '').replace(/^http:\/\//, '')
  if (addr) evictProxy(addr, mailboxId, reason || err.message?.slice(0, 120))
  // Purge stale cached addr — the current proxy_url just network-errored,
  // so the memoized "last known-working proxy" is also wrong.
  authCache.invalidate(mailboxId)
  const attempts = []
  const newProxy = await assignBestProxy(mailboxId, attempts).catch(e => {
    console.warn(`[proxy-guard] reassign(${mailboxId}):`, e.message)
    return null
  })
  if (newProxy) {
    pool.query(
      `INSERT INTO watchdog_events (check_name, severity, mailbox_id, message, auto_healed, healed_at, reason)
       VALUES ('proxy_reassign', 'warn', $1, $2, true, now(), $3)`,
      [mailboxId, `swapped ${addr || 'unknown'} → ${newProxy.proxy_url.replace('socks5://', '')}`, reason || err.message?.slice(0, 120) || 'network_error']
    ).catch(() => {})
    return newProxy
  }
  // Auto-recovery exhausted the pool without finding a working proxy — surface
  // the per-proxy breakdown in a watchdog event so it's visible in the alerts
  // timeline, not just in transient stderr.
  if (attempts.length) {
    const summary = summarizeAttempts(attempts)
    const summaryStr = Object.entries(summary).map(([k, n]) => `${n} ${k}`).join(', ') || 'all-unknown'
    pool.query(
      `INSERT INTO watchdog_events (check_name, severity, mailbox_id, message, auto_healed, reason)
       VALUES ('proxy_reassign_exhausted', 'error', $1, $2, false, $3)`,
      [mailboxId, `no proxy passed AUTH (tried=${attempts.length}: ${summaryStr})`, reason || err.message?.slice(0, 120) || 'network_error']
    ).catch(() => {})
  }
  return null
}

// Sprint AO6: smtpSendWithFallback now delegates to smtpSend which routes via relay
// /v1/submit. Proxy rotation is relay's responsibility — proxyReassignGuard is no
// longer called from this path. maxAttempts kept for transient relay connectivity
// errors (e.g. relay restart, network blip) — relay itself handles proxy rotation
// internally before returning an error.
async function smtpSendWithFallback(mailboxId, args, maxAttempts = 2) {
  // proxy_url in args is now ignored by smtpSend (AO6 deprecation).
  // preferredCountry is queried from DB if not already in args.
  let preferredCountry = args.preferredCountry || ''
  if (!preferredCountry && mailboxId) {
    try {
      const { rows } = await pool.query('SELECT COALESCE(preferred_country,\'\') AS pc FROM outreach_mailboxes WHERE id=$1', [mailboxId])
      preferredCountry = rows[0]?.pc || ''
    } catch { /* non-fatal — relay will use any-country */ }
  }

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await smtpSend({ ...args, mailboxId, preferredCountry })
    } catch (e) {
      if (attempt < maxAttempts - 1) {
        // Only retry on transient relay connectivity errors — not on relay-side send failures
        if (/relay not configured|ECONNREFUSED|ETIMEDOUT|fetch/i.test(e.message)) continue
      }
      throw e
    }
  }
}

// Proxy pool is owned by anti-trace-relay (SMTP-EGRESS-LOCKDOWN R5).
// BFF keeps a 15s read-through cache over `/v1/proxy-pool` — relay already
// caches ~15min internally, so BFF cache just smooths burst traffic.
// When the snapshot reports empty_pool_critical=true the cache is immediately
// invalidated so the next call always fetches a fresh relay state.
async function getProxyPool() {
  if (proxyCache && Date.now() - proxyCachedAt < PROXY_TTL) return proxyCache
  const snapshot = await relayProxyPool(pool)
  proxyCache = snapshot
  proxyCachedAt = Date.now()
  // Immediate invalidation on critical empty-pool state so the next caller
  // always sees the freshest relay snapshot — do not serve a stale empty pool.
  if (snapshot && snapshot.empty_pool_critical) {
    proxyCachedAt = 0
  }
  return proxyCache
}

// invalidateProxyCache resets the BFF proxy-pool cache so the next
// getProxyPool() call always fetches a fresh snapshot from the relay.
// Call this after any event that may have changed pool state (e.g. bulk-check,
// watchdog trigger, force-refresh).
function invalidateProxyCache() {
  proxyCache = null
  proxyCachedAt = 0
}

// 24h pool-trend sparkline backing store — 5-min ticker records working count
// into an in-memory ring buffer, endpoint exposes the series to PoolHealthWidget.
// Ephemeral across restarts (by design) — a BFF bounce just shortens the
// sparkline window, which is acceptable for "is the pool trending up?".
setInterval(async () => {
  try {
    const data = await getProxyPool()
    poolTrend.recordSample({
      working: data.working_count ?? (Array.isArray(data.working) ? data.working.length : 0),
      totalCandidates: data.total_candidates ?? 0,
    })
  } catch { /* tolerate relay outage — gaps in the sparkline are informative */ }
}, 5 * 60_000)

app.get('/api/proxy-pool-trend', async (_req, res) => {
  try {
    res.json(poolTrend.snapshot())
  } catch (e) { capture500(res, e, safeError) }
})

app.get('/api/proxy-pool', async (req, res) => {
  try {
    const force = req.query.refresh === '1'
    const full = req.query.full === '1'
    if (force) { proxyCache = null; proxyCachedAt = 0 }
    const data = await getProxyPool()
    if (full) return res.json(data)
    const { working, ...rest } = data
    res.json({
      ...rest,
      working: working.map(p => ({
        addr: p.addr,
        country: p.country,
        source: p.source,
        probe_ms: p.probe_ms,
        last_latency_ms: p.last_latency_ms,
      })),
    })
  } catch (e) { capture500(res, e, safeError) }
})

// Sprint G11 (#1241) — synthetic-probe placeholder removed. The cron
// was disabled by default (SYNTHETIC_PROBE_ENABLED!=='true') and the
// body only logged a placeholder string — never dispatched a real
// probe. Worse, it called slog() which is not defined in this file,
// so enabling the flag would have crashed the BFF process with
// ReferenceError on the first tick. The modern runSyntheticSmokeCron
// (SKIP_SYNTHETIC_CRON gated, runs every 60s) does the real work
// against the prod-smoke test suite.

// ── Anti-trace relay health ────────────────────────────────────────
async function pingAntiTrace() {
  const { rows } = await pool.query("SELECT value FROM outreach_config WHERE key='anti_trace_url'")
  const url = rows[0]?.value
  if (!url) return { ok: false, reason: 'not_configured', url: null }
  const t = Date.now()
  try {
    const r = await fetch(url + '/healthz', { signal: AbortSignal.timeout(5000) })
    const ms = Date.now() - t
    const body = await r.json().catch(() => ({}))
    const ok = r.ok && body.status === 'ok'
    if (ok) lastAntiTraceOkAt = new Date()
    return { ok, status_code: r.status, ms, url }
  } catch (fetchErr) {
    return { ok: false, reason: fetchErr.message, ms: Date.now() - t, url }
  }
}

app.get('/api/anti-trace/health', async (_req, res) => {
  try { res.json(await pingAntiTrace()) }
  catch (e) { capture500(res, e, safeError) }
})

// ── Anti-trace egress debug (CAD-M2 / issue #557) ──────────────────
// Proxies relay GET /v1/egress-debug with a 60s read-through cache.
// Operator + pnpm report consume this to detect Mullvad config drift
// (e.g. egress IP in CN instead of CZ) before launching a campaign.
let egressDebugCache = null
let egressDebugCachedAt = 0
const EGRESS_DEBUG_TTL_MS = 60_000

async function getEgressDebug() {
  if (egressDebugCache && Date.now() - egressDebugCachedAt < EGRESS_DEBUG_TTL_MS) {
    return egressDebugCache
  }
  const url = process.env.ANTI_TRACE_RELAY_URL || process.env.ANTI_TRACE_URL
  const token = process.env.ANTI_TRACE_RELAY_TOKEN || process.env.ANTI_TRACE_TOKEN
  if (!url) return { ok: false, reason: 'ANTI_TRACE_RELAY_URL not set' }
  if (!token) return { ok: false, reason: 'ANTI_TRACE_RELAY_TOKEN not set' }
  try {
    const r = await fetch(url + '/v1/egress-debug', {
      headers: { 'Authorization': 'Bearer ' + token },
      signal: AbortSignal.timeout(15_000),
    })
    if (!r.ok) {
      return { ok: false, reason: `relay status ${r.status}`, status_code: r.status }
    }
    const data = await r.json()
    egressDebugCache = { ok: true, ...data, cached_at: new Date().toISOString() }
    egressDebugCachedAt = Date.now()
    return egressDebugCache
  } catch (e) {
    return { ok: false, reason: e.message }
  }
}

app.get('/api/anti-trace/egress', async (req, res) => {
  try {
    if (req.query.refresh === '1') { egressDebugCache = null; egressDebugCachedAt = 0 }
    res.json(await getEgressDebug())
  } catch (e) { capture500(res, e, safeError) }
})

// ── Protections (Ochrany panel diagnostics) ──────────────────────────
// D2.8 (2026-05-02): /api/protections/* extracted into
// ./src/server-routes/protections.js per ADR-008 D2 module sequence.
// 5 routes: matrix, trace/:messageId, alerts, alerts/:id/ack, coverage.
// Response shape is stable — UI (Mailboxes AnonymizationBar + OchranyPanel)
// pins the 12 layer names × 2 levels (L2/L3) client-side.
mountProtectionsRoutes(app, { pool, capture500, safeError })

// ── Per-mailbox live proxy check ──────────────────────────────────
app.get('/api/mailboxes/:id/proxy-live-check', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT proxy_url FROM outreach_mailboxes WHERE id=$1', [req.params.id])
    if (!rows.length) return res.status(404).json({ error: 'not found' })
    const { proxy_url } = rows[0]
    if (!proxy_url) return res.json({ ok: null, reason: 'not_configured', proxy_url: null })
    try {
      const u = new URL(proxy_url)
      const result = await socks5Probe(u.hostname, Number(u.port) || 1080, 3500)
      res.json({ ok: result.ok, ms: result.ms, proxy_url, host: u.hostname, port: Number(u.port) || 1080 })
    } catch { res.json({ ok: false, reason: 'invalid_url', proxy_url }) }
  } catch (e) { capture500(res, e, safeError) }
})

// ── Assign best free proxy to mailbox ────────────────────────────
// Relay returns pool pre-ranked (country + latency) — BFF preserves order.
function rankProxies(working) {
  return working.slice()
}

// Relay-backed AUTH probe (SMTP-EGRESS-LOCKDOWN R5).
// Forwards to POST /v1/auth-check with proxy_addr; returns {ok, ms, reason?}.
async function smtpAuthProbe(proxyAddr, smtpHost, smtpPort, username, password) {
  return relaySmtpAuthProbe(pool, proxyAddr, smtpHost, smtpPort, username, password)
}

app.post('/api/mailboxes/:id/assign-proxy', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id FROM outreach_mailboxes WHERE id=$1', [req.params.id])
    if (!rows.length) return res.status(404).json({ error: 'not found' })
    if (!proxyCache?.working?.length) await getProxyPool()
    if (!proxyCache?.working?.length) return res.status(503).json({ error: 'no working proxies available' })
    const timeoutP = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('assign_proxy_timeout')), 50_000))
    const attempts = []
    const proxyResult = await Promise.race([assignBestProxy(req.params.id, attempts), timeoutP])
    if (!proxyResult) {
      return res.status(503).json({
        error: 'no proxy passed SMTP AUTH',
        tried: attempts.length,
        summary: summarizeAttempts(attempts),
        attempts,
      })
    }
    const { proxy_url, latency_ms, country } = proxyResult
    const { rows: updated } = await pool.query(
      'SELECT id, from_address AS email, proxy_url FROM outreach_mailboxes WHERE id=$1', [req.params.id])
    res.json({ proxy_url, latency_ms, country, mailbox: updated[0] })
  } catch (e) {
    if (e.message === 'assign_proxy_timeout') return res.status(503).json({ error: 'proxy assignment timed out' })
    return capture500(res, e, safeError)
  }
})

// ── Sprint 1/2/3: SMTP/IMAP check helpers ────────────────────────

// Returns a reader bound to `sock` that keeps a shared buffer so that
// data arriving in a single TCP packet is not lost between calls.
function makeReader(sock) {
  let buf = ''
  let pending = null // { resolve, reject, test } waiting for data

  const onData = d => {
    buf += d.toString()
    if (pending && pending.test(buf)) {
      const p = pending; pending = null
      p.resolve()
    }
  }
  const onError = e => { if (pending) { const p = pending; pending = null; p.reject(e) } }
  const onClose = () => { if (pending) { const p = pending; pending = null; p.resolve() } }
  sock.on('data', onData)
  sock.on('error', onError)
  sock.on('close', onClose)

  const waitFor = (test, timeoutMs, label) => new Promise((resolve, reject) => {
    if (test(buf)) return resolve()
    pending = { resolve, reject, test }
    setTimeout(() => {
      if (pending) { pending = null; reject(new Error(`${label} timeout`)) }
    }, timeoutMs)
  })

  return {
    // Read next complete SMTP response (ends with line "NNN <text>\r\n", no dash after code)
    async readResponse(timeoutMs = 8000, label = 'read') {
      await waitFor(b => /^\d{3} [^\r\n]*\r?\n/m.test(b), timeoutMs, label)
      const resp = buf; buf = ''
      return resp.trim()
    },
    // Convenience: read one line (for IMAP/simple single-line responses)
    async readLine(timeoutMs = 8000, label = 'read') {
      await waitFor(b => b.includes('\n'), timeoutMs, label)
      const idx = buf.indexOf('\n')
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      return line
    },
    detach() {
      sock.removeListener('data', onData)
      sock.removeListener('error', onError)
      sock.removeListener('close', onClose)
    },
  }
}

// Relay-backed SMTP credential check (SMTP-EGRESS-LOCKDOWN R5).
// Forwards to POST /v1/probe — BFF never dials SMTP directly anymore.
// Returns {ok, ms, steps: [{name, ok, ms, msg}]} — wire-compatible with the
// old in-process probe that the dashboard UI already consumes.
//
// Sprint AO3: mailboxId + preferredCountry route the probe via the same wgPool
// endpoint as drain, eliminating multi-country signal for Seznam fraud detection.
async function smtpCheck(host, port, username, password, { mailboxId = '', preferredCountry = '' } = {}) {
  return relaySmtpCheck(pool, host, port, username, password, { mailboxId, preferredCountry })
}

// Sprint AO6: smtpSend now routes exclusively via the anti-trace-relay /v1/submit
// endpoint. Raw SOCKS5+SMTP logic has been removed — relay handles all egress
// routing via wgpool. proxy_url is no longer a valid parameter; callers that
// still pass it receive a warn log (backward-compat shim) but the value is ignored.
//
// Signature:
//   smtpSend({ mailboxId, host, port, username, password, from, to, subject, text,
//              preferredCountry? })
//   - mailboxId: relay uses this for wgpool egress pinning + AP4 observation
//   - preferredCountry: optional; relay picks wgpool endpoint by country
//   - proxy_url: ignored (deprecated per project_per_mailbox_proxy_deprecated)
//
// Return shape: { ok: true, messageId, envelope_id } on success.
// Throws on relay error (caller smtpSendWithFallback surfaces via HTTP 502).
async function smtpSend({ mailboxId, host, port, username, password, proxy_url, from, to, subject, text, body_html = '', imap_host = '', imap_port = 0, preferredCountry = '' }) {
  if (proxy_url !== undefined) {
    console.warn('[smtpSend] proxy_url parameter is deprecated (AO6) and ignored — relay handles routing')
  }

  const relayBase = await getRelayBase(pool)
  const relayToken = process.env.ANTI_TRACE_RELAY_TOKEN || process.env.ANTI_TRACE_TOKEN || ''

  if (!relayBase) {
    throw new Error('smtpSend: anti-trace-relay not configured (ANTI_TRACE_RELAY_URL missing)')
  }

  const envelope = {
    from_address: from,
    recipient: to,
    subject: subject || '',
    body: text || '',
    // Memory feedback_relay_submit_full_payload: include body_html so recipient
    // sees the HTML alternative (multipart/alternative) authored in
    // email_templates.body_html — without this the recipient only sees plain
    // text regardless of what the template DB row contains.
    body_html: body_html || '',
    smtp_host: host,
    smtp_port: Number(port),
    smtp_username: username,
    smtp_password: password,
    // Memory feedback_relay_submit_full_payload: include IMAP coords so the
    // relay's post-send sent_appender fires. Gate `HasIMAP()` in
    // services/relay/internal/model/model.go requires IMAPHost+IMAPPort+
    // SMTPUsername+SMTPPassword. Without these the Sent folder stays empty
    // and there is no log line indicating why (silent skip in main.go).
    imap_host: imap_host || '',
    imap_port: Number(imap_port) || 0,
    // Mailbox-locale Date so wire-MIME carries +0200/+0100 instead of the
    // upstream MTA's UTC fallback. Mirrors the fix in campaign-send-batch.js
    // so the diagnostic /api/mailboxes/:id/send-test path matches campaign sends.
    headers: {
      Date: formatRFC5322Date(new Date(), 'Europe/Prague'),
    },
  }
  if (mailboxId) envelope.mailbox_id = String(mailboxId)
  if (preferredCountry) envelope.preferred_country = preferredCountry

  const headers = { 'Content-Type': 'application/json' }
  if (relayToken) headers['Authorization'] = `Bearer ${relayToken}`

  const r = await fetch(`${relayBase}/v1/submit`, {
    method: 'POST',
    headers,
    body: JSON.stringify(envelope),
    signal: AbortSignal.timeout(30_000),
  })

  const respText = await r.text()
  let parsed
  try { parsed = respText ? JSON.parse(respText) : {} } catch { parsed = { raw: respText.slice(0, 500) } }

  if (!r.ok) {
    const errMsg = parsed?.error || parsed?.message || `relay HTTP ${r.status}`
    throw new Error(`smtpSend relay error: ${errMsg}`)
  }

  return {
    ok: true,
    messageId: parsed.envelope_id || null,
    envelope_id: parsed.envelope_id || null,
    status: parsed.status || null,
  }
}

// ── Sprint AO1: IMAP-via-SOCKS5 helpers ──────────────────────────────────────
//
// All BFF IMAP code paths MUST connect via SOCKS5 (Mullvad wgpool).
// Direct net.Socket().connect(993, host) is banned — enforced by the audit
// ratchet in tests/audit/no_raw_imap_socket.test.js.
//
// dialIMAPViaSOCKS5 opens a SOCKS5-tunnelled TLS socket to an IMAP server
// and returns the connected tls.TLSSocket, already past TCP+TLS.
//
// getMailboxSOCKS5Addr resolves the SOCKS5 address for a given mailbox:
//   1. Queries outreach_mailboxes for preferred_country
//   2. Calls relay /v1/imap-socks-addr?preferred_country=XX
//   3. Falls back to first available endpoint (no country pin) on failure
//   4. Throws if relay is not configured or all endpoints quarantined

async function dialIMAPViaSOCKS5(socksAddr, host, port, timeoutMs = 15000) {
  const [socksHost, socksPortStr] = socksAddr.split(':')
  const socksPort = Number(socksPortStr) || 1080
  const info = await SocksClient.createConnection({
    proxy:       { host: socksHost, port: socksPort, type: 5 },
    command:     'connect',
    destination: { host, port: Number(port) },
    timeout:     timeoutMs,
  })
  // Fix 4 (P1): default to rejectUnauthorized:true — SOCKS5 tunnel terminates
  // at the real IMAP server so the TLS cert is for that server and is verifiable.
  // Set IMAP_TLS_INSECURE=1 only as an emergency operator override (e.g. self-signed
  // test cert). Never set in production.
  const imapTlsInsecure = process.env.IMAP_TLS_INSECURE === '1'
  if (imapTlsInsecure) {
    console.warn('[security] IMAP_TLS_INSECURE=1: TLS certificate verification DISABLED for IMAP connections — NOT safe for production')
  }
  return new Promise((resolve, reject) => {
    const tlsSock = tls.connect({
      socket:            info.socket,
      servername:        host,
      rejectUnauthorized: !imapTlsInsecure,
      timeout:           timeoutMs,
    }, () => resolve(tlsSock))
    tlsSock.once('error', reject)
    tlsSock.once('timeout', () => { tlsSock.destroy(); reject(new Error('tls timeout')) })
  })
}

// Resolves the SOCKS5 address for a mailbox, keyed by mailbox DB row or id.
// Accepts: a mailbox row (object with .preferred_country) OR just a mailboxId
// (string/number). Returns the socks addr string e.g. "127.0.0.1:1080".
// Throws if relay is unavailable / all endpoints quarantined.
async function getMailboxSOCKS5Addr(mailboxRowOrId) {
  let preferredCountry = ''
  if (mailboxRowOrId && typeof mailboxRowOrId === 'object') {
    preferredCountry = mailboxRowOrId.preferred_country || ''
  } else if (mailboxRowOrId != null) {
    const { rows } = await pool.query(
      'SELECT preferred_country FROM outreach_mailboxes WHERE id=$1',
      [mailboxRowOrId]
    )
    preferredCountry = rows[0]?.preferred_country || ''
  }
  const result = await relayImapSocksAddr(pool, preferredCountry)
  if (!result) {
    // Fallback: try without country pin (any active endpoint)
    if (preferredCountry) {
      const fallback = await relayImapSocksAddr(pool, '')
      if (fallback) return fallback.socks_addr
    }
    throw new Error('imap_socks_unavailable: relay not configured or all endpoints quarantined')
  }
  return result.socks_addr
}

// socksAddr: optional override; if omitted, resolved via getMailboxSOCKS5Addr.
// Callers that already have the mailbox row can pass socksAddr directly to avoid
// an extra DB round-trip.
async function imapCheck(host, port, username, password, socksAddr) {
  const steps = []
  const overall_t = Date.now()
  let comm = null
  let reader = null

  try {
    // Step 1+2: SOCKS5 dial + TLS (port 993 is implicit TLS)
    let t = Date.now()
    const resolvedSocks = socksAddr || await getMailboxSOCKS5Addr(null)
    try {
      comm = await dialIMAPViaSOCKS5(resolvedSocks, host, Number(port))
      steps.push({ name: 'tcp', ok: true, ms: Date.now() - t, msg: `socks5=${resolvedSocks}` })
      steps.push({ name: 'tls', ok: true, ms: Date.now() - t, msg: null })
    } catch (e) {
      steps.push({ name: 'tcp', ok: false, ms: Date.now() - t, msg: e.message })
      return { ok: false, ms: Date.now() - overall_t, steps }
    }

    reader = makeReader(comm)

    // Step 3: Read greeting (* OK ...)
    t = Date.now()
    try {
      const greeting = await reader.readLine(5000, 'greeting')
      if (!greeting.includes('OK')) throw new Error(`Bad IMAP greeting: ${greeting.slice(0, 80)}`)
      steps.push({ name: 'greeting', ok: true, ms: Date.now() - t, msg: null })
    } catch (e) {
      steps.push({ name: 'greeting', ok: false, ms: Date.now() - t, msg: e.message })
      return { ok: false, ms: Date.now() - overall_t, steps }
    }

    // Step 4: CAPABILITY — check server supports LOGIN
    t = Date.now()
    try {
      comm.write('A0 CAPABILITY\r\n')
      const capResp = await reader.readLine(5000, 'capability')
      const capLine = capResp.toUpperCase()
      const hasLogin = capLine.includes('LOGIN') || capLine.includes('AUTH=PLAIN')
      steps.push({ name: 'capability', ok: hasLogin, ms: Date.now() - t, msg: hasLogin ? null : 'LOGIN not advertised' })
    } catch (e) {
      steps.push({ name: 'capability', ok: false, ms: Date.now() - t, msg: e.message })
    }
    // Skip capability OK line
    try { await reader.readLine(2000, 'cap_ok') } catch {}

    // Step 5: AUTH LOGIN
    if (!password) {
      steps.push({ name: 'auth', ok: false, ms: 0, msg: 'Empty password' })
      return { ok: false, ms: Date.now() - overall_t, steps }
    }

    t = Date.now()
    try {
      const quotedUser = `"${username.replace(/"/g, '\\"')}"`
      const quotedPass = `"${password.replace(/"/g, '\\"')}"`
      comm.write(`A1 LOGIN ${quotedUser} ${quotedPass}\r\n`)
      const authResult = await reader.readLine(5000, 'auth')
      if (!authResult.startsWith('A1 OK')) throw new Error(`IMAP auth failed: ${authResult.slice(0, 80)}`)
      steps.push({ name: 'auth', ok: true, ms: Date.now() - t, msg: null })
    } catch (e) {
      steps.push({ name: 'auth', ok: false, ms: Date.now() - t, msg: e.message })
      return { ok: false, ms: Date.now() - overall_t, steps }
    }

    // Step 6: SELECT INBOX — verify read/write access
    t = Date.now()
    try {
      comm.write('A2 SELECT INBOX\r\n')
      // Read lines until we get A2 OK/NO/BAD
      let selectResp = ''
      for (let i = 0; i < 10; i++) {
        const line = await reader.readLine(3000, 'select')
        selectResp += line + '\n'
        if (line.startsWith('A2 ')) break
      }
      const selectOk = selectResp.includes('A2 OK')
      steps.push({ name: 'select_inbox', ok: selectOk, ms: Date.now() - t, msg: selectOk ? null : selectResp.slice(0, 80) })
    } catch (e) {
      steps.push({ name: 'select_inbox', ok: false, ms: Date.now() - t, msg: e.message })
    }

    return { ok: true, ms: Date.now() - overall_t, steps }
  } catch (e) {
    if (!steps.length) {
      steps.push({ name: 'tcp', ok: false, ms: Date.now() - overall_t, msg: e.message })
    }
    return { ok: false, ms: Date.now() - overall_t, steps }
  } finally {
    try { reader?.detach() } catch {}
    try { comm?.destroy() } catch {}
  }
}

// ── IMAP SEARCH UNSEEN helper ─────────────────────────────────────
async function imapSearchUnseen(host, port, username, password, socksAddr) {
  let comm = null, reader = null
  try {
    const resolvedSocks = socksAddr || await getMailboxSOCKS5Addr(null)
    comm = await dialIMAPViaSOCKS5(resolvedSocks, host, Number(port))
    reader = makeReader(comm)
    await reader.readLine(5000, 'greeting')
    const quotedUser = `"${username.replace(/"/g, '\\"')}"`
    const quotedPass = `"${password.replace(/"/g, '\\"')}"`
    comm.write(`A1 LOGIN ${quotedUser} ${quotedPass}\r\n`)
    const authResult = await reader.readLine(5000, 'auth')
    if (!authResult.startsWith('A1 OK')) throw new Error('auth failed')
    comm.write('A2 SELECT INBOX\r\n')
    for (let i = 0; i < 10; i++) {
      const line = await reader.readLine(3000, 'select')
      if (line.startsWith('A2 ')) break
    }
    comm.write('A3 SEARCH UNSEEN\r\n')
    let searchResp = ''
    for (let i = 0; i < 5; i++) {
      const line = await reader.readLine(5000, 'search')
      searchResp += line + '\n'
      if (line.startsWith('A3 ')) break
    }
    const match = searchResp.match(/\* SEARCH([\d\s]*)\r?\n/)
    const ids = match ? match[1].trim().split(/\s+/).filter(Boolean) : []
    return ids.length
  } finally {
    try { reader?.detach() } catch {}
    try { comm?.destroy() } catch {}
  }
}

// Returns { count, uids } instead of just count
async function imapSearchUnseenUids(host, port, username, password, socksAddr) {
  let comm = null, reader = null
  try {
    const resolvedSocks = socksAddr || await getMailboxSOCKS5Addr(null)
    comm = await dialIMAPViaSOCKS5(resolvedSocks, host, Number(port))
    reader = makeReader(comm)
    await reader.readLine(5000, 'greeting')
    comm.write(`A1 LOGIN "${username.replace(/"/g, '\\"')}" "${password.replace(/"/g, '\\"')}"\r\n`)
    if (!(await reader.readLine(5000, 'auth')).startsWith('A1 OK')) throw new Error('auth failed')
    // SELECT INBOX returns UIDVALIDITY in untagged response. Capture it
    // so the cron can detect mailbox recreation (#27 — UIDs aren't
    // monotonic across UIDVALIDITY changes; we must reset last_processed_uid).
    comm.write('A2 SELECT INBOX\r\n')
    let uidValidity = null
    for (let i = 0; i < 10; i++) {
      const l = await reader.readLine(3000, 'sel')
      const uvMatch = l.match(/\[UIDVALIDITY\s+(\d+)\]/i)
      if (uvMatch) uidValidity = parseInt(uvMatch[1], 10)
      if (l.startsWith('A2 ')) break
    }
    comm.write('A3 SEARCH UNSEEN\r\n')
    let resp = ''
    for (let i = 0; i < 5; i++) { const l = await reader.readLine(5000, 'srch'); resp += l + '\n'; if (l.startsWith('A3 ')) break }
    const m = resp.match(/\* SEARCH([\d\s]*)\r?\n/)
    const uids = m ? m[1].trim().split(/\s+/).filter(Boolean).map(u => parseInt(u, 10)) : []
    return { count: uids.length, uids, uidValidity }
  } finally {
    try { reader?.detach() } catch {}
    try { comm?.destroy() } catch {}
  }
}

async function imapFetchHeaders(host, port, username, password, uids, socksAddr) {
  if (!uids.length) return []
  let comm = null, reader = null
  try {
    const resolvedSocks = socksAddr || await getMailboxSOCKS5Addr(null)
    comm = await dialIMAPViaSOCKS5(resolvedSocks, host, Number(port))
    reader = makeReader(comm)
    await reader.readLine(5000, 'greeting')
    comm.write(`A1 LOGIN "${username.replace(/"/g, '\\"')}" "${password.replace(/"/g, '\\"')}"\r\n`)
    if (!(await reader.readLine(5000, 'auth')).startsWith('A1 OK')) throw new Error('auth failed')
    comm.write('A2 SELECT INBOX\r\n')
    for (let i = 0; i < 10; i++) { const l = await reader.readLine(3000, 'sel'); if (l.startsWith('A2 ')) break }

    const uidSet = uids.slice(0, 20).join(',') // max 20 at once
    comm.write(`A4 FETCH ${uidSet} (BODY.PEEK[HEADER.FIELDS (SUBJECT FROM)])\r\n`)
    let raw = ''
    for (let i = 0; i < 50; i++) {
      const line = await reader.readLine(5000, `fetch${i}`)
      raw += line + '\n'
      if (line.startsWith('A4 ')) break
    }

    // Parse FETCH response into messages
    const messages = []
    const blocks = raw.split(/\* \d+ FETCH/).slice(1)
    for (const block of blocks) {
      const subjectMatch = block.match(/Subject:\s*(.+)/i)
      const fromMatch    = block.match(/From:\s*(.+)/i)
      const subject = subjectMatch ? subjectMatch[1].trim() : ''
      const fromRaw = fromMatch    ? fromMatch[1].trim()    : ''
      // Extract email from "Name <email>" or plain email
      const emailMatch = fromRaw.match(/<([^>]+)>/) || fromRaw.match(/([^\s@]+@[^\s@]+)/)
      const fromAddr = emailMatch ? emailMatch[1].toLowerCase() : fromRaw.toLowerCase()
      if (fromAddr) messages.push({ fromAddr, subject, snippet: '' })
    }
    return messages
  } finally {
    try { reader?.detach() } catch {}
    try { comm?.destroy() } catch {}
  }
}

// Fetch full headers of a single message by Message-ID via IMAP SEARCH.
// Returns the raw header block string, or null if not found.
async function imapFetchByMessageId(host, port, username, password, messageId, socksAddr) {
  let comm = null, reader = null
  const norm = s => s.replace(/"/g, '\\"')
  try {
    const resolvedSocks = socksAddr || await getMailboxSOCKS5Addr(null)
    comm = await dialIMAPViaSOCKS5(resolvedSocks, host, Number(port))
    reader = makeReader(comm)
    await reader.readLine(5000, 'greeting')
    comm.write(`A1 LOGIN "${norm(username)}" "${norm(password)}"\r\n`)
    if (!(await reader.readLine(6000, 'auth')).startsWith('A1 OK')) throw new Error('IMAP auth failed')
    comm.write('A2 SELECT INBOX\r\n')
    for (let i = 0; i < 12; i++) { const l = await reader.readLine(3000, 'sel'); if (l.startsWith('A2 ')) break }

    // SEARCH for the Message-ID (strip < > for HEADER search)
    const mid = messageId.trim()
    comm.write(`A3 SEARCH HEADER Message-ID "${norm(mid)}"\r\n`)
    let searchResp = ''
    for (let i = 0; i < 5; i++) {
      const l = await reader.readLine(5000, `search${i}`)
      searchResp += l + '\n'
      if (l.startsWith('A3 ')) break
    }
    const uidMatch = searchResp.match(/^\* SEARCH (.+)$/m)
    if (!uidMatch || !uidMatch[1].trim()) return null // not found
    const uid = uidMatch[1].trim().split(' ')[0]

    comm.write(`A4 FETCH ${uid} (BODY.PEEK[HEADER])\r\n`)
    let raw = ''
    for (let i = 0; i < 80; i++) {
      const l = await reader.readLine(5000, `fetch${i}`)
      raw += l + '\n'
      if (l.startsWith('A4 ')) break
    }
    // Extract header block between first { and the terminal line
    const headerMatch = raw.match(/\* \d+ FETCH \(BODY\[HEADER\] \{\d+\}\r?\n([\s\S]*?)\)\r?\nA4 /)
    return headerMatch ? headerMatch[1] : raw
  } finally {
    try { reader?.detach() } catch {}
    try { comm?.destroy() } catch {}
  }
}

// ── Create check cache tables once on startup ─────────────────────
await pool.query(`
  CREATE TABLE IF NOT EXISTS mailbox_check_cache (
    mailbox_id   INTEGER PRIMARY KEY REFERENCES outreach_mailboxes(id) ON DELETE CASCADE,
    checked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    score        INTEGER NOT NULL,
    ok           BOOLEAN NOT NULL,
    checks       JSONB NOT NULL,
    critical     TEXT[] DEFAULT '{}',
    warnings     TEXT[] DEFAULT '{}'
  );
  CREATE TABLE IF NOT EXISTS mailbox_check_history (
    id           SERIAL PRIMARY KEY,
    mailbox_id   INTEGER NOT NULL REFERENCES outreach_mailboxes(id) ON DELETE CASCADE,
    checked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    score        INTEGER NOT NULL,
    ok           BOOLEAN NOT NULL
  );
`).catch(() => {})

// ── Automation schema migration ───────────────────────────────────
await pool.query(`
  ALTER TABLE mailbox_check_history ADD COLUMN IF NOT EXISTS smtp_ok BOOLEAN;
  CREATE TABLE IF NOT EXISTS mailbox_imap_state (
    mailbox_id  INTEGER PRIMARY KEY REFERENCES outreach_mailboxes(id) ON DELETE CASCADE,
    unseen      INTEGER NOT NULL DEFAULT 0,
    prev_unseen INTEGER NOT NULL DEFAULT 0,
    polled_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ALTER TABLE mailbox_imap_state ADD COLUMN IF NOT EXISTS prev_unseen INTEGER NOT NULL DEFAULT 0;
  -- 27 track last processed UID per mailbox so reply-detection delta is
  -- robust against external mark-read races. count delta misses replies
  -- that arrive in same poll where another message was marked-read.
  ALTER TABLE mailbox_imap_state ADD COLUMN IF NOT EXISTS last_processed_uid INTEGER;
  ALTER TABLE mailbox_imap_state ADD COLUMN IF NOT EXISTS uid_validity INTEGER;
  ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS daily_cap_reduced_at TIMESTAMPTZ;
  ALTER TABLE send_events ADD COLUMN IF NOT EXISTS reply_classification TEXT;
  ALTER TABLE contacts ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
  ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_status TEXT DEFAULT 'unverified';
  ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
  ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_verification JSONB;
  ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_confidence INT;
  CREATE INDEX IF NOT EXISTS idx_contacts_email_status ON contacts (email_status);
  CREATE TABLE IF NOT EXISTS suppression_list (
    email        TEXT PRIMARY KEY,
    reason       TEXT NOT NULL DEFAULT 'negative_reply',
    suppressed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    mailbox_id   INTEGER REFERENCES outreach_mailboxes(id) ON DELETE SET NULL,
    contact_id   INTEGER REFERENCES contacts(id) ON DELETE SET NULL
  );
  -- KT-A13 — campaign_id + source carry the audit trail for ThreadDetail's
  -- explicit Unsubscribe action. Nullable so legacy rows keep working.
  ALTER TABLE suppression_list ADD COLUMN IF NOT EXISTS campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL;
  ALTER TABLE suppression_list ADD COLUMN IF NOT EXISTS source TEXT;
  ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS auth_fail_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS auth_fail_at TIMESTAMPTZ;
  ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS last_score INTEGER;
  ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS last_score_at TIMESTAMPTZ;
  ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS canary_remaining INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS circuit_opened_at TIMESTAMPTZ;
  ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ;
  ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS consecutive_bounces INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS status_reason TEXT;
  ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS last_canary_send TIMESTAMPTZ;
  ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS total_sent INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS total_bounced INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE IF NOT EXISTS mailbox_imap_circuit (
    mailbox_id    INTEGER PRIMARY KEY REFERENCES outreach_mailboxes(id) ON DELETE CASCADE,
    fail_count    INTEGER NOT NULL DEFAULT 0,
    open_until    TIMESTAMPTZ,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS mailbox_alerts (
    id          SERIAL PRIMARY KEY,
    mailbox_id  INTEGER NOT NULL REFERENCES outreach_mailboxes(id) ON DELETE CASCADE,
    type        TEXT NOT NULL,
    severity    TEXT NOT NULL DEFAULT 'warn',
    message     TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ
  );
  CREATE TABLE IF NOT EXISTS healing_log (
    id           SERIAL PRIMARY KEY,
    entity_type  TEXT NOT NULL,
    entity_id    BIGINT NOT NULL,
    entity_label TEXT,
    action       TEXT NOT NULL,
    reason       TEXT NOT NULL,
    resolved_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_healing_log_created ON healing_log (created_at DESC);
  CREATE TABLE IF NOT EXISTS reply_inbox (
    id             SERIAL PRIMARY KEY,
    send_event_id  INT UNIQUE REFERENCES send_events(id),
    campaign_id    INT,
    contact_id     INT,
    mailbox_id     INT,
    from_email     TEXT,
    subject        TEXT,
    classification TEXT,
    received_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    handled        BOOLEAN NOT NULL DEFAULT FALSE,
    handled_at     TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS idx_reply_inbox_handled ON reply_inbox (handled, received_at DESC);
  -- KT-B4: per-action capture of operator override on top of LLM/cron-set
  -- reply.classification. Mirror of migration 018 so dev DBs without the
  -- runner still get the table at boot.
  CREATE TABLE IF NOT EXISTS classifier_overrides (
    id                       SERIAL PRIMARY KEY,
    reply_id                 INT  NOT NULL,
    original_classification  TEXT,
    override_classification  TEXT NOT NULL,
    operator                 TEXT NOT NULL DEFAULT 'unknown',
    ts                       TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_classifier_overrides_ts ON classifier_overrides (ts DESC);
  CREATE INDEX IF NOT EXISTS idx_classifier_overrides_reply ON classifier_overrides (reply_id);
  CREATE TABLE IF NOT EXISTS watchdog_events (
    id          SERIAL PRIMARY KEY,
    check_name  TEXT NOT NULL,
    severity    TEXT NOT NULL DEFAULT 'info',
    entity_type TEXT,
    entity_id   BIGINT,
    message     TEXT NOT NULL,
    auto_healed BOOLEAN NOT NULL DEFAULT FALSE,
    healed_at   TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_watchdog_events_created ON watchdog_events (created_at DESC);
  ALTER TABLE watchdog_events ADD COLUMN IF NOT EXISTS event_type TEXT;
  ALTER TABLE watchdog_events ADD COLUMN IF NOT EXISTS mailbox_id INTEGER;
  ALTER TABLE watchdog_events ADD COLUMN IF NOT EXISTS reason TEXT;
  ALTER TABLE watchdog_events ADD COLUMN IF NOT EXISTS metadata JSONB;
  CREATE TABLE IF NOT EXISTS bff_boot_log (
    id             SERIAL PRIMARY KEY,
    started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    git_sha        TEXT,
    pid            INTEGER,
    guard_results  JSONB
  );
  CREATE INDEX IF NOT EXISTS idx_bff_boot_log_started ON bff_boot_log (started_at DESC);
  CREATE TABLE IF NOT EXISTS proxy_blacklist (
    proxy_addr      TEXT PRIMARY KEY,
    mailbox_id      INTEGER,
    blacklisted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL,
    reason          TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_proxy_blacklist_expires ON proxy_blacklist (expires_at);
  ALTER TABLE companies ADD COLUMN IF NOT EXISTS description_tags JSONB;
  ALTER TABLE companies ADD COLUMN IF NOT EXISTS sector_confidence FLOAT;
  ALTER TABLE companies ADD COLUMN IF NOT EXISTS nace_code TEXT;
  ALTER TABLE companies ADD COLUMN IF NOT EXISTS engagement_cluster TEXT;
  ALTER TABLE companies ADD COLUMN IF NOT EXISTS email_status TEXT DEFAULT 'unverified';
  ALTER TABLE companies ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
  ALTER TABLE companies ADD COLUMN IF NOT EXISTS email_verification JSONB;
  CREATE INDEX IF NOT EXISTS idx_companies_email_status ON companies (email_status);
  CREATE TABLE IF NOT EXISTS email_domains (
    domain TEXT PRIMARY KEY,
    mx_exists BOOLEAN,
    mx_host TEXT,
    is_catch_all BOOLEAN,
    is_disposable BOOLEAN,
    smtp_connectable BOOLEAN,
    checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS email_verification_log (
    id SERIAL PRIMARY KEY,
    company_ico TEXT,
    email TEXT NOT NULL,
    old_status TEXT,
    new_status TEXT NOT NULL,
    detail TEXT,
    trigger TEXT NOT NULL DEFAULT 'manual',
    verification JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_email_verif_log_ico ON email_verification_log (company_ico, created_at DESC);
  CREATE TABLE IF NOT EXISTS email_verify_queue (
    id SERIAL PRIMARY KEY,
    ico TEXT NOT NULL,
    email TEXT NOT NULL,
    retry_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    attempts INT NOT NULL DEFAULT 0,
    last_response TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(ico, email)
  );
  CREATE INDEX IF NOT EXISTS idx_email_verify_queue_retry ON email_verify_queue (retry_at);
  ALTER TABLE companies ADD COLUMN IF NOT EXISTS email_confidence INT;

  -- Sophisticated scoring (dashboard-owned, independent of Go's best_targeting_score)
  ALTER TABLE companies ADD COLUMN IF NOT EXISTS composite_score INT;
  ALTER TABLE companies ADD COLUMN IF NOT EXISTS score_tier TEXT;
  ALTER TABLE companies ADD COLUMN IF NOT EXISTS score_components JSONB;
  ALTER TABLE companies ADD COLUMN IF NOT EXISTS scored_at TIMESTAMPTZ;
  ALTER TABLE companies ADD COLUMN IF NOT EXISTS engagement_score REAL;
  CREATE INDEX IF NOT EXISTS idx_companies_composite_score ON companies (composite_score DESC NULLS LAST);
  CREATE INDEX IF NOT EXISTS idx_companies_score_tier ON companies (score_tier);

  CREATE TABLE IF NOT EXISTS scoring_config (
    id INT PRIMARY KEY DEFAULT 1,
    weights JSONB NOT NULL,
    version INT NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by TEXT,
    CHECK (id = 1)
  );
  INSERT INTO scoring_config (id, weights, version) VALUES (
    1,
    '{"icp":30,"email":20,"engagement":20,"size":10,"recency":10,"sector":10,"bounce_penalty":15,"unsub_penalty":25,"inactive_penalty":10,"free_webmail_penalty":5,"recency_halflife_days":30}'::jsonb,
    1
  ) ON CONFLICT (id) DO NOTHING;

  -- ── Enrichment pipeline ─────────────────────────────────────────
  -- Append-only fact store. Never UPDATE; query latest via DISTINCT ON
  -- in company_current_facts MV. parser_version bump = automatic
  -- reextraction without losing historical values.
  CREATE TABLE IF NOT EXISTS enrichment_sources (
    source              TEXT PRIMARY KEY,
    rate_limit_per_min  INT  NOT NULL DEFAULT 30,
    default_ttl_days    INT  NOT NULL DEFAULT 90,
    base_confidence     REAL NOT NULL DEFAULT 0.7,
    enabled             BOOLEAN NOT NULL DEFAULT TRUE,
    notes               TEXT
  );
  INSERT INTO enrichment_sources (source, rate_limit_per_min, default_ttl_days, base_confidence, notes) VALUES
    ('manual',     1000, 9999, 0.99, 'Operator-entered facts'),
    ('ares',       60,    365, 0.99, 'Czech registry baseline'),
    ('justice_cz', 30,    365, 0.95, 'Sbírka listin: revenue, statutáři'),
    ('vvz',        30,     90, 0.95, 'Vestnik veřejných zakázek'),
    ('mx_lookup',  60,    180, 0.90, 'MX/SPF/DMARC + WHOIS'),
    ('web_scrape', 20,     90, 0.55, 'Own website scraper'),
    ('katastr',    20,    365, 0.95, 'Real estate ownership signal')
  ON CONFLICT (source) DO NOTHING;

  CREATE TABLE IF NOT EXISTS company_facts (
    id              BIGSERIAL PRIMARY KEY,
    company_id      BIGINT NOT NULL,
    source          TEXT NOT NULL REFERENCES enrichment_sources(source) ON DELETE RESTRICT,
    field           TEXT NOT NULL,
    value           JSONB NOT NULL,
    base_confidence REAL NOT NULL,
    fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    ttl_days        INT,
    parser_version  TEXT
  );
  -- Idempotence: same (company, source, field) on same day = skip duplicate
  CREATE UNIQUE INDEX IF NOT EXISTS uq_company_facts_dedup
    ON company_facts (company_id, source, field, ((fetched_at AT TIME ZONE 'UTC')::date));
  CREATE INDEX IF NOT EXISTS idx_company_facts_lookup
    ON company_facts (company_id, field, fetched_at DESC);
  CREATE INDEX IF NOT EXISTS idx_company_facts_source_fetched
    ON company_facts (source, fetched_at DESC);

  CREATE TABLE IF NOT EXISTS enrichment_jobs (
    id            BIGSERIAL PRIMARY KEY,
    company_id    BIGINT NOT NULL,
    source        TEXT NOT NULL REFERENCES enrichment_sources(source) ON DELETE CASCADE,
    scheduled_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    status        TEXT NOT NULL DEFAULT 'pending',
    attempt       INT NOT NULL DEFAULT 0,
    last_error    TEXT,
    started_at    TIMESTAMPTZ,
    finished_at   TIMESTAMPTZ
  );
  -- Worker pulls oldest pending per source. SKIP LOCKED for safe parallelism.
  CREATE INDEX IF NOT EXISTS idx_enrichment_jobs_pull
    ON enrichment_jobs (source, status, scheduled_at)
    WHERE status = 'pending';
  CREATE INDEX IF NOT EXISTS idx_enrichment_jobs_company
    ON enrichment_jobs (company_id, source);
  -- Don't double-queue same (company, source) while pending/running.
  CREATE UNIQUE INDEX IF NOT EXISTS uq_enrichment_jobs_active
    ON enrichment_jobs (company_id, source)
    WHERE status IN ('pending', 'running');

  -- ── Materialized view: latest non-expired fact per (company, field) ──
  -- DISTINCT ON picks the freshest row per group when ordered by
  -- fetched_at DESC, base_confidence DESC. TTL applied via WHERE.
  -- Refresh CONCURRENTLY needs a unique index → uq_company_current_facts.
  CREATE MATERIALIZED VIEW IF NOT EXISTS company_current_facts AS
    SELECT DISTINCT ON (company_id, field)
      company_id, field, source, value, base_confidence, fetched_at,
      ttl_days, parser_version,
      (now() - fetched_at) AS age,
      CASE WHEN ttl_days IS NULL THEN NULL
           ELSE fetched_at + (ttl_days || ' days')::interval END AS expires_at
    FROM company_facts
    WHERE ttl_days IS NULL
       OR fetched_at + (ttl_days || ' days')::interval > now()
    ORDER BY company_id, field, fetched_at DESC, base_confidence DESC;
  CREATE UNIQUE INDEX IF NOT EXISTS uq_company_current_facts
    ON company_current_facts (company_id, field);
  CREATE INDEX IF NOT EXISTS idx_company_current_facts_field
    ON company_current_facts (field);
`).catch(e => console.error('[bootstrap] enrichment schema:', e.message))

async function logHealing(entityType, entityId, entityLabel, action, reason) {
  try {
    await pool.query(
      `INSERT INTO healing_log(entity_type, entity_id, entity_label, action, reason)
       VALUES($1,$2,$3,$4,$5)`,
      [entityType, entityId, entityLabel || null, action, reason]
    )
  } catch (e) {
    console.error('[healing] logHealing error:', e.message)
  }
}

// ── Shared: find and assign best proxy via SMTP AUTH probe ───────
async function assignBestProxy(mailboxId, attempts) {
  const { rows: mbRows } = await pool.query(
    `SELECT smtp_host, smtp_port, smtp_username, password FROM outreach_mailboxes WHERE id=$1`,
    [mailboxId]
  )
  if (!mbRows.length) return null
  const mb = mbRows[0]

  let pd = proxyCache
  if (!pd?.working?.length) pd = await getProxyPool()
  if (!pd?.working?.length) return null

  // Memoized last-known-working proxy for this mailbox skips the N-way probe
  // fan-out on the happy path. If the cached addr isn't in the current ranked
  // pool (pool refresh dropped it), we fall through to the normal ranking.
  const ranked = rankProxies(pd.working)
  const cachedAddr = authCache.get(mailboxId)
  let candidates = ranked
  if (cachedAddr) {
    const cached = ranked.find(c => c.addr === cachedAddr)
    if (cached) candidates = [cached, ...ranked.filter(c => c.addr !== cachedAddr)]
  }

  for (const candidate of candidates) {
    const probe = await smtpAuthProbe(candidate.addr, mb.smtp_host, mb.smtp_port, mb.smtp_username, mb.password)
    if (Array.isArray(attempts)) {
      attempts.push({ addr: candidate.addr, ok: probe.ok, ms: probe.ms ?? null, reason: probe.ok ? null : (probe.reason || 'unknown') })
    }
    if (probe.ok) {
      authCache.set(mailboxId, candidate.addr)
      const proxy_url = `socks5://${candidate.addr}`
      await pool.query('UPDATE outreach_mailboxes SET proxy_url=$1 WHERE id=$2', [proxy_url, mailboxId])
      console.log(`[automation] mailbox ${mailboxId} proxy reassigned → ${candidate.addr}`)
      return { proxy_url, latency_ms: probe.ms ?? candidate.probe_ms ?? null, country: candidate.country ?? 'CZ' }
    }
  }
  // No proxy passed AUTH — cache entry (if any) was stale.
  authCache.invalidate(mailboxId)
  if (Array.isArray(attempts) && attempts.length) {
    const summary = summarizeAttempts(attempts)
    console.warn(`[automation] mailbox ${mailboxId} no proxy passed AUTH: tried=${attempts.length} ${JSON.stringify(summary)}`)
  }
  return null
}

// ── Automation: apply rules after each full-check ────────────────
async function applyAutomationRules(mailboxId, checkResult) {
  try {
    const { rows: histRows } = await pool.query(
      `SELECT smtp_ok FROM mailbox_check_history WHERE mailbox_id=$1 ORDER BY checked_at DESC LIMIT 5`,
      [mailboxId]
    )
    const { rows: mbRows } = await pool.query(
      `SELECT id, status, status_reason, from_address, daily_cap_override, daily_cap_reduced_at,
              auth_fail_count, auth_fail_at, last_score, last_score_at, proxy_url
       FROM outreach_mailboxes WHERE id=$1`,
      [mailboxId]
    )
    if (!mbRows.length) return
    const mb = mbRows[0]

    const smtpChecks  = checkResult?.checks?.smtp
    const smtpOk      = smtpChecks?.ok === true
    const bounceCls   = checkResult?.checks?.bounce?.classification
    const currentScore = checkResult?.score ?? null

    // ── A-1: refresh stored pipeline result when SMTP just recovered ─
    // The /mailboxes "Pipeline" check shows the LAST persisted run from
    // mailbox_pipeline_results. After a creds/proxy fix the SMTP probe
    // turns green inside seconds but Pipeline keeps the old failure on
    // screen until the next manual /pipeline-test. Trigger one async.
    if (smtpOk && currentScore != null && currentScore >= 90) {
      const pipelineExisted = checkResult?.checks?.pipeline?.exists === true
      const pipelineWasOk = checkResult?.checks?.pipeline?.ok === true
      if (pipelineExisted && !pipelineWasOk) {
        setImmediate(() => runPipelineTest(mailboxId).catch(e =>
          console.error(`[automation] pipeline-rerun(${mailboxId}):`, e.message)
        ))
      }
    }

    // ── A: proxy auto-reassign when proxy check failed ─────────────
    if (checkResult?.checks?.proxy?.ok === false) {
      const currentProxy = mb.proxy_url
      setImmediate(() => proxyReassignGuard({
        mailboxId,
        err: new Error('ECONNREFUSED: full-check proxy probe failed'),
        proxyUrl: currentProxy,
        reason: 'full_check_proxy_fail',
      }).catch(e => console.error(`[automation] proxy-reassign(${mailboxId}):`, e.message)))
    }

    // ── A2: proactive proxy rotation when proxy is slow ────────────
    const proxyMs = checkResult?.checks?.proxy?.ms ?? 0
    if (checkResult?.checks?.proxy?.ok === true && proxyMs > 3000) {
      console.log(`[automation] mailbox ${mailboxId} proxy slow (${proxyMs}ms) — proactive rotation`)
      setImmediate(() => assignBestProxy(mailboxId).catch(e =>
        console.error(`[automation] proactive-proxy-rotate(${mailboxId}):`, e.message)
      ))
    }

    // ── Greylisting (451 / try-again-later) ───────────────────────
    // 451 is a temporary deferral — NOT an auth failure.  Do not increment
    // auth_fail_count; instead emit a warn alert and schedule a retry in 30 min.
    const greylistDetected = !smtpOk && isGreylisted(smtpChecks)
    if (greylistDetected) {
      await pool.query(
        `INSERT INTO mailbox_alerts(mailbox_id, type, severity, message)
         VALUES($1,'greylist_detected','warn','SMTP check deferred with 451 / greylist — auto-retry scheduled in 30 minutes')
         ON CONFLICT DO NOTHING`,
        [mailboxId]
      ).catch(() => {
        // Fallback without ON CONFLICT (older PG or no unique index on type)
        pool.query(
          `INSERT INTO mailbox_alerts(mailbox_id, type, severity, message)
           SELECT $1,'greylist_detected','warn','SMTP check deferred with 451 / greylist — auto-retry scheduled in 30 minutes'
           WHERE NOT EXISTS (
             SELECT 1 FROM mailbox_alerts
             WHERE mailbox_id=$1 AND type='greylist_detected' AND resolved_at IS NULL
           )`,
          [mailboxId]
        ).catch(() => {})
      })
      console.log(`[automation] mailbox ${mailboxId} greylisted (451) — skipping auth_fail_count increment, retry in 30 min`)
      // Fall through: skip auth circuit breaker entirely for this check.
      return
    }

    // ── AUTH circuit breaker ───────────────────────────────────────
    // Detect 535/auth_invalid errors in SMTP steps
    const smtpErrMsg = smtpChecks?.steps?.find(s => !s.ok)?.msg || ''
    const isAuthFail = classifySmtpError(smtpErrMsg) === 'auth_invalid' && !smtpOk
    if (isAuthFail) {
      const newCount = (Number(mb.auth_fail_count) || 0) + 1
      await pool.query(
        `UPDATE outreach_mailboxes SET auth_fail_count=$1, auth_fail_at=now() WHERE id=$2`,
        [newCount, mailboxId]
      )
      // AP6: record into mailbox_auth_fails; auto-quarantine at 3 fails/1h
      const authGuardResult = await recordAuthFail(pool, mailboxId, 'smtp_probe', smtpErrMsg, 'full_check').catch(e => {
        console.error(`[auth-guard] recordAuthFail(${mailboxId}):`, e.message)
        return null
      })
      if (authGuardResult?.quarantined) {
        await pool.query(
          `INSERT INTO mailbox_alerts(mailbox_id, type, severity, message) VALUES($1,'auth_locked','critical','Mailbox auto-locked: ${authGuardResult.fails_in_window} SMTP auth-fails in 1h — 24h cooldown before operator can unlock')`,
          [mailboxId]
        ).catch(() => {})
        console.log(`[automation] mailbox ${mailboxId} AUTH_LOCKED: ${authGuardResult.fails_in_window} fails in 1h window`)
        return
      }
      if (newCount >= 2 && mb.status === 'active') {
        await pool.query(
          `UPDATE outreach_mailboxes SET status='paused', status_reason='auto: auth_invalid — update credentials', auth_fail_count=0 WHERE id=$1`,
          [mailboxId]
        )
        await pool.query(
          `INSERT INTO mailbox_alerts(mailbox_id, type, severity, message) VALUES($1,'auth_failure','critical','SMTP authentication failed twice — credentials must be updated manually')`,
          [mailboxId]
        )
        console.log(`[automation] mailbox ${mailboxId} PAUSED: auth_invalid (2 consecutive failures)`)
        return
      }
    } else if (!isAuthFail && (Number(mb.auth_fail_count) || 0) > 0) {
      // Reset auth fail counter on success
      await pool.query(`UPDATE outreach_mailboxes SET auth_fail_count=0, auth_fail_at=NULL WHERE id=$1`, [mailboxId])
    }

    // ── D: bounce cap reduction ────────────────────────────────────
    const newCap = calcNewDailyCap(Number(mb.daily_cap_override || 100), bounceCls)
    if (newCap !== null) {
      const lastReduced = mb.daily_cap_reduced_at ? new Date(mb.daily_cap_reduced_at) : null
      const cooldownOk  = !lastReduced || (Date.now() - lastReduced.getTime()) > 23 * 60 * 60 * 1000
      if (cooldownOk) {
        await pool.query(
          `UPDATE outreach_mailboxes SET daily_cap_override=$1, daily_cap_reduced_at=now() WHERE id=$2`,
          [newCap, mailboxId]
        )
        console.log(`[automation] mailbox ${mailboxId} daily cap ${mb.daily_cap_override} → ${newCap} (bounce=${bounceCls})`)
        await logHealing('mailbox', mailboxId, mb.from_address, 'cap_reduced', `daily cap ${mb.daily_cap_override}→${newCap} (bounce=${bounceCls})`)
        if (bounceCls === 'critical') {
          await pool.query(
            `UPDATE mailbox_warmup SET is_paused=true, pause_reason='auto: critical bounce rate' WHERE mailbox_address=$1`,
            [mb.from_address]
          ).catch(() => {})
          console.log(`[automation] mailbox ${mailboxId} warmup paused (critical bounce)`)
        }
      }
    }

    // ── D2: bounce escalation — sustained warn × 3 → pause ─────────
    // Count consecutive warn-level bounce events from check history
    // We reuse the smtp_ok column as a proxy for "check was healthy enough to record bounce"
    // Store bounce escalation count in a simple query on consecutive cap reductions
    const { rows: capHist } = await pool.query(
      `SELECT daily_cap_reduced_at FROM outreach_mailboxes WHERE id=$1`, [mailboxId]
    )
    // Use auth_fail_count reuse pattern: track warn bounces in a separate approach
    // Simple: if bounceCls = warn AND daily_cap was already reduced (daily_cap_override < 80) AND still warn → escalate
    if (bounceCls === 'warn' && Number(mb.daily_cap_override || 100) <= 64 /* 100*0.8*0.8 = 64 = 2 reductions */ && mb.status === 'active') {
      await pool.query(
        `UPDATE outreach_mailboxes SET status='paused', status_reason='auto: sustained bounce warn — daily cap at floor', daily_cap_override=10 WHERE id=$1`,
        [mailboxId]
      )
      await pool.query(
        `INSERT INTO mailbox_alerts(mailbox_id, type, severity, message) VALUES($1,'bounce_escalation','warn','Bounce rate sustained at warn level — paused with cap=10, will auto-resume after 24h if rate recovers')`,
        [mailboxId]
      )
      console.log(`[automation] mailbox ${mailboxId} PAUSED: sustained bounce warn escalation`)
      await logHealing('mailbox', mailboxId, mb.from_address, 'bounce_pause', 'sustained bounce warn — cap at floor after 2 reductions')
    }

    // ── Score-trend alert ─────────────────────────────────────────
    if (currentScore !== null && mb.last_score !== null) {
      const delta = currentScore - Number(mb.last_score)
      if (delta <= -20) {
        await pool.query(
          `INSERT INTO mailbox_alerts(mailbox_id, type, severity, message) VALUES($1,'score_drop','warn',$2)`,
          [mailboxId, `Score dropped ${Math.abs(delta)} points (${mb.last_score} → ${currentScore})`]
        )
        console.log(`[automation] mailbox ${mailboxId} score drop alert: ${mb.last_score} → ${currentScore}`)
      }
    }
    if (currentScore !== null && currentScore >= 80) {
      await pool.query(
        `UPDATE mailbox_alerts SET resolved_at=now()
         WHERE mailbox_id=$1 AND type='score_drop' AND resolved_at IS NULL`,
        [mailboxId]
      ).catch(() => {})
    }
    if (currentScore !== null) {
      await pool.query(
        `UPDATE outreach_mailboxes SET last_score=$1, last_score_at=now() WHERE id=$2`,
        [currentScore, mailboxId]
      )
    }

    // ── Auto-pause on N consecutive SMTP failures (auth/tls only) ──
    // proxy_fail is transient (proxy rotates) — never count toward pause threshold.
    // auth_fail / tls_fail / unknown are persistent faults → pause as before.
    const smtpStepClassification = classifySmtpSteps(smtpChecks?.steps)
    const isProxyFail = !smtpOk && smtpStepClassification === 'proxy_fail'

    if (isProxyFail) {
      // Emit a warn alert so operators can see proxy churn, but do NOT increment
      // auth_fail_count and do NOT apply auto-pause logic.
      await pool.query(
        `INSERT INTO mailbox_alerts(mailbox_id, type, severity, message)
         VALUES($1,'proxy_fail','warn','SMTP check failed due to proxy connectivity — proxy rotation in progress, mailbox not paused')`,
        [mailboxId]
      ).catch(() => {})
      console.log(`[automation] mailbox ${mailboxId} proxy_fail — skipping auto-pause, alert emitted`)
    } else {
      const pauseDecision = shouldAutoPause(histRows)
      if (pauseDecision.pause && mb.status === 'active') {
        const pauseReason = smtpStepClassification === 'auth_fail'
          ? 'auto: 3 consecutive SMTP auth failures'
          : smtpStepClassification === 'tls_fail'
            ? 'auto: 3 consecutive SMTP TLS failures'
            : pauseDecision.reason
        await pool.query(
          `UPDATE outreach_mailboxes SET status='paused', status_reason=$1 WHERE id=$2`,
          [pauseReason, mailboxId]
        )
        console.log(`[automation] mailbox ${mailboxId} auto-paused: ${pauseReason}`)
        await logHealing('mailbox', mailboxId, mb.from_address, 'auto_pause', pauseReason)
        return
      }
    }

    // ── Auto-resume if previously auto-paused and SMTP now ok ─────
    if (shouldAutoResume(mb, checkResult)) {
      await pool.query(
        `UPDATE outreach_mailboxes SET status='active', status_reason=NULL WHERE id=$1`,
        [mailboxId]
      )
      console.log(`[automation] mailbox ${mailboxId} auto-resumed`)
      await logHealing('mailbox', mailboxId, mb.from_address, 'auto_resume', 'SMTP check passed after consecutive failures')
    }

    // ── Auto-resume bounce-escalation pause after 24h ─────────────
    if (mb.status === 'paused' && mb.status_reason === 'auto: sustained bounce warn — daily cap at floor') {
      const lastReduced = mb.daily_cap_reduced_at ? new Date(mb.daily_cap_reduced_at) : null
      const age24h = lastReduced && (Date.now() - lastReduced.getTime()) > 24 * 60 * 60 * 1000
      const bounceNowOk = !bounceCls || bounceCls === 'ok'
      if (age24h && bounceNowOk) {
        await pool.query(
          `UPDATE outreach_mailboxes SET status='active', status_reason=NULL WHERE id=$1`, [mailboxId]
        )
        console.log(`[automation] mailbox ${mailboxId} auto-resumed after bounce escalation cooldown`)
        await logHealing('mailbox', mailboxId, mb.from_address, 'auto_resume', 'bounce escalation cooldown elapsed, rate recovered')
      }
    }
  } catch (err) {
    console.error(`[automation] applyAutomationRules(${mailboxId}):`, err.message)
  }
}

// ── Health summary MUST be before /:id routes ─────────────────────
// ── SSE: per-mailbox health updates ────────────────────────────────
// Clients open EventSource('/api/mailboxes/health-stream') and receive a
// JSON `mailbox` event each time a /full-check writes a fresh cache row
// (or a background cron fires). The /health-summary 30s poll remains the
// fallback and the source of truth on first paint.
const healthStreamClients = new Set()
function publishHealthEvent(payload) {
  if (healthStreamClients.size === 0) return
  let line
  try {
    line = `event: mailbox\ndata: ${JSON.stringify(payload)}\n\n`
  } catch {
    return
  }
  for (const res of healthStreamClients) {
    try { res.write(line) } catch { /* client gone, swept by close handler */ }
  }
}
// ── SSE: real-time inbound thread events (mail-client S3.1) ──────────
// G3 (2026-05-03): extracted into src/server-routes/threads.js per ADR-008
// D2 module sequence. Owns its own threadStreamClients Set + lazy PG
// LISTEN client. Clients open EventSource('/api/threads/stream') and
// receive `inbound` events on PG NOTIFY thread_inbound (orchestrator
// RecordInbound). UI then refetches /api/threads/:id/messages (Go-proxy)
// to pull the new payload. UI's 30s polling fallback covers BFF restarts.
mountThreadsRoutes(app, { pool })
mountReplyTemplatesRoutes(app, { pool, capture500, safeError })
mountHaltAdvisoryRoutes(app, { pool, capture500, safeError })

// ── Attachment blob streaming (#874) ─────────────────────────────────────────
// GET /api/attachments/:id/blob — streams BYTEA from message_attachments.data.
// Auth is enforced by the global createAuthMiddleware() above. Content-Type is
// validated server-side: only image/* (excluding SVG) is served inline; all
// other types are forced to application/octet-stream for safe download.
mountAttachmentsRoutes(app, { pool, safeError })

// Sprint B2 (#1248) — generic per-message attachment streaming.
// GET /api/messages/:id/attachments/:idx routes by ID sign:
//   positive → message_attachments (matched thread)
//   negative → unmatched_inbound_attachments (orphan reply)
mountMessageAttachmentsRoutes(app, { pool, capture500, safeError })

// Sprint M1 (#1272) — read-only bounce stats per mailbox for the
// deliverability dashboard panel. UX/UI-first carve-out: read-only
// diagnostics are allowed before the UI surface lands.
mountMailboxBounceStatsRoutes(app, { pool, capture500, safeError })

// Sprint UX-4 — live bounce-rate warning banner. Scoped to TODAY
// (current calendar day) and using a tunable warn threshold (1.5%)
// so the operator sees risk BEFORE the 2% auto-pause floor fires.
// Sibling to M1 (M1 = rolling-window stats panel; UX-4 = today's at-risk
// snapshot for the banner above the Mailboxes list).
mountMailboxBounceWarningsRoutes(app, { pool, capture500, safeError })

// Sprint M2 (#1272) — per-mailbox spam complaint rate, sibling of M1.
// classification IN (negative, unsubscribe) on reply_inbox treated as
// the complaint signal until FBL reports are wired (separate work).
mountMailboxSpamComplaintStatsRoutes(app, { pool, capture500, safeError })

// Sprint M3 (#1272) — delivery-time histogram. Proxy for greylisting /
// deferral signals: sent_at - created_at on send_events. When recipient
// providers backpressure us, the relay's submit timestamp slides;
// >5% of sends in >5min bucket = reputation concern.
mountMailboxDeliveryTimeStatsRoutes(app, { pool, capture500, safeError })

// Sprint M4 (#1272) — blacklist alert UI aggregation. runBlacklistCheckCron
// already INSERTs mailbox_alerts where type='blacklist_hit'; this is the
// operator-facing read + resolve surface (per UX/UI-first T0).
mountMailboxBlacklistAlertsRoutes(app, { pool, capture500, safeError })

// Sprint Y7 — operator notification center. Aggregates mailbox_alerts +
// live auth_locked/bounce_hold state + computed bounce rate breaches into
// a single feed. Powers /notifications page + topbar bell + sidebar dot.
mountNotificationsRoutes(app, { pool, capture500, safeError })

// Sprint M5 (#1272) — composite reputation score 0-100 per mailbox.
// Weighted blend of M1-M4 signals (bounce 40% + spam 30% + delivery
// 15% + auth-lock 15%). Single sortable axis the operator can scan.
mountMailboxReputationScoreRoutes(app, { pool, capture500, safeError })

// Sprint M6 (#1272) — reputation history sparkline. 30-day trend per
// mailbox using same M5 weighting. Operator sees when reputations degrade.
mountMailboxReputationHistoryRoutes(app, { pool, capture500, safeError })

// Sprint M7 — real-time deliverability alert toasts via SSE.
// GET /api/alerts/stream — listens to pg_notify('mailbox_alert_fired')
// (migration 108) and fans out sanitised events to connected operator sessions.
// AlertToastListener.jsx subscribes on mount; visible on all dashboard pages.
mountAlertStreamRoutes(app, { pool, safeError })

// Sprint N2 — DNS audit script for SPF/DKIM/DMARC validation across all sending domains
mountDnsAuditRoutes(app, { db: pool, capture500, safeError })

// Sprint L2 (#1287) — per-template performance aggregation.
// GET /api/templates/metrics?window=7d|30d
// Sends + opens + replies + spam per template name; spam alert at 0.1%
// (matches M2 mailbox threshold). Drives the "Výkon šablon" panel in
// Analytics.jsx, positioned after M5 reputation card.
mountTemplateMetricsRoutes(app, { pool, capture500, safeError })

// FUN-1.4 — GET /api/funnel/summary?days=N&campaign_id=X&template_name=T
mountFunnelSummaryRoute(app, { pool, capture500, safeError })
mountScrapersRoutes(app)

// Sprint 2.2 — operator reply with attachments. Multipart parser
// (busboy) writes manual_reply_outbox + manual_reply_outbox_attachments;
// runOutboundReplyCron picks the row up and dispatches via relay.
mountReplyMultipartRoutes(app, { pool, capture500, safeError })

// Forward feature ("přeposlat") — POST /api/replies/:id/forward enqueues a
// kind='forward' manual_reply_outbox row (recipient override) that the
// outbound-reply dispatcher ships through the relay. Reuses the reply send
// path; no new relay client. (migration 175)
mountReplyForwardRoutes(app, { pool, capture500, safeError })

// ── AR11 — Bounce rate monitor status endpoint ────────────────────────────────
// GET /api/bounce-rate-monitor/status — operator visibility into per-mailbox 24h bounce rates.
mountBounceRateMonitor(app, pool)

// ── AS4 — Pool capacity operator endpoint ─────────────────────────────────────
// GET /api/relay/pool-capacity — pinned/pool_size ratio + per-endpoint detail.
mountPoolCapacityRoutes(app, pool)

// ── AW8-2 — Relay queue-depth observability proxy ────────────────────────────
// GET /api/relay/queue-depth — proxies anti-trace-relay /v1/status. Drives the
// RelayBackpressureBadge in the dashboard sidebar so the operator sees the
// AW4-2 backpressure cap (RELAY_MAX_QUEUE_DEPTH=100, PR #1193) approaching.
// AW8-3 also passes through retry_queue_depth (forward-compat with AW7-5).
mountRelayQueueDepthRoute(app)

// ── AW8-3 — Cycle-3 dashboard surfacing of backend hardening ─────────────────
// /api/audit/recent           → surfaces in_flight_reaped (AW7-3) + engine.panic_recovered (AW7-4)
// /api/failed-sends           → 7d send_events triage; reset endpoint flips cc_id back to pending
// /api/operator/api-key-status / rotate-api-key → audit-only key rotation acknowledgement
mountAuditRecentRoute(app, { pool, capture500, safeError })
mountFailedSendsRoutes(app, { pool, capture500, safeError })
mountOperatorRotateApiKeyRoutes(app, { pool, capture500, safeError })

app.get('/api/mailboxes/health-stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders?.()
  res.write(`event: hello\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`)
  healthStreamClients.add(res)
  // Heartbeat every 25s so proxies (Railway, Cloudflare) don't kill an
  // idle EventSource connection on their default 30-60s timeouts.
  const hb = setInterval(() => {
    try { res.write(`: hb ${Date.now()}\n\n`) } catch {}
  }, 25_000)
  req.on('close', () => {
    clearInterval(hb)
    healthStreamClients.delete(res)
  })
})

// ── KT-A11: Dashboard live metrics aggregator + SSE/polling endpoints ──
//
// Operator monitoring widgets need live globals (send_rate_60m, send_rate_6h,
// open_rate_24h) + per-active-campaign rows (reply_rate, send_rate_60m,
// last_event_at). Instead of every browser polling its own aggregate, the
// BFF runs ONE 10s tick that recomputes the snapshot and fans out to every
// SSE subscriber (and serves the same JSON over polling fallback).
//
// Design: docs/initiatives/2026-04-30-kt-a11-dashboard-widgets-design.md.
// The aggregator stays in BFF process memory (a Map snapshot). On boot, the
// snapshot is empty until first tick — endpoints return a "not ready" envelope
// rather than 503 so the operator UI can render skeletons.

const dashboardMetricsState = {
  snapshot: null,        // last computed payload
  lastTickAt: null,      // ms epoch of last successful tick
  lastError: null,       // last tick error (string or null)
  intervalId: null,      // setInterval handle
}
const dashboardMetricsClients = new Set()
const DASHBOARD_METRICS_TICK_MS = Number(process.env.DASHBOARD_METRICS_TICK_MS || 10_000)
const DASHBOARD_METRICS_HEARTBEAT_MS = Number(process.env.DASHBOARD_METRICS_HEARTBEAT_MS || 25_000)

async function computeDashboardMetricsSnapshot(poolRef = pool) {
  // Globals — send rate (60m / 6h) + open rate (24h) over the entire
  // outreach_messages + send_events tables. Cheap aggregates with FILTER.
  // Two queries (sends vs opens) run in parallel.
  const [sendRes, openRes, perCampaignRes, activeRes] = await Promise.all([
    poolRef.query(`
      SELECT
        count(*) FILTER (WHERE created_at > now() - interval '60 minutes')::int AS send_rate_60m,
        count(*) FILTER (WHERE created_at > now() - interval '6 hours')::int    AS send_count_6h
      FROM send_events
      WHERE status = 'sent'
    `),
    poolRef.query(`
      SELECT
        count(*) FILTER (WHERE opened_at IS NOT NULL AND sent_at > now() - interval '24 hours')::int AS opens_24h,
        count(*) FILTER (WHERE sent_at > now() - interval '24 hours')::int                          AS sends_24h
      FROM outreach_messages
    `),
    poolRef.query(`
      SELECT
        c.id   AS campaign_id,
        c.name AS campaign_name,
        c.status,
        COALESCE(SUM(CASE WHEN se.status='sent' AND se.created_at > now() - interval '60 minutes' THEN 1 ELSE 0 END), 0)::int AS send_rate_60m,
        COALESCE(SUM(CASE WHEN se.status='sent' THEN 1 ELSE 0 END), 0)::int     AS sent_total,
        COALESCE(SUM(CASE WHEN se.status='replied' THEN 1 ELSE 0 END), 0)::int  AS replied_total,
        COALESCE(SUM(CASE WHEN se.status='opened' THEN 1 ELSE 0 END), 0)::int   AS opened_total,
        MAX(se.created_at) AS last_event_at
      FROM campaigns c
      LEFT JOIN send_events se ON se.campaign_id = c.id
      WHERE c.status IN ('active','running')
      GROUP BY c.id, c.name, c.status
      ORDER BY last_event_at DESC NULLS LAST
      LIMIT 6
    `),
    poolRef.query(`SELECT count(*)::int AS n FROM campaigns WHERE status IN ('active','running')`),
  ])

  const send = sendRes.rows[0] || { send_rate_60m: 0, send_count_6h: 0 }
  const open = openRes.rows[0] || { opens_24h: 0, sends_24h: 0 }
  const sends24h = Number(open.sends_24h || 0)
  const opens24h = Number(open.opens_24h || 0)
  // Statistical-significance gate: under 10 sends, ratio is meaningless.
  const openRate24h = sends24h >= 10
    ? Math.round((opens24h / sends24h) * 1000) / 10
    : null

  const campaigns = perCampaignRes.rows.map((row) => {
    const sent = Number(row.sent_total || 0)
    const replied = Number(row.replied_total || 0)
    const opened = Number(row.opened_total || 0)
    return {
      id: row.campaign_id,
      name: row.campaign_name,
      status: row.status,
      send_rate_60m: Number(row.send_rate_60m || 0),
      reply_rate: sent > 0 ? Math.round((replied / sent) * 1000) / 10 : null,
      open_rate: sent > 0 ? Math.round((opened / sent) * 1000) / 10 : null,
      sent_total: sent,
      replied_total: replied,
      opened_total: opened,
      last_event_at: row.last_event_at ? new Date(row.last_event_at).toISOString() : null,
    }
  })

  return {
    generated_at: new Date().toISOString(),
    globals: {
      send_rate_60m: Number(send.send_rate_60m || 0),
      send_rate_6h_avg: Math.round(Number(send.send_count_6h || 0) / 6),
      open_rate_24h: openRate24h,
      sends_24h: sends24h,
      opens_24h: opens24h,
      active_campaigns: Number(activeRes.rows[0]?.n || 0),
    },
    campaigns,
  }
}

function publishDashboardMetricsEvent(eventType, payload) {
  if (dashboardMetricsClients.size === 0) return
  let line
  try {
    line = `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`
  } catch {
    return
  }
  for (const res of dashboardMetricsClients) {
    try { res.write(line) } catch { /* swept by close */ }
  }
}

async function tickDashboardMetrics() {
  try {
    const next = await computeDashboardMetricsSnapshot(pool)
    dashboardMetricsState.snapshot = next
    dashboardMetricsState.lastTickAt = Date.now()
    dashboardMetricsState.lastError = null
    publishDashboardMetricsEvent('snapshot', next)
  } catch (err) {
    dashboardMetricsState.lastError = err?.message || String(err)
    console.warn('[dashboard/metrics] tick failed:', dashboardMetricsState.lastError)
  }
}

function startDashboardMetricsAggregator() {
  if (dashboardMetricsState.intervalId) return
  // Kick off first snapshot synchronously-ish so the first SSE/polling
  // hit doesn't get a null payload. Errors swallowed (lastError preserved).
  tickDashboardMetrics().catch(() => {})
  dashboardMetricsState.intervalId = setInterval(() => {
    tickDashboardMetrics().catch(() => {})
  }, DASHBOARD_METRICS_TICK_MS)
  // unref so this interval doesn't block process exit during tests.
  if (dashboardMetricsState.intervalId.unref) {
    dashboardMetricsState.intervalId.unref()
  }
}

function stopDashboardMetricsAggregator() {
  if (dashboardMetricsState.intervalId) {
    clearInterval(dashboardMetricsState.intervalId)
    dashboardMetricsState.intervalId = null
  }
}

app.get('/api/dashboard/metrics', async (req, res) => {
  // Polling fallback. If aggregator hasn't completed first tick yet, run
  // one inline (cheap on cold start) so the operator never sees an empty
  // payload. Subsequent calls return cached snapshot.
  try {
    if (!dashboardMetricsState.snapshot) {
      const next = await computeDashboardMetricsSnapshot(pool)
      dashboardMetricsState.snapshot = next
      dashboardMetricsState.lastTickAt = Date.now()
    }
    res.json({
      ...dashboardMetricsState.snapshot,
      meta: {
        last_tick_at: dashboardMetricsState.lastTickAt
          ? new Date(dashboardMetricsState.lastTickAt).toISOString()
          : null,
        tick_interval_ms: DASHBOARD_METRICS_TICK_MS,
        source: 'polling',
      },
    })
  } catch (e) { capture500(res, e, safeError) }
})

app.get('/api/dashboard/metrics-stream', async (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders?.()
  // Initial snapshot — sync compute if aggregator hasn't ticked yet so the
  // first event reaches the client within ~100ms.
  if (!dashboardMetricsState.snapshot) {
    try {
      const next = await computeDashboardMetricsSnapshot(pool)
      dashboardMetricsState.snapshot = next
      dashboardMetricsState.lastTickAt = Date.now()
    } catch (err) {
      dashboardMetricsState.lastError = err?.message || String(err)
    }
  }
  if (dashboardMetricsState.snapshot) {
    res.write(`event: snapshot\ndata: ${JSON.stringify(dashboardMetricsState.snapshot)}\n\n`)
  } else {
    res.write(`event: hello\ndata: ${JSON.stringify({ at: new Date().toISOString(), pending: true })}\n\n`)
  }
  dashboardMetricsClients.add(res)
  // Ensure aggregator is running while at least one client is subscribed.
  startDashboardMetricsAggregator()
  // Heartbeat every 25s — keeps connection alive past Railway/Cloudflare
  // 30-60s idle timeouts. SSE comment line, not a named event.
  const hb = setInterval(() => {
    try { res.write(`: hb ${Date.now()}\n\n`) } catch {}
  }, DASHBOARD_METRICS_HEARTBEAT_MS)
  req.on('close', () => {
    clearInterval(hb)
    dashboardMetricsClients.delete(res)
  })
})

app.get('/api/mailboxes/health-summary', async (req, res) => {
  try {
    const { rows: mailboxes } = await pool.query(
      `SELECT id, from_address AS email FROM outreach_mailboxes WHERE status NOT IN ('retired', 'auth_locked') ORDER BY id`
    )
    const results = await Promise.all(mailboxes.map(async mb => {
      const { rows: cached } = await pool.query(
        `SELECT score, ok, critical FROM mailbox_check_cache WHERE mailbox_id=$1 AND checked_at > now() - interval '90 seconds'`,
        [mb.id]
      )
      if (cached.length) {
        return { id: mb.id, email: mb.email, score: cached[0].score, ok: cached[0].ok, critical: cached[0].critical }
      }
      // read fresh from cache (don't re-run full check in summary for perf)
      const { rows: any } = await pool.query(
        `SELECT score, ok, critical FROM mailbox_check_cache WHERE mailbox_id=$1`,
        [mb.id]
      )
      return {
        id: mb.id, email: mb.email,
        score: any[0]?.score ?? null,
        ok: any[0]?.ok ?? null,
        critical: any[0]?.critical ?? []
      }
    }))
    const total = results.length
    const healthy = results.filter(r => r.score != null && r.score >= 80).length
    const degraded = results.filter(r => r.score != null && r.score >= 50 && r.score < 80).length
    // critical = score < 50 (real problem). Null score is "not yet measured" or
    // mailbox is paused; treating null as critical generates phantom alerts
    // ("1 schránka potřebuje pozornost" when the only "unhealthy" row is a
    // paused test fixture). Operator already sees paused count separately.
    const criticalCount = results.filter(r => r.score != null && r.score < 50).length
    res.json({ total, healthy, degraded, critical: criticalCount, mailboxes: results })
  } catch (e) { capture500(res, e, safeError) }
})

// ── Per-mailbox send trends (for table sparklines) ────────────────
app.get('/api/mailboxes/send-trends', async (req, res) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days || 7), 1), 30)
    const { rows } = await pool.query(`
      SELECT
        m.id AS mailbox_id,
        TO_CHAR(DATE_TRUNC('day', se.sent_at), 'YYYY-MM-DD') AS day,
        COUNT(*)::int AS sent
      FROM outreach_mailboxes m
      JOIN send_events se ON se.mailbox_used = m.from_address
      WHERE se.sent_at > now() - ($1 || ' days')::interval
        AND se.status IN ('sent','opened','replied','bounced')
      GROUP BY m.id, 2
    `, [days])

    const byMailbox = {}
    for (const r of rows) {
      if (!byMailbox[r.mailbox_id]) byMailbox[r.mailbox_id] = {}
      byMailbox[r.mailbox_id][r.day] = r.sent
    }
    const result = {}
    for (const [mbId, dayMap] of Object.entries(byMailbox)) {
      const arr = []
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i)
        arr.push(dayMap[d.toISOString().slice(0, 10)] ?? 0)
      }
      result[mbId] = arr
    }
    res.json(result)
  } catch (e) { capture500(res, e, safeError) }
})

// ── Per-mailbox check endpoints ───────────────────────────────────
app.get('/api/mailboxes/:id/smtp-check', async (req, res) => {
  try {
    // AP3: rate limit — max 12 smtp_probe per mailbox per hour
    const rl = await checkOpRateLimit(pool, req.params.id, 'smtp_probe')
    if (!rl.allowed) {
      res.set('Retry-After', String(rl.retryAfterSec))
      return res.status(429).json({ error: 'rate_limit', op: 'smtp_probe', used: rl.used, max: rl.max, retryAfterSec: rl.retryAfterSec })
    }
    const { rows } = await pool.query(
      `SELECT smtp_host, smtp_port, smtp_username, password, proxy_url, COALESCE(preferred_country, '') AS preferred_country FROM outreach_mailboxes WHERE id=$1`,
      [req.params.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'not found' })
    const { smtp_host, smtp_port, smtp_username, password, preferred_country } = rows[0]
    if (!password) return res.json({ ok: false, ms: 0, steps: [{ name: 'auth_guard', ok: false, ms: 0, msg: 'SMTP credentials not configured' }] })
    // Sprint AO3: pass mailboxId + preferredCountry → relay routes via wgPool (same path as drain).
    const result = await smtpCheck(smtp_host, smtp_port, smtp_username, password, { mailboxId: String(req.params.id), preferredCountry: preferred_country || '' })
    res.json({ ok: result.ok, ms: result.ms, steps: result.steps })
  } catch (e) { capture500(res, e, safeError) }
})

app.get('/api/mailboxes/:id/imap-check', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT imap_host, imap_port, imap_username, smtp_username, password, preferred_country FROM outreach_mailboxes WHERE id=$1`,
      [req.params.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'not found' })
    const { imap_host, imap_port, imap_username, smtp_username, password, preferred_country } = rows[0]
    if (!imap_host) return res.json({ ok: false, ms: 0, steps: [], reason: 'no_imap_configured' })
    const username = imap_username || smtp_username
    // AO1: resolve SOCKS5 addr (wgpool) before dialling IMAP
    const socksAddr = await getMailboxSOCKS5Addr({ preferred_country })
    const result = await imapCheck(imap_host, imap_port || 993, username, password, socksAddr)
    // AP6: record auth fail if IMAP authentication failed (not a network/timeout error)
    if (!result.ok) {
      const failStep = result.steps?.find(s => !s.ok)
      const errMsg = failStep?.msg || result.error || 'imap_check_failed'
      const isAuthFail = /auth|login|535|534|AUTHENTICATIONFAILED|NO \[AUTHENTICATIONFAILED\]/i.test(errMsg)
      if (isAuthFail) {
        recordAuthFail(pool, req.params.id, 'imap_inbox_fetch', errMsg, 'bff_endpoint').catch(e =>
          console.error(`[auth-guard] imap-check recordAuthFail(${req.params.id}):`, e.message)
        )
      }
    }
    res.json({ ok: result.ok, ms: result.ms, steps: result.steps })
  } catch (e) { capture500(res, e, safeError) }
})

app.post('/api/mailboxes/:id/header-probe', async (req, res) => {
  try {
    const { message_id } = req.body || {}
    if (!message_id) return res.status(400).json({ error: 'message_id required' })
    const { rows } = await pool.query(
      `SELECT imap_host, imap_port, imap_username, smtp_username, password, preferred_country FROM outreach_mailboxes WHERE id=$1`,
      [req.params.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'not found' })
    const { imap_host, imap_port, imap_username, smtp_username, password, preferred_country } = rows[0]
    if (!imap_host) return res.status(422).json({ error: 'no_imap_configured' })
    const username = imap_username || smtp_username
    // AO1: resolve SOCKS5 addr (wgpool) before dialling IMAP
    const socksAddr = await getMailboxSOCKS5Addr({ preferred_country })
    const rawHeaders = await imapFetchByMessageId(imap_host, imap_port || 993, username, password, message_id, socksAddr)
    if (!rawHeaders) {
      return res.json({ score: 100, issues: [], safe: true, found: false, message_id })
    }
    const analysis = analyzeHeaderAnonymity(rawHeaders)
    res.json({ ...analysis, found: true, message_id, rawHeaders })
  } catch (e) { capture500(res, e, safeError) }
})

app.get('/api/mailboxes/:id/config-check', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT password, smtp_host, smtp_port, smtp_username, imap_host, imap_port, imap_username, daily_cap_override, proxy_url FROM outreach_mailboxes WHERE id=$1`,
      [req.params.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'not found' })
    const issues = parseConfigIssues(rows[0])
    const ok = !issues.some(i => i.severity === 'critical')
    res.json({ ok, issues })
  } catch (e) { capture500(res, e, safeError) }
})

app.get('/api/mailboxes/:id/warmup-status', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT m.id, m.from_address,
              w.warmup_day, w.is_paused, w.last_advanced_at, w.pause_reason
       FROM outreach_mailboxes m
       LEFT JOIN mailbox_warmup w ON w.mailbox_address=m.from_address
       WHERE m.id=$1`,
      [req.params.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'not found' })
    const r = rows[0]
    const active = r.warmup_day != null
    const stale = isWarmupStale(r.last_advanced_at)
    const ageMs = r.last_advanced_at ? Date.now() - new Date(r.last_advanced_at).getTime() : null
    const last_advanced_h = ageMs != null ? Math.round(ageMs / (60 * 60 * 1000) * 10) / 10 : null
    const ok = active && !r.is_paused && !stale
    res.json({ ok, active, day: r.warmup_day, paused: r.is_paused ?? false, stale, last_advanced_h, pause_reason: r.pause_reason ?? null })
  } catch (e) { capture500(res, e, safeError) }
})

app.get('/api/mailboxes/:id/bounce-status', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT consecutive_bounces, total_sent, total_bounced, status FROM outreach_mailboxes WHERE id=$1`,
      [req.params.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'not found' })
    const { consecutive_bounces, total_sent, total_bounced, status } = rows[0]
    const ts = Number(total_sent || 0)
    const tb = Number(total_bounced || 0)
    const rate = ts > 0 ? parseFloat(((tb / ts) * 100).toFixed(1)) : null
    const classification = classifyBounceHealth(rate, Number(consecutive_bounces || 0))
    const ok = classification === 'ok'
    res.json({ ok, classification, consecutive: Number(consecutive_bounces || 0), rate, total_sent: ts, total_bounced: tb, status })
  } catch (e) { capture500(res, e, safeError) }
})

app.get('/api/mailboxes/:id/send-rate', async (req, res) => {
  try {
    const { rows: mb } = await pool.query(
      `SELECT from_address, daily_cap_override, last_send_at FROM outreach_mailboxes WHERE id=$1`,
      [req.params.id]
    )
    if (!mb.length) return res.status(404).json({ error: 'not found' })
    const { from_address, daily_cap_override, last_send_at } = mb[0]
    // send_events uses mailbox_used (from_address) as the FK
    const { rows: cnt } = await pool.query(
      `SELECT COUNT(*)::int AS sent_today FROM send_events WHERE mailbox_used=$1 AND sent_at >= now()::date`,
      [from_address]
    )
    const sent_today = Number(cnt[0]?.sent_today || 0)
    const limit = Number(daily_cap_override || 100)
    const pct = limit > 0 ? Math.round((sent_today / limit) * 100) : 0
    const ok = sent_today < limit
    const last_send_age_h = last_send_at ? Math.round((Date.now() - new Date(last_send_at).getTime()) / (60 * 60 * 1000) * 10) / 10 : null
    res.json({ ok, sent_today, limit, pct, last_send_at: last_send_at ?? null, last_send_age_h })
  } catch (e) { capture500(res, e, safeError) }
})

app.get('/api/mailboxes/:id/pipeline-status', async (req, res) => {
  try {
    const { rows: mb } = await pool.query('SELECT id FROM outreach_mailboxes WHERE id=$1', [req.params.id])
    if (!mb.length) return res.status(404).json({ error: 'not found' })
    const { rows } = await pool.query(
      `SELECT overall_ok, tested_at FROM mailbox_pipeline_results WHERE mailbox_id=$1 ORDER BY tested_at DESC LIMIT 1`,
      [req.params.id]
    )
    if (!rows.length) {
      return res.json({ ok: false, exists: false, overall_ok: null, tested_at: null, age_h: null, stale: true })
    }
    const { overall_ok, tested_at } = rows[0]
    const { stale, ageH } = formatPipelineAge(tested_at)
    res.json({ ok: overall_ok && !stale, exists: true, overall_ok, tested_at, age_h: ageH, stale })
  } catch (e) { capture500(res, e, safeError) }
})

// ── Full check aggregate with cache ──────────────────────────────
app.get('/api/mailboxes/:id/full-check', async (req, res) => {
  const id = req.params.id
  const force = req.query.force === '1'

  try {
    // AP3 rate limit: max 2 full_check per mailbox per hour
    const rl = await checkOpRateLimit(pool, id, 'full_check')
    if (!rl.allowed) {
      res.set('Retry-After', String(rl.retryAfterSec))
      return res.status(429).json({ error: 'rate_limit', op: 'full_check', used: rl.used, max: rl.max, retryAfterSec: rl.retryAfterSec })
    }

    // Check cache (5 min TTL)
    if (!force) {
      const { rows } = await pool.query(
        `SELECT score, ok, checks, critical, warnings, checked_at FROM mailbox_check_cache WHERE mailbox_id=$1 AND checked_at > now() - interval '90 seconds'`,
        [id]
      )
      if (rows.length) {
        return res.json({ ...rows[0], cached: true, cached_at: rows[0].checked_at })
      }
    }

    // Verify mailbox exists
    const { rows: mb } = await pool.query(
      `SELECT id, smtp_host, smtp_port, smtp_username, imap_host, imap_port, imap_username,
              password, proxy_url, daily_cap_override, from_address, consecutive_bounces, total_sent, total_bounced,
              COALESCE(preferred_country, '') AS preferred_country
       FROM outreach_mailboxes WHERE id=$1`, [id]
    )
    if (!mb.length) return res.status(404).json({ error: 'not found' })
    const row = mb[0]

    // AO1: resolve SOCKS5 addr once (wgpool) for all IMAP checks in this full-check
    const imapSocks = row.imap_host ? await getMailboxSOCKS5Addr(row).catch(() => null) : null

    // Run checks in parallel
    // Sprint AO3: SMTP + IMAP probes now carry mailbox_id + preferred_country
    // so relay routes them via the same wgPool endpoint as drain. This eliminates
    // the multi-country signal (probe via BG/RO, drain via CZ) that caused
    // Seznam fraud-lock on nowak.gorak and similar mailboxes.
    const [smtpRes, imapRes, configRes, warmupRes, bounceRes, sendRateRes, pipelineRes, proxyRes] = await Promise.all([
      smtpCheck(row.smtp_host, row.smtp_port, row.smtp_username, row.password, { mailboxId: String(row.id), preferredCountry: row.preferred_country || '' })
        .then(r => ({ ok: r.ok, ms: r.ms, steps: r.steps }))
        .catch(e => ({ ok: false, error: e.message })),
      row.imap_host && imapSocks
        ? imapCheck(row.imap_host, row.imap_port || 993, row.imap_username || row.smtp_username, row.password, imapSocks)
            .then(r => {
              // Structural unreachable: relay's wgPool returns a container-local
              // loopback addr (127.0.0.1:108X) that is reachable inside the relay
              // container only. When BFF runs as a separate service, the TCP step
              // fails with ECONNREFUSED to that loopback. That is a routing-layer
              // limitation, not a mailbox health signal — degrade to null so it
              // is excluded from scoring instead of penalising the mailbox.
              const firstStep = Array.isArray(r.steps) && r.steps.length ? r.steps[0] : null
              const loopbackUnreachable = !r.ok && firstStep?.name === 'tcp' && /ECONNREFUSED\s+127\.0\.0\.1:/.test(firstStep.msg || '')
              if (loopbackUnreachable) return null
              return { ok: r.ok, ms: r.ms, steps: r.steps }
            })
            .catch(e => {
              if (/ECONNREFUSED\s+127\.0\.0\.1:/.test(e.message || '')) return null
              return { ok: false, error: e.message }
            })
        : null,
      Promise.resolve().then(() => {
        const issues = parseConfigIssues(row)
        return { ok: !issues.some(i => i.severity === 'critical'), issues }
      }),
      pool.query(
        `SELECT w.warmup_day, w.is_paused, w.last_advanced_at, w.pause_reason, w.plan_name
         FROM outreach_mailboxes m LEFT JOIN mailbox_warmup w ON w.mailbox_address=m.from_address WHERE m.id=$1`, [id])
        .then(({ rows }) => {
          if (!rows.length || rows[0].warmup_day == null) return { ok: false }
          const { warmup_day, is_paused, last_advanced_at, pause_reason, plan_name } = rows[0]
          const stale = isWarmupStale(last_advanced_at)
          const near_end = warmup_day != null && warmup_day > 25
          return { ok: !is_paused && !stale, stale, paused: is_paused, pause_reason, warmup_day, plan_name, near_end }
        }),
      Promise.resolve().then(() => {
        const ts = Number(row.total_sent || 0), tb = Number(row.total_bounced || 0)
        const insufficient_data = ts < 10
        const rate = ts > 0 ? parseFloat(((tb / ts) * 100).toFixed(1)) : null
        const cls = insufficient_data ? 'insufficient' : classifyBounceHealth(rate, Number(row.consecutive_bounces || 0))
        return { ok: insufficient_data || cls === 'ok', classification: cls, insufficient_data, rate, total_sent: ts }
      }),
      pool.query(
        `SELECT COUNT(*)::int AS sent_today FROM send_events
         WHERE mailbox_used=$1 AND sent_at >= (now() AT TIME ZONE $2)::date AND status = 'sent'`,
        [row.from_address, row.tz || 'Europe/Prague'])
        .then(({ rows }) => {
          const sent = Number(rows[0]?.sent_today || 0), limit = Number(row.daily_cap_override || 100)
          const near_limit = sent >= Math.floor(limit * 0.8)
          return { ok: sent < limit, sent_today: sent, limit, near_limit }
        }),
      pool.query(
        `SELECT overall_ok, tested_at, steps FROM mailbox_pipeline_results WHERE mailbox_id=$1 ORDER BY tested_at DESC LIMIT 1`,
        [id])
        .then(({ rows }) => {
          if (!rows.length) return { ok: false, exists: false }
          const { stale, warn, ageH } = formatPipelineAge(rows[0].tested_at)
          return { ok: rows[0].overall_ok && !stale, exists: true, stale, warn, age_h: ageH, steps: rows[0].steps }
        }),
      // Per-mailbox proxy check is now equivalent to relay-pool health (anti_trace
      // check below). The standalone "Proxy" row reflects whether the relay's
      // rotating pool has working candidates the SMTP probe could route through.
      Promise.resolve(null),
    ])

    const checks = {
      smtp: smtpRes,
      imap: imapRes,
      config: configRes,
      proxy: proxyRes,
      anti_trace: await (async () => {
        const snap = await relayProxyPool(pool)
        if (snap.error) return { ok: false, ms: 0, error: snap.error, working: 0, mode: snap.mode }
        const working = snap.working?.length ?? 0
        // Mullvad-only mode: empty working pool is healthy by design.
        const ok = snap.mode === 'mullvad' ? true : (working > 0 && !snap.error)
        return {
          ok,
          ms: 0,
          mode: snap.mode,
          working,
          cz_working: snap.cz_working ?? 0,
          last_refresh: snap.cached_at ?? null,
        }
      })(),
      warmup: warmupRes,
      bounce: bounceRes,
      send_rate: sendRateRes,
      pipeline: pipelineRes,
      dns: await Promise.race([
        runDNSCheck(row.smtp_host || '', 'default'),
        new Promise(resolve => setTimeout(() => resolve({ ok: null, timeout: true }), 5000)),
      ]),
    }

    const { score, critical, warnings } = buildFullCheckSummary(checks)
    const ok = critical.length === 0

    // ── DNS drift alert ───────────────────────────────────────────────
    if (checks.dns && checks.dns.ok === false && !checks.dns.timeout) {
      await pool.query(
        `INSERT INTO mailbox_alerts(mailbox_id, type, severity, message)
         SELECT $1,'dns_fail','warn',$2
         WHERE NOT EXISTS (
           SELECT 1 FROM mailbox_alerts
           WHERE mailbox_id=$1 AND type='dns_fail' AND resolved_at IS NULL
         )`,
        [id, `DNS check selhal: MX=${checks.dns.mx?.ok}, SPF=${checks.dns.spf?.ok}`]
      ).catch(() => {})
    }

    // Persist to cache + history
    const checked_at = new Date().toISOString()
    await pool.query(
      `INSERT INTO mailbox_check_cache(mailbox_id, checked_at, score, ok, checks, critical, warnings)
       VALUES($1, now(), $2, $3, $4, $5, $6)
       ON CONFLICT(mailbox_id) DO UPDATE SET checked_at=now(), score=$2, ok=$3, checks=$4, critical=$5, warnings=$6`,
      [id, score, ok, JSON.stringify(checks), critical, warnings]
    ).catch(() => {})
    const smtpOk = checks.smtp?.ok ?? null
    await pool.query(
      `INSERT INTO mailbox_check_history(mailbox_id, checked_at, score, ok, smtp_ok) VALUES($1, now(), $2, $3, $4)`,
      [id, score, ok, smtpOk]
    ).catch(() => {})

    applyAutomationRules(id, { score, ok, critical, checks }).catch(() => {})

    // SSE — push the per-mailbox update so the dashboard reacts instantly
    // instead of waiting for the 30s health-summary poll. Best-effort: any
    // serialization or send failure is swallowed (the polling fallback
    // covers stragglers).
    publishHealthEvent({ id: Number(id), email: row.from_address, score, ok, critical, checked_at })

    res.json({ score, ok, cached: false, cached_at: checked_at, checks, critical, warnings })
  } catch (e) { capture500(res, e, safeError) }
})

// ── Check history sparkline ───────────────────────────────────────
app.get('/api/mailboxes/:id/check-history', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT score, ok, checked_at FROM mailbox_check_history
       WHERE mailbox_id=$1 ORDER BY checked_at DESC LIMIT 14`,
      [req.params.id]
    )
    res.json(rows.reverse())
  } catch (e) { capture500(res, e, safeError) }
})

// ── IMAP inbox unread count ───────────────────────────────────────
app.get('/api/mailboxes/:id/imap-inbox', async (req, res) => {
  try {
    // AP3 rate limit: max 6 imap_inbox_fetch per mailbox per hour
    const rl = await checkOpRateLimit(pool, req.params.id, 'imap_inbox_fetch')
    if (!rl.allowed) {
      res.set('Retry-After', String(rl.retryAfterSec))
      return res.status(429).json({ error: 'rate_limit', op: 'imap_inbox_fetch', used: rl.used, max: rl.max, retryAfterSec: rl.retryAfterSec })
    }
    const { rows } = await pool.query(
      `SELECT imap_host, imap_port, imap_username, smtp_username, password, preferred_country FROM outreach_mailboxes WHERE id=$1`,
      [req.params.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'not found' })
    const { imap_host, imap_port, imap_username, smtp_username, password, preferred_country } = rows[0]
    if (!imap_host) return res.json({ ok: false, reason: 'no_imap', unseen: null })
    const username = imap_username || smtp_username
    // AO1: resolve SOCKS5 addr (wgpool) before dialling IMAP
    const socksAddr = await getMailboxSOCKS5Addr({ preferred_country })
    const unseen = await imapSearchUnseen(imap_host, Number(imap_port) || 993, username, password, socksAddr)
    res.json({ ok: true, unseen })
  } catch (e) { res.json({ ok: false, reason: e.message, unseen: null }) }
})

// ── POST /api/mailboxes/:id/refresh-imap — operator-triggered re-poll.
// P0 incident 2026-05-14: operator saw a reply in webmail.post.cz inbox
// for hozan.taher.75-78@post.cz but it was missing from /replies UI and
// unmatched_inbound. The 5-minute poll cron runs autonomously but there
// was no surface to force an immediate re-poll. This endpoint runs the
// same logic as runImapPollCron for ONE mailbox so operators don't have
// to wait the cron interval or ssh into Railway.
//
// Auth: same X-Confirm-Send: yes pattern as other mailbox state changes
// (clear-auth-lock). HARD rules satisfied:
//   - feedback_ux_ui_first T0: surface exists in BFF; UI button can wire to it
//   - feedback_audit_log_on_mutations T0: writes operator_audit_log
//   - feedback_no_pii_in_commands T0: mailbox addresses redacted in response/log
//   - feedback_external_io_backoff T0: relay client owns retry/backoff
app.post('/api/mailboxes/:id/refresh-imap', async (req, res) => {
  if (req.get('X-Confirm-Send') !== 'yes') {
    return res.status(400).json({ error: 'missing_confirmation', detail: 'X-Confirm-Send: yes header required' })
  }
  const mailboxId = Number(req.params.id)
  if (!Number.isInteger(mailboxId) || mailboxId <= 0) {
    return res.status(400).json({ error: 'invalid_id' })
  }
  try {
    // Single-mailbox pull mirroring runImapPollCron's per-row work.
    // Run-as-Operator: reuse the imported cron's helpers via direct
    // pool/relay calls to avoid pulling in the whole cron loop with its
    // 4h circuit-breaker semantics for a one-shot operator action.
    const { rows } = await pool.query(
      `SELECT m.id, m.from_address, m.imap_host, m.imap_port, m.imap_username, m.smtp_username, m.password, m.preferred_country,
              COALESCE(s.last_processed_uid, 0) AS prev_uid,
              s.uid_validity AS prev_uid_validity
       FROM outreach_mailboxes m
       LEFT JOIN mailbox_imap_state s ON s.mailbox_id=m.id
       WHERE m.id=$1 AND m.status NOT IN ('retired', 'auth_locked')`,
      [mailboxId]
    )
    if (!rows.length) return res.status(404).json({ error: 'mailbox_not_found_or_locked' })
    const row = rows[0]
    if (!row.imap_host) return res.status(400).json({ error: 'no_imap_configured' })

    const port = Number(row.imap_port) || 993
    const username = row.imap_username || row.smtp_username
    const watermark = (row.prev_uid_validity != null && row.prev_uid != null) ? Number(row.prev_uid) : 0

    const fetchRes = await relayImapFetch(pool, {
      mailboxAddress:   row.from_address,
      imapHost:         row.imap_host,
      imapPort:         port,
      username,
      password:         row.password,
      folder:           'INBOX',
      sinceUid:         watermark,
      includeBody:      true,
      limit:            30,
      preferredCountry: row.preferred_country || 'CZ',
    })

    if (!fetchRes.ok) {
      return res.status(502).json({ ok: false, error: fetchRes.error || 'relay_fetch_failed' })
    }

    const messages = fetchRes.messages || []
    const uidValidity = fetchRes.uid_validity || null
    const highestUid = messages.length > 0
      ? Math.max(...messages.map(m => Number(m.uid) || 0))
      : (row.prev_uid || null)

    // Persist state — same INSERT/UPDATE shape as the cron.
    await pool.query(
      `INSERT INTO mailbox_imap_state(mailbox_id, unseen, prev_unseen, last_processed_uid, uid_validity, polled_at)
       VALUES($1, $2, 0, $3, $4, now())
       ON CONFLICT(mailbox_id) DO UPDATE
         SET prev_unseen=mailbox_imap_state.unseen,
             unseen=$2,
             last_processed_uid=GREATEST(COALESCE(mailbox_imap_state.last_processed_uid, 0), COALESCE($3, 0)),
             uid_validity=$4,
             polled_at=now()`,
      [row.id, messages.length, highestUid, uidValidity]
    )

    // Forward to orchestrator /api/inbound for every fetched message
    // exactly as the cron does — bypasses the 5-min wait.
    const goUrl = process.env.GO_SERVER_URL || 'http://localhost:8080'
    const goKey = process.env.OUTREACH_API_KEY || ''
    let forwarded = 0
    const errors = []
    if (goUrl && goKey) {
      for (const m of messages) {
        if (!m.raw_body) continue
        try {
          const r = await fetch(`${goUrl.replace(/\/$/, '')}/api/inbound`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': goKey },
            body: JSON.stringify({
              mailbox_address: row.from_address,
              raw_body:        m.raw_body,
              received_at:     m.date || null,
              message_id:      m.message_id || '',
              in_reply_to:     m.in_reply_to || '',
              from:            m.from || '',
              subject:         m.subject || '',
            }),
            signal: AbortSignal.timeout(35_000),
          })
          if (!r.ok) {
            const t = await r.text().catch(() => '')
            errors.push({ uid: m.uid, status: r.status, body: t.slice(0, 200) })
          } else {
            forwarded += 1
          }
        } catch (e) {
          errors.push({ uid: m.uid, error: e?.message || 'unknown' })
        }
      }
    }

    // Audit log — operator-visible mutation.
    await pool.query(
      `INSERT INTO operator_audit_log(action, actor, entity_type, entity_id, details)
       VALUES('mailbox_refresh_imap', 'operator', 'mailbox', $1, $2::jsonb)`,
      [String(mailboxId), JSON.stringify({
        messages_fetched: messages.length,
        forwarded_to_orchestrator: forwarded,
        errors_count: errors.length,
        watermark_before: watermark,
        watermark_after: highestUid,
      })]
    ).catch(() => {})

    res.json({
      ok: true,
      messages_fetched: messages.length,
      forwarded_to_orchestrator: forwarded,
      errors,
      watermark_before: watermark,
      watermark_after: highestUid,
    })
  } catch (e) {
    Sentry.captureException(e, { tags: { component: 'refresh-imap', mailbox_id: String(mailboxId) } })
    res.status(500).json({ ok: false, error: e?.message || 'internal_error' })
  }
})

// ── Bulk assign proxy (each mailbox gets its own verified SMTP-auth proxy) ──
app.post('/api/mailboxes/bulk-assign-proxy', async (req, res) => {
  const { ids } = req.body
  const MAX_BULK_IDS = 50
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids required' })
  if (ids.length > MAX_BULK_IDS) return res.status(413).json({ error: 'too_many_ids', detail: `max ${MAX_BULK_IDS} ids per request`, received: ids.length })
  try {
    let pd = proxyCache
    if (!pd || !pd.working?.length) pd = await getProxyPool()
    if (!pd.working?.length) return res.status(503).json({ error: 'no working proxies available' })

    const ranked = rankProxies(pd.working)
    const results = []

    for (const id of ids) {
      const { rows: mbRows } = await pool.query(
        `SELECT smtp_host, smtp_port, smtp_username, password FROM outreach_mailboxes WHERE id=$1`, [id]
      )
      if (!mbRows.length) { results.push({ id, ok: false, error: 'not found' }); continue }
      const mb = mbRows[0]

      let chosen = null
      let chosenMs = null
      const attempts = []
      for (const candidate of ranked) {
        const probe = await smtpAuthProbe(candidate.addr, mb.smtp_host, mb.smtp_port, mb.smtp_username, mb.password)
        attempts.push({ addr: candidate.addr, ok: probe.ok, ms: probe.ms ?? null, reason: probe.ok ? null : (probe.reason || 'unknown') })
        if (probe.ok) { chosen = candidate; chosenMs = probe.ms ?? null; break }
      }
      if (!chosen) {
        const summary = summarizeAttempts(attempts)
        console.warn(`[bulk-assign-proxy] mailbox ${id} no proxy passed AUTH: tried=${attempts.length} ${JSON.stringify(summary)}`)
        results.push({ id, ok: false, error: 'no proxy passed SMTP AUTH', tried: attempts.length, summary, attempts })
        continue
      }

      const proxy_url = `socks5://${chosen.addr}`
      await pool.query('UPDATE outreach_mailboxes SET proxy_url=$1 WHERE id=$2', [proxy_url, id])
      results.push({ id: Number(id), ok: true, proxy_url, country: chosen.country, latency_ms: chosenMs })
    }
    res.json({ ok: true, results })
  } catch (e) { capture500(res, e, safeError) }
})

// ── Bulk full-check (async, results via health-summary) ───────────
app.post('/api/mailboxes/bulk-check', async (req, res) => {
  const { ids } = req.body
  const MAX_BULK_IDS = 100
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids required' })
  if (ids.length > MAX_BULK_IDS) return res.status(413).json({ error: 'too_many_ids', detail: `max ${MAX_BULK_IDS} ids per request`, received: ids.length })
  // Invalidate proxy cache so the fresh relay state is fetched during the
  // individual full-checks that follow — avoids serving a stale snapshot.
  invalidateProxyCache()
  res.json({ ok: true, triggered: ids.length })
  ;(async () => {
    const base = `http://localhost:${process.env.PORT || 18001}`
    for (const id of ids) {
      try { await fetch(`${base}/api/mailboxes/${id}/full-check?force=1`) } catch {}
    }
  })()
})

// ── Bulk pause (F5) ───────────────────────────────────────────
// Atomic pause of selected mailboxes. Requires X-Confirm-Send header
// to prevent accidental invocation. Emits operator_audit_log per mailbox.
app.post('/api/mailboxes/bulk-pause', async (req, res) => {
  const { ids } = req.body
  const confirm = req.headers['x-confirm-send'] === 'yes'
  if (!confirm) return res.status(400).json({ error: 'missing_confirmation', detail: 'X-Confirm-Send: yes header required' })

  const MAX_BULK_IDS = 100
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids required' })
  if (ids.length > MAX_BULK_IDS) return res.status(413).json({ error: 'too_many_ids', detail: `max ${MAX_BULK_IDS} ids per request`, received: ids.length })

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // Fetch current state of all mailboxes
    const { rows: mailboxes } = await client.query(
      'SELECT id, status FROM outreach_mailboxes WHERE id = ANY($1)',
      [ids]
    )

    // Only update those that are active
    const toUpdate = mailboxes.filter(m => m.status === 'active').map(m => m.id)
    if (toUpdate.length === 0) {
      await client.query('ROLLBACK')
      return res.json({ ok: true, paused: 0, skipped: mailboxes.length })
    }

    // Update all to paused in a single statement
    await client.query(
      'UPDATE outreach_mailboxes SET status = $1 WHERE id = ANY($2)',
      ['paused', toUpdate]
    )

    // Audit log each paused mailbox
    for (const mbId of toUpdate) {
      await client.query(
        `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
         VALUES ('mailbox_pause', 'dashboard', 'mailbox', $1, $2::jsonb)`,
        [String(mbId), JSON.stringify({ bulk_action: 'bulk_pause' })]
      )
    }

    await client.query('COMMIT')
    res.json({ ok: true, paused: toUpdate.length, skipped: mailboxes.length - toUpdate.length })
  } catch (e) {
    try { await client.query('ROLLBACK') } catch { /* ignored */ }
    capture500(res, e, safeError)
  } finally {
    client.release()
  }
})

// ── Bulk resume (F5) ───────────────────────────────────────────
// Atomic resume of selected mailboxes. Requires X-Confirm-Send header.
// Emits operator_audit_log per mailbox.
app.post('/api/mailboxes/bulk-resume', async (req, res) => {
  const { ids } = req.body
  const confirm = req.headers['x-confirm-send'] === 'yes'
  if (!confirm) return res.status(400).json({ error: 'missing_confirmation', detail: 'X-Confirm-Send: yes header required' })

  const MAX_BULK_IDS = 100
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids required' })
  if (ids.length > MAX_BULK_IDS) return res.status(413).json({ error: 'too_many_ids', detail: `max ${MAX_BULK_IDS} ids per request`, received: ids.length })

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // Fetch current state of all mailboxes
    const { rows: mailboxes } = await client.query(
      'SELECT id, status FROM outreach_mailboxes WHERE id = ANY($1)',
      [ids]
    )

    // Only update those that are paused
    const toUpdate = mailboxes.filter(m => m.status === 'paused').map(m => m.id)
    if (toUpdate.length === 0) {
      await client.query('ROLLBACK')
      return res.json({ ok: true, resumed: 0, skipped: mailboxes.length })
    }

    // Update all to active in a single statement
    await client.query(
      'UPDATE outreach_mailboxes SET status = $1 WHERE id = ANY($2)',
      ['active', toUpdate]
    )

    // Audit log each resumed mailbox
    for (const mbId of toUpdate) {
      await client.query(
        `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
         VALUES ('mailbox_resume', 'dashboard', 'mailbox', $1, $2::jsonb)`,
        [String(mbId), JSON.stringify({ bulk_action: 'bulk_resume' })]
      )
    }

    await client.query('COMMIT')
    res.json({ ok: true, resumed: toUpdate.length, skipped: mailboxes.length - toUpdate.length })
  } catch (e) {
    try { await client.query('ROLLBACK') } catch { /* ignored */ }
    capture500(res, e, safeError)
  } finally {
    client.release()
  }
})

// ── Anonymity probe (S15) ─────────────────────────────────────────
// Pošle testovací emaily přes aktivní schránky (ring topology) a po 30s
// čte hlavičky přijatých zpráv přes BFF IMAP endpoint pro analýzu anonymity.
// Poznámka: IMAP knihovna není v package.json — plný IMAP fetch je delegován
// na GET /api/mailboxes/:id/imap-inbox (existující BFF endpoint). Background
// worker zavolá tento endpoint pro každou recipient schránku a analyzuje headers.
app.post('/api/mailboxes/anonymity-probe', async (req, res) => {
  try {
    const { rows: mailboxes } = await pool.query(`
      SELECT id, from_address, smtp_host, smtp_port, smtp_username,
             password, imap_host, imap_port, imap_username
      FROM outreach_mailboxes
      WHERE status = 'active' AND imap_host IS NOT NULL AND status NOT IN ('auth_locked')
      ORDER BY id
    `)

    if (mailboxes.length < 2) {
      return res.status(400).json({ error: 'Potřeba alespoň 2 aktivní schránky s IMAP konfigurací' })
    }

    const probeId = `Anonymity-Probe-${Date.now()}`
    const sentAt = new Date().toISOString()
    const results = []

    // Ring topology: každá schránka pošle email na další (i → i+1 mod n)
    const relayBase = process.env.ANTI_TRACE_RELAY_URL_OVERRIDE
      || process.env.ANTI_TRACE_RELAY_URL
    const relayToken = process.env.ANTI_TRACE_RELAY_TOKEN || ''

    for (let i = 0; i < mailboxes.length; i++) {
      const sender = mailboxes[i]
      const recipient = mailboxes[(i + 1) % mailboxes.length]

      let sent = false
      let envelopeId = null
      let sendError = null

      if (!relayBase) {
        sendError = 'relay_not_configured'
      } else {
        try {
          const relayHeaders = { 'Content-Type': 'application/json' }
          if (relayToken) relayHeaders['Authorization'] = `Bearer ${relayToken}`

          const sendResp = await fetch(`${relayBase}/v1/submit`, {
            method: 'POST',
            headers: relayHeaders,
            body: JSON.stringify({
              recipient: recipient.from_address,
              subject: probeId,
              body: `Anonymity probe od ${sender.from_address} v ${sentAt}`,
              // Probe is plain-text only by design (audit signal must not vary).
              // body_html intentionally empty — audit ratchet
              // tests/audit/no_partial_relay_submit.test.js enforces presence
              // of the key, not non-empty content.
              body_html: '',
              from_address: sender.from_address,
              smtp_host: sender.smtp_host,
              smtp_port: sender.smtp_port,
              smtp_username: sender.smtp_username,
              smtp_password: sender.password,
              // Probe doesn't require Sent APPEND (synthetic, no operator
              // visibility need). imap_host/imap_port intentionally absent in
              // value, present in key per audit ratchet.
              imap_host: sender.imap_host || '',
              imap_port: sender.imap_port || 0,
            }),
            signal: AbortSignal.timeout(30_000),
          })
          const sendBody = await sendResp.json().catch(() => ({}))
          if (sendResp.ok) {
            sent = true
            envelopeId = sendBody.envelope_id || null
          } else {
            sendError = sendBody.error || `HTTP ${sendResp.status}`
          }
        } catch (e) {
          sendError = e.message || String(e)
        }
      }

      results.push({
        sender: sender.from_address,
        recipient: recipient.from_address,
        recipient_id: recipient.id,
        sent,
        envelope_id: envelopeId,
        send_error: sendError,
        anonymity: null, // doplněno background workerem
      })
    }

    // Odpověď odeslána okamžitě — IMAP fetch probíhá na pozadí
    res.json({
      ok: true,
      probe_id: probeId,
      sent_at: sentAt,
      mailbox_count: mailboxes.length,
      results,
      note: 'Emaily odeslány. Zavolej GET /api/mailboxes/anonymity-probe/results?probe_id=<id> po 30s pro výsledky analýzy.',
    })

    // Background: po 30s načti IMAP každé recipient schránky a analyzuj headers
    setTimeout(async () => {
      const base = `http://localhost:${process.env.PORT || 18001}`
      for (const result of results) {
        if (!result.sent) continue
        try {
          const imapResp = await fetch(`${base}/api/mailboxes/${result.recipient_id}/imap-inbox`, {
            signal: AbortSignal.timeout(20_000),
          })
          if (!imapResp.ok) continue
          const imapBody = await imapResp.json().catch(() => null)
          if (!imapBody?.ok || !Array.isArray(imapBody.messages)) continue

          // Najdi zprávu matchující probe_id (subject)
          const msg = imapBody.messages.find(m => m.subject?.includes(probeId))
          if (!msg?.headers) {
            console.log(`[anonymity-probe] ${probeId} — zpráva nenalezena v IMAP pro ${result.recipient}`)
            continue
          }

          const analysis = analyzeAnonymity(msg.headers)
          result.anonymity = analysis
          console.log(`[anonymity-probe] ${result.sender} → ${result.recipient}: score=${analysis.score}, leaks=${analysis.leaks.join(',')||'none'}`)
        } catch (e) {
          console.warn(`[anonymity-probe] IMAP fetch failed pro ${result.recipient}: ${e.message}`)
        }
      }
      console.log(`[anonymity-probe] ${probeId} — analýza dokončena`)
    }, 30_000)

  } catch (e) { capture500(res, e, safeError) }
})

// ── Anonymity probe výsledky ──────────────────────────────────────
// In-memory cache výsledků není k dispozici přes GET — výsledky jsou logovány
// do konzole. Pro production by se ukládaly do DB/Redis.

// CSV import endpoint deleted — operator adds mailboxes one-at-a-time via
// the dashboard "Přidat schránku" modal. Bulk import isn't part of the
// 4-mailbox warmup flow and the textarea-paste UI was never used.

// ── Suppression list ──────────────────────────────────────────────
// ── Contacts ──────────────────────────────────────────────────────
// D2.9 (2026-05-02): all 5 /api/contacts/* handlers extracted into
// ./src/server-routes/contacts.js per ADR-008 D2 module sequence.
// Behavior is byte-equivalent — same SQL, response shape, Sentry capture,
// and Express ordering. Helpers (verifyEmail pipeline, domainCache,
// _domainProbeLock, DOMAIN_RATE_MS) stay in server.js because the same
// SMTP probe pipeline is also called from /api/companies/:ico/verify-email
// + the full-check / greylist crons. Tests inject mocks via deps.
mountContactsRoutes(app, {
  pool,
  capture500,
  safeError,
  suppressionExistsFor,
  verifyEmail,
  domainCache,
  domainProbeLock: _domainProbeLock,
  DOMAIN_RATE_MS,
  checkOpRateLimit,
})
// Story LXY (2026-05-28) — live activity ticker on Home (real-time PROD signals).
mountDashboardLiveActivityEndpoint(app, { pool, capture500 })

// ── Suppression (GDPR/CAN-SPAM block list) ────────────────────────
// F3 (2026-05-03): all 4 /api/suppression* handlers extracted to
// ./src/server-routes/suppression.js per ADR-008 D2 module sequence.
// Behavior is byte-equivalent to the inline declarations: same SQL
// (UNION ALL across suppression_list + outreach_suppressions), same
// response shape, same Sentry capture. Email normalization (lowercase
// + trim) preserved at every write boundary per memory
// `project_two_suppression_tables` T1.
mountSuppressionRoutes(app, { pool, capture500, safeError })

// ── Leads (sales-qualified replies) ───────────────────────────────
// T3.7 (2026-05-01): handlers extracted to ./src/server-routes/leads.js per
// ADR-008 D2. Backed by the `leads` table extended in migration 009.
// Populated by services/orchestrator/thread/inbound.go upsertLead() when
// the reply classifier returns 'interested' or 'meeting'.
mountLeadsRoutes(app, { pool, capture500, safeError })

// ── CRM clients (eWAY import + freshness monitoring) ────────────────
// CRM-7 (2026-05-05): handlers for paginated list + detail + stats + freshness.
// GET /api/crm/clients/freshness reports last import timestamp (operator audit log).
mountCrmRoutes(app, { pool, setRouteTags, capture500, safeError })

// AP1 — Helper: seconds from now until Prague midnight (for Retry-After header).
function secondsToMidnightPrague() {
  const now = new Date()
  // Next Prague midnight = today's date string at T00:00:00 in Prague + 1 day
  const pragueDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Prague' }).format(now)
  const pragueToday = new Date(`${pragueDate}T00:00:00`)
  // pragueToday is midnight at local timezone; convert to actual midnight Prague UTC
  const pragueOffset = new Intl.DateTimeFormat('en', {
    timeZone: 'Europe/Prague', timeZoneName: 'longOffset',
  }).formatToParts(now).find(p => p.type === 'timeZoneName')?.value
  // Compute offset in ms from UTC+HH:MM notation
  const offsetMatch = (pragueOffset || '+00:00').match(/([+-])(\d{2}):(\d{2})/)
  const offsetMs = offsetMatch
    ? (offsetMatch[1] === '+' ? 1 : -1) * (Number(offsetMatch[2]) * 60 + Number(offsetMatch[3])) * 60000
    : 0
  const midnightUTC = new Date(pragueToday.getTime() - offsetMs + 24 * 60 * 60 * 1000)
  return Math.max(1, Math.ceil((midnightUTC.getTime() - now.getTime()) / 1000))
}

// ── Send test message between mailboxes ───────────────────────────
app.post('/api/mailboxes/:id/send-test', async (req, res) => {
  try {
    const { to, subject, text, port: portOverride } = req.body
    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!to || typeof to !== 'string' || !EMAIL_RE.test(to.trim())) {
      return res.status(400).json({ error: 'invalid_email', detail: 'to must be a valid email address' })
    }

    // Send window guard (bypass with ?force=1 for manual tests)
    const force = req.query.force === '1'
    if (!force && !isWithinSendWindow(new Date(), 'Europe/Prague')) {
      return res.status(425).json({ ok: false, error: 'Mimo send window (Po–Pá 8–17). Použij ?force=1 pro manuální test.' })
    }

    // Suppression check — must mirror the Go runner's UNION filter so
    // the dashboard send-test cannot bypass an automated suppression that
    // came from the reply classifier or bounce cascade.
    const { rows: suppRows } = await pool.query(SUPPRESSION_LOOKUP_SQL, [to])
    if (suppRows.length) {
      return res.status(400).json({ ok: false, error: `${to} je na suppression listu.` })
    }

    // Rate limit check — skip if ?force=1
    // AP1: uses compute_daily_cap(lifecycle_phase, daily_cap_override) to enforce
    // warmup ramp (Day0=5, Day3=10, Day7=25, Day14=50, Day30+=100).
    if (!force) {
      const { rows: rateRows } = await pool.query(
        `SELECT m.lifecycle_phase,
                m.daily_cap_override,
                compute_daily_cap(m.lifecycle_phase, m.daily_cap_override) AS effective_cap,
                COUNT(se.id) FILTER (WHERE se.status IN ('sent','queued'))::int AS sent_today
         FROM outreach_mailboxes m
         LEFT JOIN send_events se ON se.mailbox_used=m.from_address
           AND se.sent_at >= (now() AT TIME ZONE 'Europe/Prague')::date
         WHERE m.id=$1
         GROUP BY m.id`,
        [req.params.id]
      )
      if (rateRows.length) {
        const { lifecycle_phase, effective_cap, sent_today } = rateRows[0]
        const cap = Number(effective_cap)
        if (sent_today >= cap) {
          const retryAfter = secondsToMidnightPrague()
          return res.status(429).set('Retry-After', String(retryAfter)).json({
            ok: false,
            error: 'warmup_cap_exceeded',
            detail: { phase: lifecycle_phase, sent_today, cap },
            retry_after_s: retryAfter,
          })
        }
      }
    }

    // Sprint AO6: smtpSendWithFallback always routes via relay /v1/submit.
    // proxy_url column is no longer read for send routing (deprecated, migration 077).
    const { rows } = await pool.query(
      `SELECT from_address AS email, smtp_host AS host, smtp_port AS port,
              smtp_username, password, COALESCE(preferred_country,'') AS preferred_country
       FROM outreach_mailboxes WHERE id=$1`,
      [req.params.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'not found' })
    const mb = rows[0]

    try {
      const result = await smtpSendWithFallback(Number(req.params.id), {
        host:             mb.host,
        port:             portOverride || mb.port,
        username:         mb.smtp_username || mb.email,
        password:         mb.password,
        from:             mb.email,
        to,
        subject:          subject || 'Test',
        text:             text    || 'Test.',
        preferredCountry: mb.preferred_country,
      })
      res.json({ ...result, from: mb.email, to, via: 'anti-trace-relay' })
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message, via: 'anti-trace-relay' })
    }
  } catch (e) { capture500(res, e, safeError) }
})

// G1 Batch A (2026-05-03): /api/mailboxes/:id/alerts (GET) and
// /api/mailboxes/:id/alerts/:alertId/resolve (PATCH) extracted into
// src/server-routes/mailboxes.js.

// ── Cron engine ───────────────────────────────────────────────────

// runFullCheckCron removed — CAD-S8 / issue #539.
// Scoring loop (last_score / last_score_at) moved to Go orchestrator:
// services/orchestrator/intelligence/mailbox_score_loop.go
// Runs 24/7 on Railway; no longer depends on pnpm dev being active.

// Fast cache-freshness daemon — every 60s, re-runs full-check for any
// mailbox whose cache is older than 90s. Pairs with the 90s mailbox_check_cache
// TTL: the UI never sees a "stale-by-cache-miss" gap because background
// refresh fills the cache between user-driven /health-summary fetches.
// E1: body extracted to src/crons/runStaleHealthCheckCron.js
function runStaleHealthCheckCron() {
  return _runStaleHealthCheckCron(pool, { checkOpRateLimit })
}

// Track B (M+3) — reply→AI suggestion pipeline.
//
// When the IMAP poller surfaces a new inbound reply, we hand the recent
// thread context to services/llm-runner /v1/generate and write the
// resulting draft into ai_suggestion_audit with operator_action='pending'.
// The operator approval queue (GET /api/operator/queue) reads exactly
// those rows.
//
// Fail-open semantics:
//   - LLM_RUNNER_URL unset / unreachable / non-2xx / timeout / parse error
//     → INSERT row with ai_suggestion='' (kept NOT NULL by schema 019) +
//       details.llm_error so the operator can still see "a reply landed
//       but no draft was generated" in the queue. Reply ingestion is
//       NEVER blocked on LLM availability.
//   - Returning early on missing thread_id is fine — the row records the
//     pipeline event regardless; the operator can dispatch from there.
//
// Memory rules:
//   feedback_no_external_services — Ollama (self-hosted) only; no cloud.
//   feedback_no_speculation — fields lifted from llm-runner ADR-006 §D2
//     contract definition + migration 019 column shape.
// AV-F4 (2026-05-19): callLlmRunnerGenerate moved to
// apps/outreach-dashboard/src/lib/llmRunnerClient.js so the reply classifier
// (AV-F4) and reply-draft pipeline (Track B M+3) share the same Ollama
// fetch wiring. Imported at top of file.
void LLM_RUNNER_TIMEOUT_MS

async function generateAiSuggestionForReply({ contactId, campaignId, fromAddr, subject }) {
  // Resolve the thread_id for this (contact, campaign) pair. The
  // orchestrator's RecordInbound creates a thread row when an inbound
  // lands; we look up the most recent open one. Returning early on
  // miss is acceptable — the pipeline ratchet records the row only
  // when a thread context exists.
  const { rows: threadRows } = await pool.query(
    `SELECT id FROM outreach_threads
      WHERE contact_id = $1 AND campaign_id = $2
      ORDER BY id DESC LIMIT 1`,
    [contactId, campaignId]
  ).catch(() => ({ rows: [] }))
  const threadId = threadRows[0]?.id || null

  // Pull thread history for the LLM prompt. Best-effort: missing rows
  // just yield an empty history — the LLM can still draft from subject.
  let threadHistory = []
  if (threadId) {
    const { rows } = await pool.query(
      `SELECT direction, COALESCE(body_text, body_preview, '') AS body, replied_at, sent_at
         FROM outreach_messages
        WHERE thread_id = $1
        ORDER BY COALESCE(replied_at, sent_at) ASC
        LIMIT 20`,
      [threadId]
    ).catch(() => ({ rows: [] }))
    threadHistory = rows.map(r => ({
      direction: r.direction,
      body: r.body || '',
      at: r.replied_at || r.sent_at,
    }))
  }

  const llm = await callLlmRunnerGenerate({
    thread_history: threadHistory,
    operator_hint: subject || '',
    category: 'reply_draft',
  })

  // Insert the audit row. NOT NULL on ai_suggestion → use empty string
  // when the LLM declined; details captures the reason for ops debugging.
  const aiSuggestion = (llm.ok && typeof llm.draft === 'string') ? llm.draft : ''
  const confidence = llm.ok && llm.confidence != null
    ? Math.max(0, Math.min(1, llm.confidence))
    : null

  const details = {
    source: 'imap_poll_pipeline',
    from_email: fromAddr || null,
    inbound_subject: subject || null,
  }
  if (!llm.ok) {
    details.llm_error = llm.reason
  } else {
    if (llm.model) details.llm_model = llm.model
    if (llm.tokens_used != null) details.llm_tokens_used = llm.tokens_used
  }

  try {
    await pool.query(
      `INSERT INTO ai_suggestion_audit
         (thread_id, ai_suggestion, operator_action, confidence_score, details)
       VALUES ($1, $2, 'pending', $3, $4::jsonb)`,
      [threadId, aiSuggestion, confidence, JSON.stringify(details)]
    )
  } catch (e) {
    // Migration 019/020 not applied on dev DB — log and swallow so reply
    // ingestion proceeds. Production deploy gates on migration status.
    console.warn('[ai-suggestion] insert failed:', e?.message)
    return { ok: false, reason: e?.message || 'insert failed' }
  }
  return { ok: true, llm_ok: llm.ok, thread_id: threadId }
}

// Sprint 2.1 (mail-client) — manual_reply_outbox worker.
//
// Picks rows where sent_at IS NULL, looks up the original reply
// (reply_inbox → send_event → contact → mailbox), builds a MIME reply
// with In-Reply-To + References for thread continuation, dispatches
// via relay /v1/submit including imap_host/imap_port so the post-send
// Sent APPEND fires. Marks rows sent_at = now() on success, increments
// attempts on failure. Caps at 3 attempts to avoid infinite retry on
// permanently-bad rows.
// E1: body extracted to src/crons/runOutboundReplyCron.js
function runOutboundReplyCron() {
  return _runOutboundReplyCron(pool)
}

// E1: body extracted to src/crons/runImapPollCron.js
function runImapPollCron() {
  return _runImapPollCron(pool, { Sentry, generateAiSuggestionForReply })
}

// 2026-05-18 hardening — runImapInboxAuditCron compares IMAP UNSEEN to
// reply_inbox ingested rows per mailbox. Emits a mailbox_alerts row
// (severity=warn, type=imap_inbox_gap) plus operator_audit_log entry
// whenever the gap exceeds operator_settings.imap_inbox_audit_gap_threshold.
// Body lives in src/crons/runImapInboxAuditCron.js so it can be unit-tested
// without the full server.js dep tree.
function runImapInboxAuditCron() {
  return _runImapInboxAuditCron(pool, { relayImapFetch, Sentry })
}

// C — Warmup day advancement (daily at 05:00)
// E1: body extracted to src/crons/runWarmupAdvanceCron.js
function runWarmupAdvanceCron() {
  return _runWarmupAdvanceCron(pool)
}

// F — Daily operator report
// E1: body extracted to src/crons/runDailyReportCron.js
function runDailyReportCron() {
  return _runDailyReportCron(pool, { smtpSendWithFallback })
}

// KT-B5 — Lab feedback loop nightly cron.
//
// Spawns the Go binary `services/operator-practice/cmd/seed-from-prod`
// which pulls the most recent N classified prod replies, anonymizes
// them via the OP1.2 anonymizer, and APPENDs into the Mail Lab IMAP
// Sprint G10 (#1241) — runLabFeedbackLoopCron removed. The cron seeded
// the operator-practice IMAP inbox via a Go binary. Disabled by default
// (OPERATOR_PRACTICE_LAB_SEED_ENABLED!=1) and depended on a Go toolchain
// at runtime which Railway's Node-only container doesn't ship. No
// operator has enabled the flag in production; the binary path is
// kept in services/operator-practice/cmd/seed-from-prod for one-off
// manual invocations.

// S7 — Self-healing health cycle
// Runs every 30 minutes. Fetches mailboxes that are degraded (low score,
// auth fails, or consecutive bounces) and triggers a targeted full-check so
// applyAutomationRules() can either fix or escalate them. After the check
// the score is refreshed; if a mailbox that was auto-paused has recovered
// above 80, the pause is lifted.
// E1: body extracted to src/crons/runMailboxHealthCycleCron.js
function runMailboxHealthCycleCron() {
  return _runMailboxHealthCycleCron(pool, { logHealing })
}

// E1: body extracted to src/crons/runCampaignWatchdogCron.js
function runCampaignWatchdogCron() {
  return _runCampaignWatchdogCron(pool, { logHealing })
}

// ── Bounce → email_status=invalid auto-flip ───────────────────────
// E1: body extracted to src/crons/runBounceFlipCron.js
function runBounceFlipCron() {
  return _runBounceFlipCron(pool)
}

// ── S11: Mailbox bounce cascade auto-throttle ─────────────────────
// Schránky s bounce_rate 5-9.9% nebo consecutive_bounces >= 3 → cap snížen
// na 50%. Schránky s bounce_rate >= 10% nebo consecutive_bounces >= 5 →
// pauzovány. Spouštěno každých 30 minut. Logika žije v mailboxBounceThrottle.js.
// E1: body extracted to src/crons/runMailboxBounceThrottleCron.js
function runMailboxBounceThrottleCron() {
  return _runMailboxBounceThrottleCron(pool)
}

// ── AV-F8: Bounce anomaly detection — auto-pause mailbox + suppress domain ──
// Per-mailbox 24h bounce rate > 5% → auto-pause (24h) with last_bounce_alert_at
// cooldown 12h. Per-domain 7d bounce rate > 20% → INSERT outreach_suppressions.
// Hourly cadence. Logic lives in src/crons/runBounceAnomalyCron.js.
function runBounceAnomalyCron() {
  return _runBounceAnomalyCron(pool)
}

// ── AV-F5-A: Prospect scoring cron ─────────────────────────────────
// Walks contacts (crm_client_id IS NULL) whose prospect_score_at is NULL
// or stale (>24h), scores them with the linear_v1 prospectScorer lib, and
// persists score + factors. 6h cadence. Logic lives in
// src/crons/runProspectScoringCron.js.
function runProspectScoringCron() {
  return _runProspectScoringCron(pool)
}

// Machinery-priority sync — keeps campaign_contacts.priority on the canonical
// 0-1 compute_machinery_score scale (drift guard, see migration 178).
function runCampaignContactPriorityCron() {
  return _runCampaignContactPriorityCron(pool)
}

// ── AV-F9: Zombie in_flight reclaim cron ─────────────────────────────
// Reclaims campaign_contacts.status='in_flight' rows whose updated_at
// is older than 1 hour back to 'pending' so the next sender tick can
// re-claim them. Safety net against sender daemon crash / OOM /
// Railway redeploy without graceful shutdown. 10-min cadence. Logic
// lives in src/crons/runCampaignContactsStaleReclaim.js.
function runCampaignContactsStaleReclaim() {
  return _runCampaignContactsStaleReclaim(pool)
}

// Auto-capture vehicles from incoming replies into the Vozidla inventory,
// linked to the sender's contact/company/crm. Deterministic regex_v2 only
// (no LLM auto-apply). 10-min cadence. Logic in
// src/crons/runVehicleAutoCaptureCron.js.
function runVehicleAutoCaptureCron() {
  return _runVehicleAutoCaptureCron(pool)
}

// ── S9: Proxy pool exhaustion watchdog ────────────────────────────
// Checks the current working-proxy count. When it falls below 3, fires
// POST /v1/admin/refresh-pool on the relay to trigger an immediate re-fetch+probe
// cycle. Logic lives in proxyWatchdog.js (importable, testable).
const checkProxyPoolHealth = makeProxyWatchdog({
  relayProxyPool,
  pool,
  getRelayBase: () => (
    process.env.ANTI_TRACE_RELAY_URL_OVERRIDE
      || process.env.ANTI_TRACE_RELAY_URL
      || null
  ),
  getRelayToken: () => process.env.ANTI_TRACE_RELAY_TOKEN || null,
})

// ── Auto-unpause mailboxes after proxy recovery ────────────────────
// E1: body extracted to src/crons/runMailboxHealingCron.js
function runMailboxHealingCron() {
  return _runMailboxHealingCron(pool)
}

// ── Periodic re-verify (≥30d old valid/catch_all) ─────────────────
//
// BF-A5 — rate-limit + worker-safety hardening:
//   1. Module-scoped in-flight flag prevents overlapping invocations
//      (Railway redeploy can fire two cron schedulers briefly).
//   2. Batch size and dailyMax driven by env so ops can tune without code.
//   3. Daily cap tracked via SELECT count from email_verification_log
//      where trigger='cron' and current UTC day. computeReverifyBudget
//      decides how many to verify based on remaining headroom.
//   4. SELECT now picks DISTINCT ON (domain) — spreads load across MX
//      servers instead of hammering one domain when a single tenant has
//      many stale rows.
// E1: body extracted to src/crons/runEmailReverifyCron.js
function runEmailReverifyCron() {
  return _runEmailReverifyCron(pool, { runVerifyAndPersist })
}
// E1: body extracted to src/crons/runContactStaleReverifyCron.js
// CONTACT_REVERIFY_INTERVAL_DAYS, CONTACT_REVERIFY_BATCH_SIZE, CONTACT_REVERIFY_JITTER_S
// are re-exported from the module and imported above (AR6 T-26 ratchet)
function runContactStaleReverifyCron() {
  return _runContactStaleReverifyCron(pool)
}

// ── Enrichment worker registry ─────────────────────────────────────
// Parser is async (companyId) → Array<{field,value,base_confidence?,ttl_days?}>.
// Register via `parserRegistry[source] = fn`. Parsers wired in #54-#57.
const parserRegistry = Object.create(null)

// mx_lookup parser — DNS facts derived from the company's email domain.
// Skips when company has no email or domain is invalid (returns []).
parserRegistry.mx_lookup = Object.assign(
  async function mxLookupParser(companyId) {
    const { rows: [co] } = await pool.query(
      `SELECT email, website FROM companies WHERE id=$1`, [companyId],
    )
    if (!co) return []
    const fromEmail = (co.email || '').split('@')[1]
    const fromWeb   = (co.website || '').replace(/^https?:\/\//, '').split('/')[0]
    const domain    = (fromEmail || fromWeb || '').toLowerCase().trim()
    if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) return []
    return await probeDns(domain)
  },
  { version: probeDns.version },
)

// web_scrape parser — fetch homepage, extract tech_stack + site signals.
// Skips when company has no website. Polite UA; 8s timeout.
parserRegistry.web_scrape = Object.assign(
  async function webScrapeParser(companyId) {
    const { rows: [co] } = await pool.query(
      `SELECT website FROM companies WHERE id=$1`, [companyId],
    )
    if (!co?.website) return []
    return await probeWeb(co.website)
  },
  { version: probeWeb.version },
)

// justice_cz parser — scrape public business registry for statutory form,
// founding date, registered capital, directors. Skips when ico missing.
parserRegistry.justice_cz = Object.assign(
  async function justiceCzParser(companyId) {
    const { rows: [co] } = await pool.query(
      `SELECT ico FROM companies WHERE id=$1`, [companyId],
    )
    if (!co?.ico) return []
    return await probeJustice(co.ico)
  },
  { version: probeJustice.version },
)

// vvz parser — public-procurement bulletin; emits tendr_count + last_date
// + subjects + total_value. Requires ICO. No-op when missing.
parserRegistry.vvz = Object.assign(
  async function vvzParser(companyId) {
    const { rows: [co] } = await pool.query(
      `SELECT ico FROM companies WHERE id=$1`, [companyId],
    )
    if (!co?.ico) return []
    return await probeVvz(co.ico)
  },
  { version: probeVvz.version },
)
const sourceLimiters = new Map()
const sourceBreakers = new Map()

async function refreshCompanyCurrentFactsMV() {
  // CONCURRENTLY = readers don't block during refresh. Needs unique index.
  // Falls back to non-concurrent if MV is empty (PG quirk: needs first
  // populate before CONCURRENTLY works).
  try {
    await pool.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY company_current_facts`)
  } catch (e) {
    if (/has not been populated/i.test(e.message)) {
      await pool.query(`REFRESH MATERIALIZED VIEW company_current_facts`)
    } else {
      throw e
    }
  }
}

// E1: body extracted to src/crons/runAdaptiveRefreshCron.js
function runAdaptiveRefreshCron() {
  return _runAdaptiveRefreshCron(pool)
}

// E1: body extracted to src/crons/runEnrichmentMVRefreshCron.js
function runEnrichmentMVRefreshCron() {
  return _runEnrichmentMVRefreshCron(pool, { refreshCompanyCurrentFactsMV })
}

async function runEnrichmentWorkerTick() {
  const { rows: sources } = await pool.query(
    `SELECT source, rate_limit_per_min, default_ttl_days, base_confidence, enabled
       FROM enrichment_sources
      WHERE enabled = TRUE`,
  )
  for (const s of sources) {
    if (!sourceLimiters.has(s.source)) sourceLimiters.set(s.source, new SourceRateLimiter(s.rate_limit_per_min))
    if (!sourceBreakers.has(s.source)) sourceBreakers.set(s.source, new CircuitBreaker(5, 5 * 60_000))
  }
  const summary = await runWorkerTick(pool, {
    sources, parsers: parserRegistry,
    limiters: sourceLimiters, breakers: sourceBreakers,
    batchSize: 25,
  })
  if (summary.length) console.log('[cron] enrichment-worker tick:', JSON.stringify(summary))
}

// E1: body extracted to src/crons/runAuditLogRetentionCron.js
function runAuditLogRetentionCron() {
  return _runAuditLogRetentionCron(pool)
}
// iter62 — autonomous sync: daily auto-link contacts→crm_clients (ICO+email).
function runCrmBackfillCron() {
  return _runCrmBackfillCron(pool)
}

// E1: body extracted to src/crons/runBlacklistCheckCron.js
function runBlacklistCheckCron() {
  return _runBlacklistCheckCron(pool)
}

// BF-F5 — cron tick timing wrapper. Logs `[cron] <name> duration_ms=<n>`
// after every invocation so slowdown trends are queryable in log search.
// Safe to wrap an already-async fn or a sync fn; errors are caught + logged
// but rethrown so the existing scheduler error paths (setInterval keeps firing)
// behave unchanged.
//
// MVP-4: also UPSERTs into cron_heartbeats so /api/health/cron-heartbeats
// can detect stalled crons (last_run > 2× expected interval).
function timed(name, fn) {
  return async (...args) => {
    // Zombie-pool guard: if pool.end() was called without process.exit() firing,
    // the BFF is in a zombie state — crash immediately so the supervisor can
    // restart the process rather than silently serving stale data for hours.
    assertPoolAlive(`timed(${name})`)
    const t0 = Date.now()
    let status = 'ok'
    let errMsg = null
    try {
      return await fn(...args)
    } catch (e) {
      status = 'error'
      errMsg = e?.message || String(e)
      throw e
    } finally {
      const ms = Date.now() - t0
      console.log(`[cron] ${name} duration_ms=${ms}`)
      // Heartbeat — best-effort, never block the cron path.
      pool.query(
        `INSERT INTO cron_heartbeats(cron_name, last_run_at, last_duration_ms, last_status, last_error)
         VALUES($1, now(), $2, $3, $4)
         ON CONFLICT (cron_name) DO UPDATE SET
           last_run_at = EXCLUDED.last_run_at,
           last_duration_ms = EXCLUDED.last_duration_ms,
           last_status = EXCLUDED.last_status,
           last_error = EXCLUDED.last_error`,
        [name, ms, status, errMsg],
      ).catch(() => { /* table may not exist on first boot — see ensureCronHeartbeats */ })
    }
  }
}

// cronSafe wraps an async cron handler so it never throws — for callers
// that schedule via raw setInterval / setTimeout and have no way to
// observe rejection. timed() (above) DOES rethrow on purpose so its
// caller scheduleCron can log + reschedule; that pattern works because
// scheduleCron's tick body has try { await fn() } catch. For bare
// setInterval(fn) callsites the rejection bubbles to the event loop
// as an unhandled rejection and Node exits (see PR #1239 RCA —
// runEgressChaosDetectionCron killed the BFF process on pool race).
//
// Use cronSafe(name, asyncFn) for any cron scheduled outside scheduleCron.
// It composes timed (so heartbeats + duration logs still fire) and adds a
// final .catch that logs + Sentry-reports without rethrowing.
function cronSafe(name, fn) {
  const wrapped = timed(name, fn)
  return async (...args) => {
    try { return await wrapped(...args) } catch (e) {
      console.warn(`[cron] ${name} failed:`, e?.message)
      try { Sentry?.captureException?.(e, { tags: { cron: name } }) } catch { /* ignored */ }
    }
  }
}

// MVP-4 — ensure cron_heartbeats table exists. Called once during boot.
async function ensureCronHeartbeats() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS cron_heartbeats (
      cron_name TEXT PRIMARY KEY,
      last_run_at TIMESTAMPTZ NOT NULL,
      last_duration_ms INT NOT NULL,
      last_status TEXT NOT NULL DEFAULT 'ok',
      last_error TEXT
    )`)
  } catch (e) {
    console.warn('[cron] ensureCronHeartbeats failed:', e.message)
  }
}

// AR6 — Cron jitter wrapper.
//
// Inhuman regularity (ticking at :00 :15 :30 :45 on the second, every time)
// is a bot fingerprint. scheduleCron applies a random ±5-minute jitter to
// EVERY tick so subsequent intervals also vary — fixing the original AR6 issue
// where only the first tick had jitter while all later ticks were deterministic.
//
// Pattern: self-rescheduling setTimeout (mirrors scheduleDaily) rather than
// setTimeout + setInterval. Each tick schedules the next with fresh jitter
// drawn from the range [-2.5min, +2.5min] centred on intervalMs.
//
// First tick uses a 0..5min startup delay (unchanged from original) so
// crons spread across the initial scheduling window.
//
// In dev mode (CRON_JITTER_SEED env set) the jitter is deterministic for
// reproducible test runs. Production always uses Math.random().
//
// API: scheduleCron(name, intervalMs, fn)
//   name        — cron label (used in log and heartbeat)
//   intervalMs  — nominal repeat interval (actual fires within ±2.5min of this)
//   fn          — wrapped timed() function to invoke
//
// Returns the initial setTimeout handle (useful for tests / cleanup).
function scheduleCron(name, intervalMs, fn) {
  const MAX_FIRST_JITTER = 5 * 60 * 1000          // 0..5min startup spread
  const MAX_PER_TICK_JITTER = 2.5 * 60 * 1000     // ±2.5min per-tick drift

  function pickJitter(max) {
    const seed = process.env.CRON_JITTER_SEED
    if (seed !== undefined) {
      return Math.abs(Number(seed)) % max
    }
    return Math.floor(Math.random() * max)
  }

  function tick() {
    const drift = pickJitter(MAX_PER_TICK_JITTER * 2) - MAX_PER_TICK_JITTER // ±2.5min
    const nextMs = intervalMs + drift
    setTimeout(async () => {
      try { await fn() } catch (e) { console.error(`[cron] ${name} error:`, e.message) }
      tick()
    }, nextMs)
  }

  const firstJitter = pickJitter(MAX_FIRST_JITTER)
  console.log(`[cron] ${name} scheduled jitter=${Math.round(firstJitter / 1000)}s interval=${Math.round(intervalMs / 1000)}s`)
  const handle = setTimeout(() => tick(), firstJitter)
  return handle
}

// E1: body extracted to src/crons/runHumanBehaviorSimulationCron.js
function runHumanBehaviorSimulationCron() {
  return _runHumanBehaviorSimulationCron(pool, { dialIMAPViaSOCKS5, getMailboxSOCKS5Addr, makeReader })
}

// E1: body extracted to src/crons/runFullInboxScanCron.js
function runFullInboxScanCron() {
  return _runFullInboxScanCron(pool, { dialIMAPViaSOCKS5, getMailboxSOCKS5Addr, makeReader })
}

// E1: body extracted to src/crons/runImapIdleKeepAliveCron.js
function runImapIdleKeepAliveCron() {
  return _runImapIdleKeepAliveCron(pool, { dialIMAPViaSOCKS5, getMailboxSOCKS5Addr, makeReader })
}

// E1: body extracted to src/crons/runFolderOperationsCron.js
function runFolderOperationsCron() {
  return _runFolderOperationsCron(pool, { dialIMAPViaSOCKS5, getMailboxSOCKS5Addr, makeReader })
}

function startCronEngine() {
  // MVP-4 — initialise cron_heartbeats table before any timed() runs.
  ensureCronHeartbeats().catch(() => {})

  // Proxy pool is owned by anti-trace-relay (SMTP-EGRESS-LOCKDOWN R5).
  // BFF just keeps its 60s read-through cache warm: fire-and-forget prefetch
  // every 5 min so the first mailbox to ask doesn't cold-fetch the snapshot.
  setTimeout(() => {
    getProxyPool().catch(e => console.error('[cron] proxy-pool-warm:', e.message))
    setInterval(() => {
      proxyCache = null; proxyCachedAt = 0
      getProxyPool().catch(e => console.error('[cron] proxy-pool-warm:', e.message))
    }, 5 * 60 * 1000)
  }, 90_000)

  // AP4 — Egress chaos detection: drain relay observation buffer + detect mailboxes
  // seen from >1 country in 1h → auto-pause + Sentry alert.
  // Staggered 110s after boot so the relay is fully up before first poll.
  //
  // AP4-HW: When the relay ring buffer is at ≥80% capacity, immediately trigger
  // an extra drain cycle rather than waiting for the 5-minute interval. Prevents
  // data loss when the BFF was unreachable for ~4h+ (80% of 2000-slot buffer).
  let egressChaosDrainInFlight = false
  const egressChaosDetectFn = timed('runEgressChaosDetectionCron', () =>
    runEgressChaosDetectionCron(pool, { Sentry }),
  )
  const maybeImmediateDrain = async () => {
    if (egressChaosDrainInFlight) return
    try {
      const debug = await getEgressDebug()
      const fillPct = debug?.ring_buffer_fill_pct ?? 0
      if (fillPct >= 80) {
        console.warn(`[egressChaos] ring buffer at ${fillPct}% — triggering immediate drain`)
        // P2 FIX: set in-flight flag only when actually starting drain work,
        // not speculatively — avoids suppressing future checks when getEgressDebug
        // succeeds but ring buffer is below threshold.
        egressChaosDrainInFlight = true
        try {
          await egressChaosDetectFn()
        } finally {
          egressChaosDrainInFlight = false
        }
      }
    } catch (e) {
      console.warn('[egressChaos] high-water probe error:', e.message)
    }
  }
  const safeEgressChaosDetect = () =>
    egressChaosDetectFn().catch((e) => {
      console.warn('[cron] egressChaosDetect failed:', e?.message)
      try { Sentry?.captureException?.(e) } catch { /* ignored */ }
    })
  setTimeout(() => {
    safeEgressChaosDetect()
    setInterval(() => {
      safeEgressChaosDetect()
      maybeImmediateDrain().catch(() => {})
    }, 5 * 60 * 1000)
  }, 110_000)

  // BF-F5 — every cron now wrapped in timed(name, fn) so each tick emits
  // `[cron] <name> duration_ms=<n>` post-completion.

  // runFullCheckCron removed — CAD-S8 / issue #539 (Go orchestrator owns scoring).

  // Stale-cache freshness sweep every 60s — keeps mailbox_check_cache warm
  // so the UI never reads a > 90s stale entry.
  // AR6: jitter applied via scheduleCron wrapper.
  scheduleCron('runStaleHealthCheckCron', 60_000, timed('runStaleHealthCheckCron', runStaleHealthCheckCron))

  // Z3-A — IMAP poll + outbound reply migrated to the Go runner (see
  // docs/audits/2026-05-14-cron-migration-classification.md). The BFF
  // cron stays as a fallback during rollout; operator flips
  // MIGRATED_IMAP_POLL=true / MIGRATED_OUTBOUND_REPLY=true on the
  // machinery-outreach Railway service to hand control to the Go loop.
  // IMAP poll every 5 minutes — AR6: jitter applied.
  if (/^(1|true|yes|on)$/i.test(String(process.env.MIGRATED_IMAP_POLL || ''))) {
    console.log('[boot] runImapPollCron — migrated to Go runner (MIGRATED_IMAP_POLL=true)')
  } else {
    scheduleCron('runImapPollCron', 5 * 60 * 1000, timed('runImapPollCron', runImapPollCron))
  }
  // Sprint 2.1 — manual_reply_outbox worker. Picks pending operator
  // replies, dispatches via anti-trace-relay. Every 90s so operator
  // sees their reply on the wire within ~1-2 min of clicking Send.
  if (/^(1|true|yes|on)$/i.test(String(process.env.MIGRATED_OUTBOUND_REPLY || ''))) {
    console.log('[boot] runOutboundReplyCron — migrated to Go runner (MIGRATED_OUTBOUND_REPLY=true)')
  } else {
    scheduleCron('runOutboundReplyCron', 90 * 1000, timed('runOutboundReplyCron', runOutboundReplyCron))
  }

  // 2026-05-18 hardening — IMAP inbox audit. Once per hour, compare
  // IMAP UNSEEN to reply_inbox ingested rows per mailbox. Threshold
  // + master switch live in operator_settings (HARD rule
  // feedback_no_magic_thresholds + feedback_env_var_needs_db_fallback).
  // The cron itself reads enabled flag on every tick so toggling via
  // dashboard UI takes effect without a BFF restart.
  scheduleCron('runImapInboxAuditCron', 60 * 60 * 1000, timed('runImapInboxAuditCron', runImapInboxAuditCron))

  // AV-F2 (2026-05-19) — regex auto-classifier cron. Iterates recent
  // unclassified replies (≤24h lookback, ≤50/tick) and writes verdicts to
  // reply_classifications_log; high-confidence verdicts also flip the
  // source row's classification + handled. Idempotent via the unique
  // (reply_id, classifier_version) index on the log table.
  scheduleCron('runAutoClassifyCron', 5 * 60 * 1000, timed('runAutoClassifyCron', () => runAutoClassifyCron(pool)))

  // Daily cron scheduler — Europe/Prague wall-clock.
  //
  // BF-A6 — DST-correct rescheduling: the previous version used
  // getTimezoneOffset() (server-local, typically UTC on Railway) AND
  // a fixed 24h setInterval. Both were buggy:
  //   - server-local offset → cron fired at 05:00 UTC, not 05:00 Prague.
  //   - 24h setInterval → fixed against UTC; Prague wall-clock drifted
  //     by 1h on each DST transition (March/October).
  // Both fixed by computing the next fire instant via Intl in the target
  // tz, and rescheduling after every tick (no setInterval).
  const scheduleDaily = (fn, hour, tz = 'Europe/Prague') => {
    const tick = () => {
      try { fn() } catch (e) { console.error(`[cron] scheduleDaily(${hour}) tick error:`, e.message) }
      const next = computeNextDailyFire(new Date(), hour, tz)
      setTimeout(tick, Math.max(1000, next.getTime() - Date.now()))
    }
    const first = computeNextDailyFire(new Date(), hour, tz)
    setTimeout(tick, Math.max(1000, first.getTime() - Date.now()))
  }
  scheduleDaily(timed('runWarmupAdvanceCron', runWarmupAdvanceCron), 5)
  // AP1 — Advance lifecycle phases daily at 03:00 Prague.
  // Calls advance_lifecycle_phase() which UPDATEs mailboxes whose created_at
  // age has crossed a phase boundary (3d/7d/14d/30d). Returns count of advanced.
  scheduleDaily(timed('runLifecyclePhaseAdvanceCron', async () => {
    const { rows } = await pool.query('SELECT advance_lifecycle_phase() AS advanced')
    const advanced = Number(rows[0]?.advanced ?? 0)
    console.log(`[cron] advance_lifecycle_phase advanced=${advanced}`)
  }), 3)
  scheduleDaily(timed('runDailyReportCron', runDailyReportCron), 7)
  scheduleDaily(timed('runMidnightResetCron', async () => {
    console.log('[cron] midnight: daily counters reset (send_events partitioned by date, no action needed)')
    // send_events uses sent_at date filter so counters reset automatically
    // But resolve pending bounce-escalation pauses that have hit 24h cooldown
    try {
      const { rows } = await pool.query(
        `SELECT id FROM outreach_mailboxes
         WHERE status='paused'
           AND environment = 'production'
           AND status_reason='auto: sustained bounce warn — daily cap at floor'
           AND daily_cap_reduced_at < now() - interval '24 hours'`
      )
      for (const mb of rows) {
        const { rows: checkRows } = await pool.query(
          `SELECT consecutive_bounces, total_sent, total_bounced FROM outreach_mailboxes WHERE id=$1`, [mb.id]
        )
        if (!checkRows.length) continue
        const r = checkRows[0]
        const ts = Number(r.total_sent || 0), tb = Number(r.total_bounced || 0)
        const bounceRate = ts > 0 ? (tb / ts) * 100 : null
        if ((!bounceRate || bounceRate < 3) && Number(r.consecutive_bounces || 0) === 0) {
          await pool.query(
            `UPDATE outreach_mailboxes SET status='active', status_reason=NULL WHERE id=$1`, [mb.id]
          )
          console.log(`[cron] midnight: auto-resumed mailbox ${mb.id} after bounce escalation cooldown`)
        }
      }
    } catch (e) { console.error('[cron] midnight reset error:', e.message) }
  }), 0) // 00:00 Prague time

  // KT-B5 — Lab feedback loop nightly cron (03:30 Prague).
  // Selects last N classified prod replies, anonymizes, APPENDs into
  // Sprint G10 (#1241) — runLabFeedbackLoopCron schedule call removed.
  // See the function-removal comment above for the rationale (Go
  // toolchain dependency + disabled by default).


  // AR6: all repeating crons use scheduleCron for random first-tick jitter (bot fingerprint defense).
  scheduleCron('runMailboxHealthCycleCron', 30 * 60 * 1000, timed('runMailboxHealthCycleCron', runMailboxHealthCycleCron))
  scheduleCron('runCampaignWatchdogCron', 60 * 60 * 1000, timed('runCampaignWatchdogCron', runCampaignWatchdogCron))
  // Z3-B: bounce-defense crons migrated to Go orchestrator. When the
  // operator flips MIGRATED_BOUNCE_*=true on Railway, the BFF stops
  // scheduling these and the Go side owns them 24/7. Leaving the env
  // flag false keeps the BFF as the source of truth (rollback path).
  if (process.env.MIGRATED_BOUNCE_FLIP !== 'true') {
    scheduleCron('runBounceFlipCron', 15 * 60 * 1000, timed('runBounceFlipCron', runBounceFlipCron))
  }
  if (process.env.MIGRATED_BOUNCE_THROTTLE !== 'true') {
    scheduleCron('runMailboxBounceThrottleCron', 30 * 60 * 1000, timed('runMailboxBounceThrottleCron', runMailboxBounceThrottleCron))
  }
  // AV-F8 — Bounce anomaly auto-pause + domain auto-suppress every 1h.
  scheduleCron('runBounceAnomalyCron', 60 * 60 * 1000, timed('runBounceAnomalyCron', runBounceAnomalyCron))
  // AV-F5-A — Prospect scoring: walks unsent contacts (crm_client_id IS NULL),
  // recomputes contacts.prospect_score every 6h with a 24h re-compute window
  // so newly imported contacts get scored within hours of arrival.
  scheduleCron('runProspectScoringCron', PROSPECT_SCORE_CRON_INTERVAL_MS, timed('runProspectScoringCron', runProspectScoringCron))
  // 2026-06-26 — keep campaign_contacts.priority synced to the machinery score
  // so new enrollments (inserted at DEFAULT 0) and any future drift self-heal.
  scheduleCron('runCampaignContactPriorityCron', PRIORITY_SYNC_CRON_INTERVAL_MS, timed('runCampaignContactPriorityCron', runCampaignContactPriorityCron))
  // AV-F9 — Zombie in_flight reclaim every 10 min. Releases campaign_contacts
  // stuck in 'in_flight' for >1h back to 'pending' so the sender pool stays
  // healthy after daemon crashes / OOMs / Railway redeploys. Safety net
  // for the 2026-05-13 incident where 22.5k contacts on campaign 457 sat
  // in_flight for 7 days.
  scheduleCron('runCampaignContactsStaleReclaim', RECLAIM_CRON_INTERVAL_MS, timed('runCampaignContactsStaleReclaim', runCampaignContactsStaleReclaim))
  // Auto-capture vehicles from incoming replies → Vozidla inventory every 10 min,
  // fully linked to contact/company/crm. Deterministic regex_v2 (no LLM auto-apply).
  scheduleCron('runVehicleAutoCaptureCron', AUTO_CAPTURE_INTERVAL_MS, timed('runVehicleAutoCaptureCron', runVehicleAutoCaptureCron))
  // AR11 — Bounce rate auto-pause every 30 min — AR6: jitter applied.
  if (process.env.MIGRATED_BOUNCE_RATE_MONITOR !== 'true') {
    scheduleCron('runBounceRateMonitorCron', 30 * 60 * 1000, timed('runBounceRateMonitorCron', () => runBounceRateMonitorCron(pool, { Sentry })))
  }
  // Z3 Bundle C — mailbox healing migrated to Go orchestrator.
  if (process.env.MIGRATED_MAILBOX_HEALING !== '1') {
    scheduleCron('runMailboxHealingCron', 15 * 60 * 1000, timed('runMailboxHealingCron', runMailboxHealingCron))
  } else {
    console.log('[cron] runMailboxHealingCron disabled — MIGRATED_MAILBOX_HEALING=1 (Z3 Bundle C)')
  }

  // M2 — Synthetic prod-smoke every 60s (staggered 95s after boot).
  // Continuous validation of 10 health invariants in production.
  // Persists results to synthetic_runs, Sentry-on-fail.
  // HARDEN-2:
  //   - in-flight guard so an unhealthy backend doesn't queue overlapping runs
  //   - 45s wall-clock timeout per run
  //   - SKIP_SYNTHETIC_CRON checked per-tick (runtime kill-switch)
  //   - daily retention pass keeps table from growing unbounded
  if (process.env.SKIP_SYNTHETIC_CRON !== '1') {
    setTimeout(async () => {
      try {
        const { runSyntheticSmoke } = await import('./tests/synthetic/prod-smoke.test.js')
        const target = `http://localhost:${process.env.PORT || 18001}`
        process.env.SYNTHETIC_TARGET_URL = target
        let inFlight = false
        const fn = cronSafe('runSyntheticSmokeCron', async () => {
          if (process.env.SKIP_SYNTHETIC_CRON === '1') return null
          if (inFlight) {
            console.warn('[synthetic] previous run still in flight — skipping tick')
            return null
          }
          inFlight = true
          try {
            const start = Date.now()
            const r = await Promise.race([
              runSyntheticSmoke({ url: target }),
              new Promise((_, rej) => setTimeout(() => rej(new Error('synthetic-smoke timeout 45s')), 45_000)),
            ])
            const duration_ms = Date.now() - start
            // Persist (best-effort)
            try {
              await pool.query(`CREATE TABLE IF NOT EXISTS synthetic_runs (
                id SERIAL PRIMARY KEY,
                ran_at TIMESTAMPTZ DEFAULT now(),
                suite TEXT NOT NULL,
                results JSONB NOT NULL,
                pass_count INT,
                fail_count INT,
                duration_ms INT
              )`)
              await pool.query(
                `INSERT INTO synthetic_runs(suite, results, pass_count, fail_count, duration_ms)
                 VALUES('prod-smoke', $1::jsonb, $2, $3, $4)`,
                [JSON.stringify(r.results), r.pass_count, r.fail_count, duration_ms]
              )
            } catch (e) {
              console.warn('[synthetic] persist failed:', e.message)
              if (typeof Sentry !== 'undefined' && Sentry.captureMessage) {
                Sentry.captureMessage('synthetic-persist-failed', {
                  level: 'warning',
                  tags: { playbook: 'synthetic_smoke', component: 'bff_cron' },
                  extra: { error: e.message },
                })
              }
            }
            // Sentry on fail
            if (!r.ok && typeof Sentry !== 'undefined' && Sentry.captureMessage) {
              Sentry.captureMessage(`synthetic-smoke ${r.fail_count}/${r.results.length} failed`, {
                level: 'warning',
                tags: { playbook: 'synthetic_smoke', component: 'bff_cron' },
                extra: { results: r.results.filter(x => !x.ok) },
              })
            }
            return r
          } finally {
            inFlight = false
          }
        })
        fn()
        setInterval(fn, 60 * 1000)

        // HARDEN-2: 90-day retention to bound table growth (~1440 rows/day).
        // Runs once an hour; DELETE is fast on b-tree-indexed ran_at.
        setInterval(async () => {
          if (process.env.SKIP_SYNTHETIC_CRON === '1') return
          try {
            await pool.query(
              `DELETE FROM synthetic_runs WHERE ran_at < now() - interval '90 days'`,
            )
          } catch (e) {
            console.warn('[synthetic] retention sweep failed:', e.message)
          }
        }, 60 * 60 * 1000).unref()
      } catch (e) {
        console.error('[cron] synthetic-smoke setup failed:', e.message)
      }
    }, 95_000)
  }

  // Greylisting retry queue every 10 min — AR6: jitter applied.
  // Z3-D: gated by MIGRATED_GREYLIST_RETRY env var so the Go runner
  // (services/orchestrator/intelligence/greylist_retry_loop.go) can own this
  // 24/7 without the BFF racing on the same email_verify_queue rows. Default
  // off → BFF still schedules until operator flips the env. Initiative:
  // docs/initiatives/2026-05-14-outreach-dashboard-local-only-migration.md.
  if (process.env.MIGRATED_GREYLIST_RETRY === '1') {
    console.log('[cron] runGreylistRetryCron — skipped (MIGRATED_GREYLIST_RETRY=1, owned by Go runner)')
  } else {
    scheduleCron('runGreylistRetryCron', 10 * 60 * 1000, timed('runGreylistRetryCron', runGreylistRetryCron))
  }

  // Periodic re-verify daily at 03:00 Prague
  scheduleDaily(timed('runEmailReverifyCron', runEmailReverifyCron), 3)

  // J4 — Contact stale re-verify: contacts verified >90d ago → re-enqueue into verifyLoop
  scheduleDaily(timed('runContactStaleReverifyCron', runContactStaleReverifyCron), 3)

  // AP3 — mailbox_op_rate_log cleanup: delete rows older than 7 days.
  // Runs daily at 03:00 Prague alongside other maintenance tasks.
  scheduleDaily(timed('runMailboxOpRateLogCleanup', async function runMailboxOpRateLogCleanup() {
    try {
      const { rowCount } = await pool.query(
        `DELETE FROM mailbox_op_rate_log WHERE occurred_at < NOW() - INTERVAL '7 days'`
      )
      console.log(`[cron] runMailboxOpRateLogCleanup done — deleted ${rowCount} rows`)
    } catch (e) {
      console.error('[cron] runMailboxOpRateLogCleanup error:', e.message)
    }
  }), 3)

  // Contact email verify loop — hourly (disabled by default until AM3 operator surface)
  // Enable by setting VERIFY_LOOP_CONTACTS_ENABLED=true on Railway after AM3 ships.
  const { runContactVerifyCron, scheduleContactVerifyCron } = mountContactVerifyCron({
    pool,
    verifyEmail,
    domainCache,
    domainProbeLock: _domainProbeLock,
    DOMAIN_RATE_MS,
    capture: (err, ctx) => Sentry?.captureException(err, { extra: ctx }),
  })

  // AM3 — operator surface for contact verify loop (pause/resume/trigger/status)
  mountVerifyLoopRoutes(app, { pool, runContactVerifyCron, capture500, safeError })

  // H3 / 2026-05-14: schedule unconditionally — runContactVerifyCron() reads
  // BOTH operator_settings.verify_loop_enabled AND env var per-tick and early-
  // returns if both falsy. Previously this boot-time env-only gate meant that
  // flipping the DB flag (the UX/UI-first path) had no effect without redeploy,
  // and even an env flip required a full Railway redeploy to wire the timer.
  // Cost of always-scheduling is ~one DB SELECT per hour when disabled.
  scheduleContactVerifyCron()
  const bootEnabled = process.env.VERIFY_LOOP_CONTACTS_ENABLED === 'true'
  console.log(`[boot] contactVerifyCron scheduled (hourly, initial delay 90s) env_enabled=${bootEnabled} — DB operator_settings.verify_loop_enabled is authoritative per-tick`)

  // Scoring recompute hourly — AR6: jitter applied.
  scheduleCron('runScoringRecomputeCron', 60 * 60 * 1000, timed('runScoringRecomputeCron', runScoringRecomputeCron))

  // company_current_facts MV refresh every 10 min — AR6: jitter applied.
  scheduleCron('runEnrichmentMVRefreshCron', 10 * 60 * 1000, timed('runEnrichmentMVRefreshCron', runEnrichmentMVRefreshCron))

  // Enrichment worker tick every 30s — AR6: jitter applied.
  scheduleCron('runEnrichmentWorkerTick', 30 * 1000, async () => runEnrichmentWorkerTick())

  // Adaptive refresh planner every 6h — AR6: jitter applied.
  scheduleCron('runAdaptiveRefreshCron', 6 * 60 * 60 * 1000, timed('runAdaptiveRefreshCron', runAdaptiveRefreshCron))

  // Stale-state guard: check + auto-recover every 60s.
  staleGuardTimer = setInterval(() => {
    runStaleGuards('periodic').catch(e => console.error('[staleGuard] periodic:', e.message))
  }, 60_000)

  // S9 — proxy-pool exhaustion watchdog: triggers relay force-refresh when working count < 3.
  setInterval(checkProxyPoolHealth, 5 * 60 * 1000)

  // BFF-owned heartbeat (independent of Go watchdog). Runs every 60s, throttled to 1 row / 10 min.
  setInterval(watchdogFromBFF, 60_000)
  setTimeout(watchdogFromBFF, 5_000) // first heartbeat soon after boot

  // Auto-recover for low-score mailboxes: every 6h — AR6: jitter applied.
  scheduleCron('mailboxAutoRecover', 6 * 60 * 60 * 1000, async () => mailboxAutoRecover())

  // Config drift: re-check every 5 min.
  setInterval(() => {
    runConfigDrift({ pool, getProxyCache: () => proxyCache })
      .then(r => {
        lastConfigDrift = r
        if (!r.ok) console.log(`[configDrift] ${r.critical_count} critical, ${r.drifts.length} total`)
      })
      .catch(e => console.error('[configDrift] periodic:', e.message))
  }, 5 * 60 * 1000)

  // S18 — DNS blacklist check daily at 02:00 Prague (low-traffic hour)
  scheduleDaily(timed('runBlacklistCheckCron', runBlacklistCheckCron), 2)

  // BF-D2 — operator_audit_log retention: 5 years default, configurable
  // via AUDIT_LOG_RETENTION_DAYS env. Daily 04:00 Prague (low-traffic).
  scheduleDaily(timed('runAuditLogRetentionCron', runAuditLogRetentionCron), 4)
  // iter62 — autonomous sync: auto-link newly-ingested contacts → crm_clients
  // at 03:00 Prague so CRM linkage no longer waits for an operator click.
  scheduleDaily(timed('runCrmBackfillCron', runCrmBackfillCron), 3)

  // AR10 — Human behaviour simulation every 4h. Picks 30% of mailboxes per
  // cycle, performs mark-read/reply/archive/draft actions on UNSEEN messages.
  // All IMAP via SOCKS5 wgpool per AO1. Interval: 4h with scheduleCron jitter.
  scheduleCron('runHumanBehaviorSimulationCron', 4 * 60 * 60 * 1000, timed('runHumanBehaviorSimulationCron', runHumanBehaviorSimulationCron))

  // AR14 — Full INBOX scan daily at 14:00 Prague (low-traffic afternoon).
  // Reads all UIDs in last 7d — no state changes, purely behavioural signal.
  scheduleDaily(timed('runFullInboxScanCron', runFullInboxScanCron), 14)

  // AR14 — IMAP IDLE keep-alive every 30 min. Each mailbox has a stable 2h
  // nightly slot; cron checks which mailboxes are in-window and starts IDLE.
  scheduleCron('runImapIdleKeepAliveCron', 30 * 60 * 1000, timed('runImapIdleKeepAliveCron', runImapIdleKeepAliveCron))

  // AR15 — Mullvad endpoint reputation monitoring every 6h.
  // Detects per-endpoint bounce rate elevation vs fleet mean (single-IP blacklist signal).
  scheduleCron('runMullvadEndpointReputationCron', 6 * 60 * 60 * 1000, timed('runMullvadEndpointReputationCron', () => runMullvadEndpointReputationCron(pool, { Sentry })))

  // AS4 — Pool capacity monitor every 1h (+jitter via scheduleCron).
  // Alerts via Sentry when pinned/pool_size >= 0.8 (warn) or >= 1.0 (error).
  scheduleCron('runPoolCapacityCron', 60 * 60 * 1000, timed('runPoolCapacityCron', () => runPoolCapacityCron(pool, { Sentry })))

  // Sprint G10 (#1241) — runSenderAuthenticationCheckCron removed. The
  // cron walked outreach_mailboxes daily, resolved SPF/DKIM/DMARC for each
  // sender domain, and emitted Sentry info-level messages on missing
  // records. Per feedback_send_via_seznam_only the operator decided
  // sender-domain auth is Seznam's responsibility (we use @seznam.cz
  // freemail mailboxes), so the cron only fired on Seznam DNS hiccups —
  // not actionable from our side. Removed; if auth state ever becomes
  // self-owned (e.g. moving to @balkanmotors.cz), reintroduce as part
  // of that migration.

  // AR13 — Engagement-driven cap adjustment daily at 04:00 Prague.
  // reply_rate < 0.5% → halve daily_cap_override (floor 5).
  // reply_rate > 5%   → restore toward phase cap (never exceed AP1 phase cap).
  // < 50 sends 7d     → skip (insufficient data guard).
  scheduleDaily(timed('runEngagementCapAdjustmentCron', () => runEngagementCapAdjustmentCron(pool, { Sentry })), 4)

  // AR14 — Folder operations monthly (approx — chunked wait, 1 day per tick).
  // Single setInterval(fn, 30d) silently falls back to 1 ms because 30 days
  // in ms (2_592_000_000) exceeds 2^31-1 — Node clamps the delay to 1. We
  // chunk the wait into 24 h ticks and only fire the actual job once the
  // remaining budget reaches zero.
  const FOLDER_OPS_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000
  const CHUNK_MS = 24 * 60 * 60 * 1000
  function scheduleFolderOpsAfter(remainingMs) {
    if (remainingMs <= 0) {
      timed('runFolderOperationsCron', runFolderOperationsCron)()
      scheduleFolderOpsAfter(FOLDER_OPS_INTERVAL_MS)
      return
    }
    const wait = Math.min(CHUNK_MS, remainingMs)
    setTimeout(() => scheduleFolderOpsAfter(remainingMs - wait), wait)
  }
  setTimeout(() => {
    timed('runFolderOperationsCron', runFolderOperationsCron)()
    scheduleFolderOpsAfter(FOLDER_OPS_INTERVAL_MS)
  }, 10 * 60 * 1000) // 10 min after boot

  console.log('[cron] engine scheduled (proxy-refresh 6h, full-check 4h, imap-poll 5min, warmup 05:00, report 07:00, midnight-reset 00:00, health-cycle 30min, campaign-watchdog 1h, bounce-flip 15min, mailbox-healing 15min, bounce-throttle 30min, greylist-retry 10min, email-reverify 03:00, scoring 1h, mv-refresh 10min, enrichment-worker 30s, refresh-planner 6h, stale-guard 60s, proxy-watchdog 5min, blacklist-check 02:00, audit-retention 04:00, human-behavior-sim 4h, full-inbox-scan 14:00, imap-idle 30min, folder-ops monthly, endpoint-reputation 6h, sender-auth 02:00, engagement-cap 04:00, pool-capacity 1h)')
}

function buildGuardCtx() {
  return {
    pool,
    triggers: {
      // Proxy refresh now means "invalidate BFF cache + re-read relay pool".
      // Relay owns the actual probe + ranking loop.
      refreshProxyPool: async () => {
        proxyCache = null
        proxyCachedAt = 0
        return getProxyPool()
      },
      runWarmupAdvanceCron,
      runPipelineTest,
      getProxyCache: () => proxyCache,
      lastAntiTraceOk: () => lastAntiTraceOkAt,
      pingAntiTrace,
    },
  }
}

async function runStaleGuards(mode) {
  const results = await runGuards(buildGuardCtx())
  lastStaleGuardRun = { at: new Date().toISOString(), mode, results }
  const recovered = results.filter(r => r.recovered).map(r => r.name)
  const failed = results.filter(r => r.status === 'failed').map(r => r.name)
  if (recovered.length || failed.length) {
    console.log(`[staleGuard:${mode}] recovered=[${recovered.join(',')}] failed=[${failed.join(',')}]`)
  }
  return results
}

async function runBootRecovery() {
  try {
    await hydrateProxyBlacklist()
    const results = await runStaleGuards('boot')
    await logBootRecovery(pool, results, { gitSha: getGitSha(), pid: process.pid })
  } catch (e) {
    console.error('[staleGuard] boot:', e.message)
  }
  try {
    lastConfigDrift = await runConfigDrift({ pool, getProxyCache: () => proxyCache })
    if (!lastConfigDrift.ok) {
      console.log(`[configDrift:boot] ${lastConfigDrift.critical_count} critical, ${lastConfigDrift.drifts.length} total`)
      for (const d of lastConfigDrift.drifts) console.log(`  ${d.severity}: ${d.check} — ${d.message}`)
    }
  } catch (e) {
    console.error('[configDrift] boot:', e.message)
  }
}

// ── S4: BFF-owned watchdog heartbeat ─────────────────────────────
// Writes one bff_heartbeat row / 10 min, independent of Go daemon.
// UI watchdog chip stays green even if Go side crashes.
let lastBffHeartbeatAt = 0
async function watchdogFromBFF() {
  // Zombie-pool guard: a dead pool produces "[bffHeartbeat] Cannot use a pool
  // after calling end on the pool" every 60s indefinitely. Crash fast instead.
  assertPoolAlive('watchdogFromBFF')
  if (Date.now() - lastBffHeartbeatAt < 10 * 60 * 1000) return
  try {
    await pool.query(
      `INSERT INTO watchdog_events (check_name, severity, message, auto_healed)
       VALUES ('bff_heartbeat', 'info', $1, false)`,
      [`BFF alive (pid=${process.pid}, sha=${getGitSha().slice(0, 7)})`]
    )
    lastBffHeartbeatAt = Date.now()
  } catch (e) {
    console.warn('[bffHeartbeat]', e.message)
  }
}

// ── S4: Auto-recover for low-score mailboxes ─────────────────────
// Runs every 6h. If mailbox score<50 AND no recent auto-heal AND not in
// bounce_hold AND circuit not open, internally triggers the same recovery
// flow as the "Recover now" button (status=active, zero bounces, canary 10).
async function mailboxAutoRecover() {
  if (process.env.BFF_AUTO_RECOVER === '0') return
  try {
    const { rows } = await pool.query(`
      SELECT m.id, m.from_address, m.last_score, m.status, m.circuit_opened_at
      FROM outreach_mailboxes m
      WHERE m.status = 'active'
        AND m.last_score IS NOT NULL
        AND m.last_score < 50
        AND m.circuit_opened_at IS NULL
    `)
    for (const mb of rows) {
      const { rows: recent } = await pool.query(
        `SELECT id FROM watchdog_events
         WHERE mailbox_id = $1
           AND auto_healed = true
           AND created_at > now() - interval '12 hours'
         LIMIT 1`,
        [mb.id]
      ).catch(() => ({ rows: [] }))
      if (recent.length) continue
      try {
        await pool.query(
          `UPDATE outreach_mailboxes
              SET status='active', status_reason='auto_recover',
                  consecutive_bounces=0, canary_remaining=10,
                  released_at=now(), last_canary_send=NULL,
                  circuit_opened_at=NULL
            WHERE id=$1`,
          [mb.id]
        )
        await pool.query(
          `INSERT INTO watchdog_events (mailbox_id, check_name, event_type, severity, message, auto_healed, healed_at, reason)
           VALUES ($1, 'auto_recover', 'auto_recover', 'warn', $2, true, now(), $3)`,
          [mb.id, `auto-recovered from score=${mb.last_score}`, `auto_recover:score_${mb.last_score}`]
        )
        console.log(`[autoRecover] mailbox ${mb.id} (${mb.from_address}) score=${mb.last_score} → recovered`)
      } catch (e) {
        console.warn(`[autoRecover] ${mb.id}:`, e.message)
      }
    }
  } catch (e) {
    console.error('[autoRecover]:', e.message)
  }
}

// Debug: manually trigger watchdogFromBFF + mailboxAutoRecover (smoke test).
// Safe to expose — heartbeat is idempotent (10min dedupe), autoRecover has
// its own 12h per-mailbox dedupe. Used by ops to verify the cron after boot.
app.post('/api/health/auto-recover-trigger', async (req, res) => {
  try {
    const hbBefore = lastBffHeartbeatAt
    lastBffHeartbeatAt = 0
    await watchdogFromBFF()
    await mailboxAutoRecover()
    res.json({
      ok: true,
      heartbeat_forced: hbBefore !== lastBffHeartbeatAt,
      auto_recover_disabled: process.env.BFF_AUTO_RECOVER === '0',
    })
  } catch (e) {
    return capture500(res, e, safeError)
  }
})

// ── Healing log ───────────────────────────────────────────────────
app.get('/api/healing/log', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 50), 200)
    const { rows } = await pool.query(
      `SELECT id, entity_type, entity_id, entity_label, action, reason, resolved_at, created_at
       FROM healing_log ORDER BY created_at DESC LIMIT $1`,
      [limit]
    )
    const { rows: [{ count }] } = await pool.query(`SELECT COUNT(*)::int AS count FROM healing_log`)
    res.json({ events: rows, total: count })
  } catch (e) { capture500(res, e, safeError) }
})

app.get('/api/healing/stats', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT action, COUNT(*)::int AS cnt,
             MAX(created_at) AS last_at
      FROM healing_log
      WHERE created_at > now() - interval '7 days'
      GROUP BY action ORDER BY cnt DESC
    `)
    const { rows: [today] } = await pool.query(`
      SELECT COUNT(*)::int AS count FROM healing_log
      WHERE created_at > now() - interval '24 hours'
    `)
    res.json({ by_action: rows, today: today?.count || 0 })
  } catch (e) { capture500(res, e, safeError) }
})

// KT-A8.1 — Scraper block-detection audit + circuit-breaker state.
//
// Distinct from /api/healing/log (legacy watchdog mailbox-recovery view).
// This endpoint serves the per-source scraper events written by
// services/contacts blockdetect.LogWriter — see services/contacts/migrations/
// 008_healing_log.sql for the canonical schema.
//
// Response shape (locked by contract test):
//   {
//     events: [
//       { id, occurred_at, source_name, block_type, fallback_attempted,
//         recovered, http_status, target_url, body_signature }, ...
//     ],
//     breakers: {
//       <source_name>: { open: bool, opened_at: timestamp|null, fail_count: int }
//     }
//   }
//
// Breaker state is approximated from the last 50 events per source: if 30+
// of the most recent 50 events for a source are blocks (not recovered), the
// breaker is reported open. Contacts service holds the canonical state in
// memory; the BFF serves a derived view for the dashboard.
app.get('/api/scraper/healing', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 100), 500)
    let events = []
    try {
      const { rows } = await pool.query(
        `SELECT id, occurred_at, source_name, block_type, fallback_attempted,
                recovered, http_status, target_url, body_signature
         FROM healing_log
         ORDER BY occurred_at DESC
         LIMIT $1`,
        [limit]
      )
      events = rows
    } catch (innerErr) {
      // Schema-mismatch fallback: legacy healing_log shape uses
      // entity_type/action/reason and has no occurred_at column. Return an
      // empty events array so the endpoint shape stays stable until
      // migration 008 lands on the target environment.
      const msg = String(innerErr?.message || '')
      if (!/column .* does not exist|does not exist/i.test(msg)) {
        throw innerErr
      }
      events = []
    }

    // Build breaker snapshot from the per-source last-50 window. Done
    // client-side (in JS) on the events array slice the DB just returned —
    // for windows beyond 100 events, we re-query per source if needed.
    const sourceSet = new Set(events.map((e) => e.source_name).filter(Boolean))
    const breakers = {}
    for (const source of sourceSet) {
      // Pull the most recent 50 events for this source.
      let recent = []
      try {
        const { rows } = await pool.query(
          `SELECT block_type, recovered, occurred_at
           FROM healing_log
           WHERE source_name = $1
           ORDER BY occurred_at DESC
           LIMIT 50`,
          [source]
        )
        recent = rows
      } catch {
        recent = []
      }
      // failure := block_type != 'none' && !recovered. Since BlockTypeNone
      // is never inserted (LogWriter short-circuits), every row counts as
      // an upstream block; recovered=true means an alt-source carried the
      // request and the breaker should NOT count it as a failure.
      const failCount = recent.filter((r) => !r.recovered).length
      const open = failCount >= 30
      const openedAt = open
        ? recent.length
          ? recent[Math.min(failCount - 1, recent.length - 1)].occurred_at
          : null
        : null
      breakers[source] = { open, opened_at: openedAt, fail_count: failCount }
    }

    res.json({ events, breakers })
  } catch (e) {
    capture500(res, e, safeError)
  }
})

// ── Analytics ─────────────────────────────────────────────────────
app.get('/api/analytics/overview', async (req, res) => {
  setRouteTags({ 'analytics.endpoint': 'overview' })
  try {
    // Sends + bounces come from send_events. total_opened stays 0 — open
    // tracking is disabled by design (anti-spam pixel removed), surfaced as
    // "sledování vypnuto" in the UI.
    const { rows: [s] } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('sent','opened','replied','bounced'))::int AS total_sent,
        0::int AS total_opened,
        COUNT(*) FILTER (WHERE status = 'bounced')::int AS total_bounced,
        COUNT(*) FILTER (WHERE status IN ('sent','opened','replied','bounced')
          AND sent_at > now() - interval '7 days')::int AS sent_7d
      FROM send_events
    `)
    // Replies are NOT tracked via send_events.status — that status is never
    // flipped to 'replied', so the old COUNT(status='replied') read 0 while
    // 111 real replies sat in reply_inbox (misleading "0 odpovědí" on the
    // operator's main dashboard). reply_inbox is the source of truth. Exclude
    // bounce (a DSN that landed in the inbox is not an engagement reply).
    // Schema verified 2026-06 via \d reply_inbox: classification, received_at.
    const { rows: [r] } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE classification IS DISTINCT FROM 'bounce')::int AS total_replied,
        COUNT(*) FILTER (WHERE classification IS DISTINCT FROM 'bounce'
          AND received_at > now() - interval '7 days')::int AS replied_7d
      FROM reply_inbox
    `)
    const { rows: [c] } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status IN ('active','running'))::int AS active FROM campaigns`
    )
    res.json({ ...s, ...r, active_campaigns: c.active })
  } catch (e) { capture500(res, e, safeError) }
})

app.get('/api/analytics/timeline', async (req, res) => {
  try {
    // Q302 fix (hardening/pages-13-15): honour ?from=YYYY-MM-DD&to=YYYY-MM-DD sent
    // by Analytics.jsx custom date range pickers. Previously the backend only
    // accepted ?days=N and silently ignored from/to, so custom ranges returned
    // wrong data. When both are valid ISO dates and from <= to, use explicit
    // range; otherwise fall back to relative-days mode (max 90 days).
    const rawFrom = typeof req.query.from === 'string' ? req.query.from.trim() : ''
    const rawTo   = typeof req.query.to   === 'string' ? req.query.to.trim()   : ''
    const ISO_RE  = /^\d{4}-\d{2}-\d{2}$/

    // iter56 — defensive 400: if both dates are present but from > to, reject
    // before hitting the DB. The frontend already guards this, but a direct
    // curl or browser-URL bypass must also be caught here.
    if (ISO_RE.test(rawFrom) && ISO_RE.test(rawTo) && rawFrom > rawTo) {
      return res.status(400).json({ error: 'invalid_date_range', message: "from must be ≤ to" })
    }

    let rows, result
    if (ISO_RE.test(rawFrom) && ISO_RE.test(rawTo) && rawFrom <= rawTo) {
      // Custom range mode — use explicit UTC timestamps, span capped at 366 days.
      const fromDate = new Date(rawFrom + 'T00:00:00Z')
      const toDate   = new Date(rawTo   + 'T23:59:59Z')
      const spanMs   = toDate.getTime() - fromDate.getTime()
      const spanDays = Math.min(Math.ceil(spanMs / 86_400_000), 366)
      ;({ rows } = await pool.query(`
        SELECT
          TO_CHAR(DATE_TRUNC('day', sent_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
          COUNT(*) FILTER (WHERE status IN ('sent','opened','replied','bounced'))::int AS sent,
          COUNT(*) FILTER (WHERE status = 'replied')::int AS replied,
          COUNT(*) FILTER (WHERE status = 'opened')::int  AS opened
        FROM send_events
        WHERE sent_at >= $1 AND sent_at <= $2
        GROUP BY 1 ORDER BY 1
      `, [fromDate.toISOString(), toDate.toISOString()]))
      const map = Object.fromEntries(rows.map(r => [r.day, r]))
      result = []
      for (let i = 0; i < spanDays; i++) {
        const d = new Date(fromDate); d.setUTCDate(d.getUTCDate() + i)
        const key = d.toISOString().slice(0, 10)
        result.push(map[key] ?? { day: key, sent: 0, replied: 0, opened: 0 })
      }
    } else {
      // Relative-days mode (original behaviour).
      const days = Math.min(Number(req.query.days || 30), 90)
      ;({ rows } = await pool.query(`
        SELECT
          TO_CHAR(DATE_TRUNC('day', sent_at), 'YYYY-MM-DD') AS day,
          COUNT(*) FILTER (WHERE status IN ('sent','opened','replied','bounced'))::int AS sent,
          COUNT(*) FILTER (WHERE status = 'replied')::int AS replied,
          COUNT(*) FILTER (WHERE status = 'opened')::int  AS opened
        FROM send_events
        WHERE sent_at > now() - ($1 || ' days')::interval
        GROUP BY 1 ORDER BY 1
      `, [days]))
      const map = Object.fromEntries(rows.map(r => [r.day, r]))
      result = []
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i)
        const key = d.toISOString().slice(0, 10)
        result.push(map[key] ?? { day: key, sent: 0, replied: 0, opened: 0 })
      }
    }
    res.json(result)
  } catch (e) { capture500(res, e, safeError) }
})

app.get('/api/analytics/campaigns', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        c.id, c.name, c.status,
        COUNT(se.id) FILTER (WHERE se.status IN ('sent','opened','replied','bounced'))::int AS sent,
        COUNT(se.id) FILTER (WHERE se.status = 'replied')::int AS replied,
        COUNT(se.id) FILTER (WHERE se.status = 'opened')::int  AS opened,
        COUNT(se.id) FILTER (WHERE se.status = 'bounced')::int AS bounced,
        MIN(se.sent_at) AS first_sent,
        MAX(se.sent_at) AS last_sent
      FROM campaigns c
      LEFT JOIN send_events se ON se.campaign_id = c.id
      GROUP BY c.id
      ORDER BY sent DESC
      LIMIT 30
    `)
    res.json(rows)
  } catch (e) { capture500(res, e, safeError) }
})

// ── Operator approval queue (Track B / M+3) ──────────────────────────
// T3.6 (2026-05-01): inline handlers extracted to ./src/server-routes/replies.js
// per ADR-008 D2 module sequence (after #471 mountRepliesRoutes scaffold).
// Behavior is byte-equivalent — same SQL, response shape, Czech error
// messages, operator_audit_log writes, and Sentry capture path. Existing
// contract test (bff-operator-approval.contract.test.ts) verifies the
// contract from this file unchanged.
// AM-F3 — Czech-key stat strip endpoint mounted BEFORE mountRepliesRoutes so
// Express first-match wins. Supersets the legacy /api/replies/stats response
// with nezpracovane/cekaji_na_odpoved/zajem/dotazy/odmitnuti/dnes buckets that
// back the new clickable header strip. English keys remain for back-compat.
mountRepliesStatsRoute(app, { pool, capture500, safeError })
// AV-F3 (2026-05-19) — regex+dictionary vehicle extractor mounts BEFORE
// mountRepliesRoutes so its specific /:id/extracted-vehicles path resolves
// before any generic /api/replies/:id middleware in the replies module.
mountRepliesExtractRoutes(app, { pool, capture500, safeError })
// Odpovědi — on-demand Ollama reply-draft assist (read-only; operator copies).
mountReplyDraftRoute(app, { pool, capture500, safeError })
mountSearchRoute(app, { pool, capture500, safeError })
mountDataQualityRoute(app, { pool, capture500, safeError })
mountIngestFreshnessRoute(app, { pool, capture500, safeError })
mountDataQualityFixRoute(app, { pool, capture500, safeError })
// AV-F2 (2026-05-19) — auto-classify endpoint + classification log read.
// MUST mount BEFORE mountRepliesRoutes so its /api/replies/:id/auto-classify
// + /api/replies/:id/classification take precedence over the generic
// /api/replies/:id catch-all in the legacy mounter.
mountReplyClassifyEndpoint(app, { pool, capture500, safeError })
mountRepliesRoutes(app, { pool, setRouteTags, capture500, safeError })

// AU-F1 (2026-05-19) — vehicles inventory layer. Connects /replies to
// the operator's actual product workflow (heavy-machinery dealership):
// reply arrives → operator captures vehicle metadata → upserts crm_client
// → tracks deal status. See migration 121 for schema.
mountVehiclesRoutes(app, { pool, capture500, safeError })

// ── Categories + Diagnostics (G4 extracts) ─────────────────────────
// G4 (2026-05-03): /api/categories/* and /api/diagnostics/* extracted into
// src/server-routes/{categories,diagnostics}.js per ADR-008 D2 module
// sequence (after #691 G3 threads). Behavior is byte-equivalent to the
// prior inline declarations.
mountCategoriesRoutes(app, { pool, capture500, safeError })
mountCategoryTreeRoutes(app, { pool, capture500, safeError })
// AJ10b (2026-05-15, #1398) — bulk segment expansion UI endpoint.
mountCampaignSegmentExpansionRoutes(app, { pool, capture500, safeError })
mountDiagnosticsRoutes(app, { pool, capture500, safeError })
mountDedupGuardRoutes(app, { pool, capture500, safeError })

// ── Operator Settings (Sprint AF) ─────────────────────────────────
// GET /api/operator-settings        — list all 9 keys with metadata
// PUT /api/operator-settings/:key   — update one key (X-Confirm-Send gate)
mountOperatorSettingsRoutes(app, { pool, capture500, safeError })

// ── High-Risk Domains admin (Sprint AE2, 2026-05-14) ──────────────
// Dedicated CRUD for operator_settings.presend_smtp_probe_high_risk_domains
// — the comma-separated list that gates the level-2 RCPT-TO probe in the
// X7 pre-send gate (services/campaigns/sender/x7, PR #1379). UI surface
// in /mailboxes → "Pokročilá pravidla — high-risk domény" section.
// GET  /api/operator-settings/high-risk-domains
// PUT  /api/operator-settings/high-risk-domains (X-Confirm-Send: yes)
mountHighRiskDomainsRoutes(app, { pool, capture500, safeError })

// ── ICP Sector Management (Sprint AJ) ─────────────────────────────
// GET    /api/icp-sectors           — list all (filter ?kind=target|anti_target)
// POST   /api/icp-sectors           — create new sector
// PATCH  /api/icp-sectors/:id       — update active, weight, name, nace_prefixes
// DELETE /api/icp-sectors/:id       — soft-delete (active=false + audit log)
mountICPSectorsRoutes(app, { pool, capture500, safeError })

// ── Protection health endpoint (S8) ──────────────────────────────
// Used as a k8s readiness probe and Grafana synthetic check.
// Returns 200 + {status:"ok"} when no critical alert is open.
// Returns 503 + {status:"critical", alerts:[...]} when any are.
app.get('/api/health/protections', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, layer, level, severity, detail, fired_at
        FROM protection_alerts
       WHERE status IN ('open', 'acked')
         AND severity = 'critical'
       ORDER BY fired_at ASC
    `)
    if (rows.length > 0) {
      return res.status(503).json({ status: 'critical', alerts: rows })
    }
    // Check DB reachability (simple SELECT 1).
    await pool.query('SELECT 1')
    res.json({ status: 'ok', checked_at: new Date().toISOString() })
  } catch (e) {
    res.status(503).json({ status: 'err', error: e.message })
  }
})

// Proxy source health monitoring endpoint.
// Attempts relay /v1/proxy-sources first; falls back to deriving source counts
// from the cached proxy-pool snapshot when the relay endpoint is unavailable.
app.get('/api/health/proxy-sources', async (_req, res) => {
  // This endpoint is read by the Mailboxes page on every load; it must NEVER
  // 500 — degraded UI is fine, hard error breaks the page. All failure
  // branches return 200 with an error/degraded flag the frontend can render.
  try {
    let base
    try { base = await getRelayBase(pool) } catch { base = null }
    if (!base) return res.json({ error: 'relay_not_configured', sources: {} })

    const token = process.env.ANTI_TRACE_RELAY_TOKEN || process.env.ANTI_TRACE_TOKEN || ''
    try {
      const r = await fetch(`${base}/v1/proxy-sources`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(5000),
      })
      if (r.ok) {
        return res.json(await r.json())
      }
    } catch { /* fallthrough to pool snapshot */ }

    // Fallback: derive from pool snapshot. Defensive — both relayProxyPool
    // and snap.working may fail / be undefined when relay is unreachable.
    let snap = null
    try { snap = await relayProxyPool(pool) } catch { snap = null }
    const working = Array.isArray(snap?.working) ? snap.working : []
    const sources = {}
    for (const entry of working) {
      const src = entry?.source || 'unknown'
      if (!sources[src]) sources[src] = { count: 0, degraded: false }
      sources[src].count++
    }
    res.json({ sources, from_pool: true, degraded: working.length === 0 })
  } catch (e) {
    // Last resort — log via Sentry but still return 200 with empty payload.
    if (typeof Sentry?.captureException === 'function') Sentry.captureException(e)
    res.json({ error: 'proxy_sources_unavailable', sources: {} })
  }
})

if (process.env.SENTRY_DSN_BFF) Sentry.setupExpressErrorHandler(app)
app.use(createErrorMiddleware())

// S3 — Boot-time schema parity check.
// 5s after server start, fetches /schema from Go backend and compares against
// frozen baseline. Drift is non-fatal — logs warn + Sentry tag schema_drift.
async function bootSchemaCheck() {
  if (process.env.SKIP_SCHEMA_CHECK === '1') return
  try {
    const goUrl = process.env.GO_SERVER_URL || 'http://localhost:8080'
    const apiKey = process.env.OUTREACH_API_KEY || ''
    const r = await fetch(`${goUrl}/schema`, {
      headers: apiKey ? { 'x-api-key': apiKey } : {},
      signal: AbortSignal.timeout(5_000),
    })
    if (!r.ok) {
      console.warn(`[schema-check] Go /schema returned ${r.status} — skipping parity check`)
      return
    }
    const live = await r.json()
    const baselinePath = process.env.SCHEMA_BASELINE_PATH ||
      new URL('./schema-manifest.json', import.meta.url).pathname
    let baseline
    try {
      baseline = JSON.parse(await import('node:fs/promises').then(fs => fs.readFile(baselinePath, 'utf8')))
    } catch (e) {
      console.log('[schema-check] No baseline yet (first deploy?) — skipping')
      return
    }
    if (!baseline.manifest_hash || baseline.manifest_hash.includes('placeholder')) {
      console.log('[schema-check] Baseline is placeholder — run scripts/refresh-schema-baseline.mjs')
      return
    }
    if (live.manifest_hash === baseline.manifest_hash) {
      console.log(`[schema-check] ✓ schema in sync (${live.manifest_hash.slice(0, 14)}…)`)
      return
    }
    // Drift!
    console.warn(`[schema-check] ⚠ DRIFT detected`)
    console.warn(`  baseline: ${baseline.manifest_hash}`)
    console.warn(`  live:     ${live.manifest_hash}`)
    if (typeof Sentry !== 'undefined' && Sentry.captureMessage) {
      Sentry.captureMessage('schema_drift detected at boot', {
        level: 'warning',
        tags: { playbook: 'schema_drift', component: 'bff_boot' },
        extra: {
          baseline_hash: baseline.manifest_hash,
          live_hash: live.manifest_hash,
        },
      })
    }
  } catch (e) {
    console.warn(`[schema-check] error: ${e?.message || e}`)
  }
}

// AP5 — Boot-time mailbox environment boundary check.
//
// Production: warn if test/dev mailboxes are status='active' in the DB
//   (they should not be; contamination risk if production code reads them).
// Dev/test: HARD FAIL if production mailboxes are active in this DB
//   (dev IMAP cron hitting production creds → multi-country fraud lock).
//
// Called from runBffBootInvariants() as check 'ap5-env-boundary'.
// A hard fail causes process.exit(1) so Railway sees crash and retries
// with operator attention rather than silently running in a poisoned state.
async function checkProdMailboxEnvironmentConsistency(pool) {
  if (process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging') {
    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS c FROM outreach_mailboxes WHERE environment != 'production' AND status = 'active'"
    )
    const c = rows[0]?.c || 0
    if (c > 0) {
      console.warn('[boundary] AP5 WARNING: %d non-production mailbox(es) with status=active in DB. ' +
        'Production code paths filter environment=production; this is informational only.', c)
    }
    return true // warn-only in production and staging
  } else {
    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS c FROM outreach_mailboxes WHERE environment = 'production' AND status = 'active'"
    )
    const c = rows[0]?.c || 0
    if (c > 0) {
      const msg = `[boundary] AP5 PRODUCTION_LOCK: NODE_ENV=${process.env.NODE_ENV} but ${c} production mailboxes ` +
        `active in DB. Refusing to start (dev/local IMAP cron must not touch production credentials).`
      console.error(msg)
      throw new Error(msg)
    }
    return true
  }
}

// I1 — Boot-time invariant suite. Five checks that must hold before the BFF
// is considered healthy. Fatal failures (DB pool, OUTREACH_API_KEY) abort
// boot via process.exit(1); warn failures are logged + Sentry breadcrumb
// only so the BFF still serves the degraded UI.
async function runBffBootInvariants() {
  const goUrl = process.env.GO_SERVER_URL || 'http://localhost:8080'
  const apiKey = process.env.OUTREACH_API_KEY || ''

  // ── Phase 1: synchronous + cheap fatal checks ─────────────────────────
  // These must pass before any warn checks run; they are either instant
  // (env-var check) or a single fast DB ping. Kept sequential because later
  // phases depend on the DB being reachable.
  const fatalChecks = [
    {
      name: 'db-pool-reachable',
      severity: 'fatal',
      fn: async () => {
        try {
          const r = await pool.query('SELECT 1 AS ok')
          return r?.rows?.[0]?.ok === 1
        } catch {
          return false
        }
      },
    },
    {
      name: 'outreach-api-key-set',
      severity: 'fatal',
      fn: () => Boolean(apiKey && apiKey.trim().length > 0),
    },
    {
      name: 'state-graph-integrity',
      severity: 'fatal',
      fn: async () => {
        try {
          const { buildMailboxStateGraph } = await import('./src/lib/heal-state-guard.js')
          const sg = buildMailboxStateGraph()
          // Smoke checks: 5 states, retired absorbing, needs_human absorbing
          if (sg.states.length !== 5) return false
          if (sg.canTransition('retired', 'active')) return false
          if (sg.canTransition('needs_human', 'active')) return false
          if (!sg.canTransition('active', 'paused')) return false
          return true
        } catch {
          return false
        }
      },
    },
    {
      name: 'heal-libs-loadable',
      severity: 'fatal',
      fn: async () => {
        try {
          const libs = await Promise.all([
            import('./src/lib/heal-budget.js'),
            import('./src/lib/heal-cascade.js'),
            import('./src/lib/heal-permissions.js'),
            import('./src/lib/invariant.js'),
            import('./src/lib/schema-diff.js'),
          ])
          return libs.every(l => l !== null)
        } catch {
          return false
        }
      },
    },
  ]

  // ── Phase 2: warn checks — run in parallel to cut wall-clock boot time ──
  // Each check is independent; none requires another to complete first.
  // AP5 env-boundary is 'fatal' in non-prod only; treat as independent.
  const warnChecks = [
    {
      name: 'go-server-reachable',
      severity: 'warn',
      fn: async () => {
        try {
          const r = await fetch(`${goUrl}/health`, {
            headers: apiKey ? { 'x-api-key': apiKey } : {},
            signal: AbortSignal.timeout(5_000),
          })
          return r.ok
        } catch {
          return false
        }
      },
    },
    {
      name: 'schema-manifest-loadable',
      severity: 'warn',
      fn: async () => {
        try {
          const baselinePath = process.env.SCHEMA_BASELINE_PATH ||
            new URL('./schema-manifest.json', import.meta.url).pathname
          const fs = await import('node:fs/promises')
          const raw = await fs.readFile(baselinePath, 'utf8')
          const baseline = JSON.parse(raw)
          // Treat placeholder baseline as a warn (still loadable, just not real).
          if (!baseline.manifest_hash || baseline.manifest_hash.includes('placeholder')) {
            return false
          }
          return true
        } catch {
          return false
        }
      },
    },
    {
      name: 'at-least-one-active-mailbox',
      severity: 'warn',
      fn: async () => {
        try {
          // Canonical table is `outreach_mailboxes`; the bare `mailboxes`
          // alias does not exist in production schema. The previous query
          // raised an undefined-relation error which `catch{return false}`
          // swallowed, producing a false-negative warning at boot every
          // time the BFF restarted — operator surface looked degraded
          // even though four active mailboxes were present.
          const r = await pool.query(
            "SELECT COUNT(*)::int AS n FROM outreach_mailboxes WHERE status = 'active' AND environment = 'production'",
          )
          return (r?.rows?.[0]?.n || 0) >= 1
        } catch {
          return false
        }
      },
    },
    {
      name: 'go-schema-endpoint-reachable',
      severity: 'warn',  // non-fatal; schema-check cron still works
      fn: async () => {
        const goUrl = process.env.GO_SERVER_URL || 'http://localhost:8080'
        try {
          const r = await fetch(`${goUrl}/schema`, {
            signal: AbortSignal.timeout(3000),
            headers: process.env.OUTREACH_API_KEY ? { 'x-api-key': process.env.OUTREACH_API_KEY } : {},
          })
          return r.ok
        } catch {
          return false
        }
      },
    },
    // AP5 — environment boundary: dev must not connect to production mailboxes.
    {
      name: 'ap5-env-boundary',
      severity: process.env.NODE_ENV === 'production' ? 'warn' : 'fatal',
      fn: async () => {
        try {
          await checkProdMailboxEnvironmentConsistency(pool)
          return true
        } catch {
          return false
        }
      },
    },
    // Layer 2 (auto-detection): self-test critical GET endpoints via loopback HTTP.
    // Catches SQL schema drift (column/relation missing) at boot rather than
    // when operator opens the dashboard. Incident 2026-05-16 root cause:
    // dashboard/summary returned 500 silently for ~hours before operator noticed.
    //
    // Severity 'warn' (not fatal) — transient DB timeouts shouldn't crash the
    // boot loop. The console.error trace from capture500 (Layer 1) makes any
    // failure immediately visible in BFF log.
    {
      name: 'critical-endpoints-self-test',
      severity: 'warn',
      fn: async () => {
        const apiKey = process.env.OUTREACH_API_KEY
        if (!apiKey) return false
        const port = process.env.PORT || 18001
        const endpoints = [
          '/api/dashboard/summary',
          '/api/mailboxes',
          '/api/campaigns',
          '/api/replies/stats',
        ]
        const failures = []
        await Promise.all(endpoints.map(async (ep) => {
          try {
            const r = await fetch(`http://localhost:${port}${ep}`, {
              signal: AbortSignal.timeout(5000),
              headers: { 'x-api-key': apiKey },
            })
            if (r.status >= 500) failures.push(`${ep}=${r.status}`)
          } catch (e) {
            failures.push(`${ep}=ERR:${e?.message?.slice(0, 40)}`)
          }
        }))
        if (failures.length > 0) {
          console.error(`[boot-self-test] ${failures.length}/${endpoints.length} critical endpoints failing:`, failures.join(', '))
          return false
        }
        return true
      },
    },
  ]

  // Run fatal checks sequentially first (fast — DB ping + sync checks).
  // Then run warn checks in parallel — cuts wall-clock from ~O(N*5s) to ~5s.
  const allResults = []
  let totalPassed = 0, totalFailed = 0, totalWarnings = 0

  try {
    // Phase 1: sequential fatal checks
    const fatalSummary = await runBootInvariants(fatalChecks)
    totalPassed += fatalSummary.passed
    totalFailed += fatalSummary.failed
    totalWarnings += fatalSummary.warnings
    allResults.push(...fatalSummary.results)
  } catch (e) {
    // Fatal failure in Phase 1 — abort immediately.
    console.error(`[invariants] FATAL: ${e?.message || e}`)
    if (e?.stack) console.error(e.stack)
    if (typeof Sentry !== 'undefined' && Sentry.captureException) {
      Sentry.captureException(e, {
        level: 'fatal',
        tags: { component: 'bff_boot', playbook: 'boot_invariant_fatal' },
      })
    }
    if (process.env.SKIP_BOOT_INVARIANT_EXIT !== '1') {
      process.exit(1)
    }
    return
  }

  try {
    // Phase 2: parallel warn checks — independent, safe to run concurrently.
    // We run each fn() directly in parallel rather than through runBootInvariants
    // (which is sequential) to achieve the wall-clock reduction.
    const warnResults = await Promise.allSettled(
      warnChecks.map(async (check) => {
        const severity = check.severity === 'fatal' ? 'fatal' : 'warn'
        let ok = false
        let errorMsg
        try {
          ok = Boolean(await check.fn())
        } catch (e) {
          ok = false
          errorMsg = e instanceof Error ? e.message : String(e)
        }
        return { name: check.name, ok, severity, error: errorMsg }
      }),
    )

    for (const settled of warnResults) {
      // allSettled never rejects individual items — shape is always 'fulfilled'
      const r = settled.status === 'fulfilled' ? settled.value : { name: '?', ok: false, severity: 'warn', error: String(settled.reason) }
      allResults.push(r)
      if (r.ok) {
        totalPassed++
      } else {
        if (r.severity === 'fatal') {
          totalFailed++
        } else {
          totalWarnings++
        }
        console.warn(`[invariants] ${r.severity.toUpperCase()} ${r.name}${r.error ? `: ${r.error}` : ''}`)
      }
    }

    console.log(
      `[invariants] passed=${totalPassed} warnings=${totalWarnings} failed=${totalFailed}`,
    )
  } catch (e) {
    // Unexpected error in Phase 2 orchestration (not individual check failures).
    console.error(`[invariants] FATAL: ${e?.message || e}`)
    if (e?.stack) console.error(e.stack)
    if (typeof Sentry !== 'undefined' && Sentry.captureException) {
      Sentry.captureException(e, {
        level: 'fatal',
        tags: { component: 'bff_boot', playbook: 'boot_invariant_fatal' },
      })
    }
    if (process.env.SKIP_BOOT_INVARIANT_EXIT !== '1') {
      process.exit(1)
    }
  }
}

// Production: serve the Vite build as a SPA behind all API routes.
// Firebase App Hosting sets NODE_ENV=production and PORT; local dev uses
// the Vite dev server so this block never runs locally.
if (process.env.NODE_ENV === 'production') {
  const distDir = join(__dirname, 'dist')
  if (existsSync(distDir)) {
    // Hashed build assets are immutable — the content hash IS the version.
    // Cache them hard, and 404 on a miss (fallthrough:false) instead of
    // falling through to the SPA catch-all below. A stale index.html (held
    // in a returning visitor's cache) requests asset hashes that no longer
    // exist after a redeploy; serving the SPA shell (text/html) for those
    // makes Safari reject the module (nosniff + strict MIME) → white screen.
    app.use('/assets', express.static(join(distDir, 'assets'), {
      immutable: true,
      maxAge: '1y',
      fallthrough: false,
    }))
    // Other root static files (favicon, manifest, etc.). index:false so the
    // SPA shell's cache headers are owned exclusively by the handler below.
    app.use(express.static(distDir, { index: false }))
    // SPA shell: never cache. Every navigation re-fetches index.html so the
    // newest asset hashes are always picked up after a deploy. no-store (not
    // no-cache) because the App Hosting buildpack pins file mtime to 1980 and
    // the shell length is constant, so express's weak size+mtime ETag
    // collides across deploys — a no-cache revalidation would 304 back to the
    // stale document and the white screen would never self-heal.
    app.get('/{*path}', (_req, res) => {
      res.set('Cache-Control', 'no-store')
      res.sendFile(join(distDir, 'index.html'))
    })
  }
}

const PORT = process.env.PORT || 18001
if (process.env.BFF_IMPORT_ONLY !== '1') {
  // S-C1 — Hard-fail boot in production when neither UNSUBSCRIBE_SECRET
  // nor OUTREACH_API_KEY is set. Without one of these, the /unsubscribe
  // HMAC verifier would fall through to an empty key and accept any
  // forged token (mass-unsub attack against the entire contact list).
  // Non-prod boots only WARN so dev/test environments still start.
  if (resolveUnsubscribeSecret() === null) {
    if (IS_PROD) {
      console.error('[boot] FATAL: UNSUBSCRIBE_SECRET or OUTREACH_API_KEY must be set in production')
      process.exit(78)  // EX_CONFIG
    }
    console.warn('[boot] WARN: no UNSUBSCRIBE_SECRET / OUTREACH_API_KEY set — /unsubscribe will return 503')
  }
  const httpServer = app.listen(PORT, () => {
    console.log(`API → http://localhost:${PORT} (sha=${getGitSha().slice(0, 7)}, pid=${process.pid})`)
    if (process.env.NO_CRON !== '1') {
      startCronEngine()
      runBootRecovery()
      // KT-A11 — dashboard metrics aggregator. Independent of crons (no DB
      // mutations); guarded by NO_CRON only to keep CI parity with the rest
      // of the timer fleet.
      startDashboardMetricsAggregator()
    } else {
      console.log('[cron] DISABLED (NO_CRON=1)')
    }
    // Run schema parity check 5s after boot (after Go backend likely up)
    setTimeout(() => { bootSchemaCheck().catch(() => {}) }, 5_000)
    // I1 — Boot-time invariant suite. Runs in parallel with schema check;
    // fatal failures may exit the process.
    if (process.env.SKIP_BOOT_INVARIANTS !== '1') {
      setTimeout(() => { runBffBootInvariants().catch(() => {}) }, 5_000)
    }
  })

  // HARDEN-3: graceful shutdown on SIGTERM/SIGINT.
  //
  // K8s/Railway send SIGTERM ~30s before SIGKILL. The previous code had no
  // shutdown handler, so:
  //   - in-flight requests were cut mid-response (502 to clients)
  //   - 16 setInterval crons kept the loop alive past the grace window
  //
  // Sequence: stop accepting new conns → drain in-flight → close pool →
  // force-exit if drain takes >25s.
  //
  // FIX (zombie-pool-shutdown 2026-05-28):
  //   Bug 1 — `.unref()` on the force-timer meant the event loop could drop it
  //     when only cron timers were alive, so the 25s hard-exit never fired in
  //     the case where httpServer.close() callback never ran (e.g. a stuck
  //     long-poll kept a socket open). Crons re-schedule themselves, so the
  //     loop STAYS alive — but .unref() tells Node "don't count me", so the
  //     timer fires only if something else keeps the loop alive. Removed .unref().
  //   Bug 2 — if httpServer.close() callback never runs (e.g. a long-running
  //     SSE/WebSocket client holds the last connection open), pool.end() never
  //     executes AND process.exit() never fires — process sits alive with a dead
  //     pool for hours. Fix: use Promise.race so we exit within the grace window
  //     regardless of whether httpServer.close() drains cleanly.
  let shuttingDown = false
  const shutdown = (signal) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[shutdown] ${signal} received — draining`)

    // Hard deadline: process MUST exit before Railway issues SIGKILL at ~30s.
    // DO NOT call .unref() — we need this timer to fire even if httpServer.close
    // takes forever (e.g. a hung keep-alive connection).
    const forceTimer = setTimeout(() => {
      console.warn('[shutdown] drain exceeded 25s — forcing exit')
      markPoolEnded() // prevent zombie guard false-positive if pool wasn't ended yet
      process.exit(1)
    }, 25_000)

    // Race: httpServer.close() resolving cleanly vs the hard-deadline timer above.
    // pool.end() happens inside the race so it runs even if httpServer.close never
    // calls back (the timer fires before pool.end resolves → process.exit(1) above).
    const drainAndExit = new Promise((resolve) => {
      httpServer.close((err) => {
        if (err) console.error('[shutdown] http close error:', err.message)
        resolve()
      })
    })

    drainAndExit.then(async () => {
      clearTimeout(forceTimer)
      try {
        stopDashboardMetricsAggregator()
        // Mark pool as ended BEFORE calling pool.end() so that any cron tick
        // or heartbeat that fires in the brief window before process.exit()
        // triggers the zombie guard instead of emitting pool errors.
        markPoolEnded()
        // Close pg pool after HTTP connections are drained.
        await pool.end()
      } catch (e) {
        console.warn('[shutdown] pool.end error:', e.message)
      }
      console.log('[shutdown] clean exit')
      process.exit(0)
    }).catch(() => {
      // drainAndExit is a plain Promise — this branch is unreachable, but
      // belt-and-suspenders: always exit.
      process.exit(1)
    })
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT',  () => shutdown('SIGINT'))
}

export { app, pool, runMailboxHealingCron, runMailboxBounceThrottleCron, parseSentryDSN }
