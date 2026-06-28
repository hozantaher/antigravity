// AlertToastListener.jsx — Sprint M7
//
// Mounts a global EventSource('/api/alerts/stream') and converts every
// `mailbox_alert_fired` SSE event into a useToast toast so the operator
// is notified about deliverability threshold breaches on any dashboard page
// without having to navigate to /analytics.
//
// Reconnect strategy (feedback_external_io_backoff):
//   Initial delay 1s; doubles on each failure; capped at 30s; ±25% jitter.
//   Resets to 1s on a successful `hello` event (confirming the connection
//   is healthy, not just open).
//
// PII (feedback_no_pii_in_commands):
//   The BFF redacts the from_address to "xxxx@domain" before it reaches
//   the SSE wire, so nothing here needs to sanitise further.
//
// EventSource note (feedback_playwright_route_gotcha):
//   page.route() does not intercept EventSource requests in Playwright.
//   Tests that exercise this component must open the stream via
//   page.evaluate(() => fetch('/api/alerts/stream', ...)) or skip the
//   stream assertion and test the toast render separately.

import { useEffect, useRef } from 'react'
import { useToast } from './Toast'

const INITIAL_DELAY_MS = 1_000
const MAX_DELAY_MS     = 30_000

/**
 * Returns a toast message string for a mailbox_alert_fired SSE event.
 *
 * @param {{ mailbox_email: string, alert_type: string, label: string, severity: string }} data
 * @returns {string}
 */
function buildToastMessage(data) {
  const mb = data.mailbox_email || '[neznámá]'
  return `Schránka ${mb}: ${data.label}`
}

export function AlertToastListener() {
  const toast = useToast()
  const delayRef    = useRef(INITIAL_DELAY_MS)
  const esRef       = useRef(null)
  const timerRef    = useRef(null)
  const mountedRef  = useRef(true)

  useEffect(() => {
    mountedRef.current = true

    function connect() {
      if (!mountedRef.current) return
      const es = new EventSource('/api/alerts/stream')
      esRef.current = es

      es.addEventListener('hello', () => {
        // Successful connection — reset backoff.
        delayRef.current = INITIAL_DELAY_MS
      })

      es.addEventListener('mailbox_alert_fired', (e) => {
        let data
        try { data = JSON.parse(e.data) } catch { return }
        if (!mountedRef.current) return
        const msg   = buildToastMessage(data)
        const level = data.severity === 'critical' ? 'err' : 'warn'
        // Extended duration (8s) so operator has time to read + act.
        toast(msg, level, { duration: 8_000 })
      })

      es.onerror = () => {
        es.close()
        esRef.current = null
        if (!mountedRef.current) return
        // Exponential backoff with ±25% jitter.
        const jitter = (Math.random() * 0.5 - 0.25) * delayRef.current
        const delay  = Math.min(MAX_DELAY_MS, delayRef.current + jitter)
        delayRef.current = Math.min(MAX_DELAY_MS, delayRef.current * 2)
        timerRef.current = setTimeout(connect, delay)
      }
    }

    connect()

    return () => {
      mountedRef.current = false
      if (timerRef.current) clearTimeout(timerRef.current)
      if (esRef.current)   { esRef.current.close(); esRef.current = null }
    }
  }, [toast])

  // Renders nothing — side-effect only.
  return null
}
