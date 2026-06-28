-- bounce-investigation.sql — bounce rate per mailbox za posledních 24h
-- Read-only. Použij pro diagnostiku spike bounce rate.
SELECT
  m.from_address,
  m.status AS mailbox_status,
  m.consecutive_bounces,
  COUNT(se.id)                     AS sent_24h,
  COUNT(be.id)                     AS bounced_24h,
  ROUND(
    COUNT(be.id)::numeric
    / NULLIF(COUNT(se.id), 0) * 100, 1
  )                                AS bounce_rate_24h_pct,
  COUNT(DISTINCT se.domain)        AS distinct_target_domains
FROM outreach_mailboxes m
LEFT JOIN send_events se
  ON se.mailbox_address = m.from_address
  AND se.sent_at > now() - interval '24h'
LEFT JOIN bounce_events be
  ON be.send_event_id = se.id
GROUP BY m.from_address, m.status, m.consecutive_bounces
ORDER BY bounce_rate_24h_pct DESC NULLS LAST, sent_24h DESC;
