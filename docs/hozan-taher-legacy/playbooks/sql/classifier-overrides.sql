-- classifier-overrides.sql — reply classifier overrides za posledních 24h
-- Read-only. Použij pro monitoring override rate a tréninkový signal.
SELECT
  al.details->>'from_category'  AS from_cat,
  al.details->>'to_category'    AS to_cat,
  COUNT(*)                       AS override_count,
  MIN(al.created_at)             AS first_override,
  MAX(al.created_at)             AS last_override
FROM operator_audit_log al
WHERE al.created_at > now() - interval '24h'
  AND al.action = 'reply_classify_override'
GROUP BY
  al.details->>'from_category',
  al.details->>'to_category'
ORDER BY override_count DESC;
