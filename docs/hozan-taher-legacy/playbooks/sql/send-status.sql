-- send-status.sql — aktuální stav odesílání per running kampaň (posledních 24h)
-- Read-only. Spouštěj přes Railway psql shell nebo Postico.
SELECT
  c.id,
  c.name,
  c.status,
  COUNT(se.id) FILTER (WHERE se.sent_at > now() - interval '24h') AS sent_24h,
  COUNT(be.id) FILTER (WHERE be.created_at > now() - interval '24h') AS bounced_24h,
  ROUND(
    COUNT(be.id) FILTER (WHERE be.created_at > now() - interval '24h')::numeric
    / NULLIF(COUNT(se.id) FILTER (WHERE se.sent_at > now() - interval '24h'), 0) * 100, 1
  ) AS bounce_rate_24h_pct,
  c.created_at AS campaign_created_at
FROM outreach_campaigns c
LEFT JOIN send_events se ON se.campaign_id = c.id
LEFT JOIN bounce_events be ON be.send_event_id = se.id
WHERE c.status IN ('running', 'paused')
GROUP BY c.id, c.name, c.status, c.created_at
ORDER BY sent_24h DESC;
