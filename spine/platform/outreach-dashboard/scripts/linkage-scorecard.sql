-- linkage-scorecard.sql — the deterministic compass for the "Produkční raketa"
-- loop. North-star = maximally auto-link all data; this prints, per relationship
-- pair, how many rows are STILL unlinked-but-matchable / orphaned / not flowing.
-- The loop logs these numbers every tick so the Δ (decreasing slack) is the
-- measurable progress signal — not a vibe.
--
-- DESIGN: every query is fast. Big tables (contacts ~405k, companies ~426k) are
-- only ever probed from the SMALL side (crm_clients ~2k, reply_inbox ~100s) via
-- an INDEXED column (idx_contacts_email_lower, idx_contacts_crm_client_id,
-- idx_companies_crm_client_id, idx_leads_reply_inbox_dedup, idx_vehicles_*).
-- NEVER add a query that seq-scans a 400k table (e.g. companies.email has no
-- lower(email) index — do not email-join companies here).
--
-- Run:  pnpm scorecard        (apps/outreach-dashboard)
-- Lower is better for every row except the "(total)" rows.

WITH cc AS (
  SELECT id, lower(NULLIF(TRIM(COALESCE(NULLIF(email,''), email_primary)), '')) AS em
  FROM crm_clients
)
SELECT * FROM (
  -- ── headline totals (context, not slack) ──────────────────────────────────
  SELECT 1 AS ord, '(total) crm_clients'                                  AS metric, count(*)::bigint AS n FROM crm_clients
  UNION ALL SELECT 2, '(total) vehicles',                                      count(*) FROM vehicles
  UNION ALL SELECT 3, '(total) reply_inbox',                                   count(*) FROM reply_inbox
  UNION ALL SELECT 4, '(total) leads',                                         count(*) FROM leads

  -- ── linkage slack (lower = better) ────────────────────────────────────────
  -- contacts that email-match a crm_client but whose crm_client_id is NULL
  UNION ALL SELECT 10, 'contacts: crm-matchable, FK NULL',
    count(*) FROM cc JOIN contacts ct ON lower(TRIM(ct.email)) = cc.em
    WHERE cc.em IS NOT NULL AND ct.crm_client_id IS NULL

  -- crm_clients linked from NEITHER a contact NOR a company (orphan CRM record)
  UNION ALL SELECT 11, 'crm_clients: orphan (no contact, no company)',
    count(*) FROM crm_clients c
    WHERE NOT EXISTS (SELECT 1 FROM contacts ct WHERE ct.crm_client_id = c.id)
      AND NOT EXISTS (SELECT 1 FROM companies co WHERE co.crm_client_id = c.id)

  -- replies whose body names a vehicle but no vehicle was captured (flow gap)
  UNION ALL SELECT 12, 'reply_inbox: vehicle-mention, 0 captured vehicle',
    count(*) FROM reply_inbox r
    WHERE COALESCE(r.body_text,'') <> ''
      AND NOT EXISTS (SELECT 1 FROM vehicles v WHERE v.source_reply_id = r.id)
      AND (r.body_text || COALESCE(r.subject,'')) ~* '(bagr|naklada|jeřáb|rypadl|tatra|avia|iveco|mercedes|dacia|ford|fiat|renault|volkswagen|mazda|jeep|bazos\.cz|prodá|prodej|nabíz)'

  -- (Removed) "reply → lead" row. Operator decision (2026-05-30): "leady jsou
  -- vozidla" — the separate `leads` funnel is dead (the /leads route was already
  -- redirected away 2026-05-15, "sales funnel never used"). The real lead
  -- pipeline IS the Vozidla inventory: a hot reply → a vehicle offer. So the
  -- actionable "hot reply not in the pipeline" slack is the reply→vehicle row
  -- above (id 12), not a reply→lead row. Tracking reply→lead was measuring a
  -- dead abstraction.

  -- captured vehicles with no company link, but the sender email maps to one
  UNION ALL SELECT 14, 'vehicles: company NULL but sender→company matchable',
    count(*) FROM vehicles v
    WHERE v.company_id IS NULL AND COALESCE(v.source_reply_email,'') <> ''
      AND EXISTS (
        SELECT 1 FROM contacts ct JOIN companies co ON co.ico = ct.ico
        WHERE lower(TRIM(ct.email)) = lower(TRIM(v.source_reply_email))
          AND COALESCE(ct.ico,'') <> ''
      )

  -- inbound that the operator hasn't triaged yet
  UNION ALL SELECT 15, 'unmatched_inbound: not reviewed',
    count(*) FROM unmatched_inbound WHERE reviewed IS NOT TRUE

  -- ── data QUALITY smells (lower = better) ──────────────────────────────────
  -- The scorecard measured only LINKAGE (NULL FK) — blind to data quality. A
  -- misclassification win (61aba648) couldn't be tracked or regression-guarded.
  -- These rows make quality bugs visible + caught like linkage ones.
  --
  -- Regression guard for 61aba648: a reply classified 'positive' whose body
  -- carries a clear decline phrase = a misclassification. Must stay 0.
  -- regex_v2 (2026-05-31): extended with the short-decline + opt-out phrases
  -- that leaked to 'positive' because v1 scored the QUOTED original outbound.
  -- These are anchored to the reply head / line-start so a brand keyword in a
  -- quoted block below can't reintroduce the false positive. Caught + fixed:
  -- ids 42/81/96/105/108 (declines) + 101 (opt-out). Stays 0 = win locked.
  UNION ALL SELECT 20, 'quality: positive reply with decline phrase (misclassified)',
    count(*) FROM reply_inbox
    WHERE classification = 'positive'
      AND body_text ~* '(nehodl[áa]me|nezab[ýy]v[áa]m|nechci|nen[íi] z[áa]jem|vy[řr]a[ďd]te|nem[áa]m na prodej|nem[áa]me z[áa]jem|^\s*nem[áa]m\b|moment[áa]ln[ěe]\s+ne|aktu[áa]ln[ěe]\s+ne|j[áa]\s+nic\s+nem[áa]m|nekontaktujte)'

  -- replies WITH a body that were never classified (actionable backlog).
  -- Bodyless rows (Go-proxied subjects) are excluded — NULL is correct there,
  -- nothing to classify. So a non-zero here = a real classifiable reply the
  -- auto-classify cron missed (regression guard after the 24h-lookback fix).
  UNION ALL SELECT 21, 'quality: reply_inbox unclassified (has body)',
    count(*) FROM reply_inbox WHERE classification IS NULL AND COALESCE(body_text,'') <> ''
) q
ORDER BY ord;
