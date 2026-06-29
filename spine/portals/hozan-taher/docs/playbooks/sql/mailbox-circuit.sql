-- mailbox-circuit.sql — aktuální stav circuit breaker per mailbox
-- Read-only. Použij pro diagnostiku bounce_hold a consecutive_bounces.
SELECT
  from_address,
  status,
  consecutive_bounces,
  last_score,
  last_score_at,
  total_sent,
  total_bounced,
  ROUND(
    total_bounced::numeric / NULLIF(total_sent, 0) * 100, 1
  ) AS lifetime_bounce_pct,
  last_send_at,
  created_at
FROM outreach_mailboxes
ORDER BY consecutive_bounces DESC, total_sent DESC;
