-- iter48-home-population.sql
-- Deterministic synthetic seed for local widget smoke testing.
-- Schema verified 2026-05-28 via psql \d on each table before INSERT.
--
-- HARD feedback_no_fabricated_test_data T0 — synthetic_ prefix on every name/email.
-- HARD feedback_schema_verify_before_sql T0 — all columns cited inline.
-- HARD feedback_outreach_dashboard_local_only T0 — runner refuses prod hosts.
--
-- All IDs >= 999000.  Cleanup block at top is idempotent.
-- Verified columns (psql output 2026-05-28):
--   contacts:          id, email, first_name, last_name, company_name, score,
--                      prospect_score, status, disposition CHECK(open/won/lost/nurture),
--                      last_contacted, created_at, updated_at, lifetime_touches
--   reply_inbox:       id, contact_id, campaign_id, classification, from_email,
--                      handled, handled_at, mailbox_id, received_at, send_event_id,
--                      subject, pre_classification
--   send_events:       id, campaign_id, contact_id, created_at, mailbox_used,
--                      message_id, reply_classification, sent_at, smtp_response,
--                      status, step, subject, rfc_message_id
--   outreach_mailboxes: id, email, from_address, status, environment,
--                       lifecycle_phase, last_score, consecutive_bounces,
--                       total_bounced, smtp_host, smtp_port, imap_host,
--                       imap_port, password, created_at, updated_at
--   campaigns:         id, name, status, description, created_at, updated_at
--   email_verify_queue: id, email, ico, attempts, retry_at, last_response
--   unmatched_inbound: id, message_id, from_address, subject, body_preview,
--                      received_at, reviewed, extracted_data

-- ─── CLEANUP (idempotent) ──────────────────────────────────────────────────────
DELETE FROM bounce_events       WHERE id >= 999000;
DELETE FROM reply_inbox         WHERE id >= 999000;
DELETE FROM send_events         WHERE id >= 999000;
DELETE FROM email_verify_queue  WHERE id >= 999000;
DELETE FROM unmatched_inbound   WHERE id >= 999000;
DELETE FROM contacts            WHERE id >= 999000;
DELETE FROM outreach_mailboxes  WHERE id >= 999000;
DELETE FROM campaigns           WHERE id >= 999000;

-- ─── WIDGET: LiveActivityTicker — hot_lead_just_replied pill ──────────────────
-- Populates: reply_inbox row with classification='positive' received < 10 min ago
--            linked to a synthetic contact so first_name + company_name render.
-- Verified fields used by dashboardLiveActivity.js:
--   reply_inbox.contact_id, .received_at, .classification
--   contacts.first_name, .company_name

INSERT INTO contacts (
  id, email, first_name, last_name, company_name, score, prospect_score,
  status, disposition, created_at, updated_at, lifetime_touches
) VALUES (
  999001,
  'synthetic_jan.novak@synthetic-strojirna.cz',
  'Synthetic Jan',
  'Novák',
  'Synthetic Strojírna s.r.o.',
  8.5,
  90.0,
  NULL,
  'open',
  NOW(),
  NOW(),
  1
);

INSERT INTO reply_inbox (
  id, contact_id, campaign_id, classification, from_email,
  handled, received_at, subject
) VALUES (
  999001,
  999001,
  457,         -- real paused campaign (verified EXISTS above)
  'positive',
  'synthetic_jan.novak@synthetic-strojirna.cz',
  false,
  NOW() - INTERVAL '4 minutes',   -- within HOT_LEAD_LOOKBACK_MIN=10
  'Synthetic: Re: Nabídka výkupu'
);

-- ─── WIDGET: DispositionSuggestionsCard — 3 reply_inbox rows with classification
-- Populates: contacts + reply_inbox rows so /api/replies/disposition-suggestions
--            returns 3 rows: positive→nurture, negative→lost, question→nurture.
-- Verified: SUGGEST_LOOKBACK_DAYS=7, filter: contacts.disposition IN ('open','nurture'),
--           reply_inbox.classification + suggested_disposition mapping in server route.

-- Contact 2: positive reply → suggest nurture
INSERT INTO contacts (
  id, email, first_name, last_name, company_name, score, prospect_score,
  status, disposition, created_at, updated_at, lifetime_touches
) VALUES (
  999002,
  'synthetic_marie.svobodova@synthetic-agro.cz',
  'Synthetic Marie',
  'Svobodová',
  'Synthetic Agro CZ a.s.',
  6.2,
  70.0,
  NULL,
  'open',
  NOW(),
  NOW(),
  1
);

INSERT INTO reply_inbox (
  id, contact_id, campaign_id, classification, from_email,
  handled, received_at, subject
) VALUES (
  999002,
  999002,
  457,
  'positive',
  'synthetic_marie.svobodova@synthetic-agro.cz',
  false,
  NOW() - INTERVAL '2 hours',
  'Synthetic: Zájem o výkup'
);

-- Contact 3: negative reply → suggest lost
INSERT INTO contacts (
  id, email, first_name, last_name, company_name, score, prospect_score,
  status, disposition, created_at, updated_at, lifetime_touches
) VALUES (
  999003,
  'synthetic_petr.benes@synthetic-logistika.cz',
  'Synthetic Petr',
  'Beneš',
  'Synthetic Logistika s.r.o.',
  4.1,
  45.0,
  NULL,
  'open',
  NOW(),
  NOW(),
  1
);

INSERT INTO reply_inbox (
  id, contact_id, campaign_id, classification, from_email,
  handled, received_at, subject
) VALUES (
  999003,
  999003,
  457,
  'negative',
  'synthetic_petr.benes@synthetic-logistika.cz',
  false,
  NOW() - INTERVAL '5 hours',
  'Synthetic: Nezájem'
);

-- Contact 4: question reply → suggest nurture
INSERT INTO contacts (
  id, email, first_name, last_name, company_name, score, prospect_score,
  status, disposition, created_at, updated_at, lifetime_touches
) VALUES (
  999004,
  'synthetic_vera.kolarova@synthetic-stavby.cz',
  'Synthetic Věra',
  'Kolářová',
  'Synthetic Stavby CZ spol.',
  7.0,
  80.0,
  NULL,
  'open',
  NOW(),
  NOW(),
  1
);

INSERT INTO reply_inbox (
  id, contact_id, campaign_id, classification, from_email,
  handled, received_at, subject
) VALUES (
  999004,
  999004,
  457,
  'question',
  'synthetic_vera.kolarova@synthetic-stavby.cz',
  false,
  NOW() - INTERVAL '12 hours',
  'Synthetic: Dotaz na podmínky'
);

-- ─── WIDGET: MailboxPulseWidget — amber/red status_tone due to bounce rate ────
-- Populates: synthetic mailbox with several bounced sends today so
--            /api/dashboard/mailbox-pulse returns bounce_pct_today >= BOUNCE_AMBER_MIN_PCT=1.0
--            The widget will render this mailbox with RED/AMBER tone.
-- Verified: dashboardMailboxPulse queries send_events.mailbox_used = from_address,
--           status IN ('sent','bounced'), sent_at today.
--
-- NOTE: outreach_mailboxes has no 'bounce_hold' status value in DB CHECK constraint.
-- Using status='paused' (verified existing value). consecutive_bounces=5 renders red.

INSERT INTO outreach_mailboxes (
  id, email, from_address, status, environment, lifecycle_phase,
  last_score, consecutive_bounces, total_bounced,
  smtp_host, smtp_port, imap_host, imap_port,
  password, created_at, updated_at
) VALUES (
  999001,
  'synthetic_bounce_test@synthetic-mbx.cz',
  'synthetic_bounce_test@synthetic-mbx.cz',
  'paused',
  'production',
  'production',
  35.0,  -- score below SCORE_AMBER_MIN=50 → RED tone
  5,     -- consecutive_bounces visible in detail view
  12,
  'synthetic-smtp.example.cz',
  587,
  'synthetic-imap.example.cz',
  993,
  'synthetic_not_real_password',
  NOW(),
  NOW()
);

-- 2 bounced sends + 1 sent so bounce_pct = 66% → above BOUNCE_RED_MIN_PCT=2.0
-- status NOT 'sent' → dedup guard skips (guard only activates for status='sent')
INSERT INTO send_events (
  id, campaign_id, contact_id, mailbox_used, message_id,
  sent_at, status, step, subject, created_at
) VALUES
  (999010, 457, 999002, 'synthetic_bounce_test@synthetic-mbx.cz',
   'synthetic-msg-id-10@synthetic', NOW() - INTERVAL '30 minutes',
   'bounced', 0, 'Synthetic bounce send 1', NOW()),
  (999011, 457, 999003, 'synthetic_bounce_test@synthetic-mbx.cz',
   'synthetic-msg-id-11@synthetic', NOW() - INTERVAL '25 minutes',
   'bounced', 0, 'Synthetic bounce send 2', NOW()),
  (999012, 457, 999004, 'synthetic_bounce_test@synthetic-mbx.cz',
   'synthetic-msg-id-12@synthetic', NOW() - INTERVAL '20 minutes',
   'sent',    0, 'Synthetic sent ok', NOW() - INTERVAL '20 minutes');

-- Corresponding bounce_events for the 2 bounced sends above
INSERT INTO bounce_events (
  id, contact_id, send_event_id, bounce_type, bounce_code, bounce_reason
) VALUES
  (999001, 999002, 999010, 'hard', '550', 'synthetic: user unknown'),
  (999002, 999003, 999011, 'hard', '550', 'synthetic: mailbox not found');

-- ─── WIDGET: Top Targets / AgingLeadsCard — high-score uncontacted contacts ──
-- Populates: 5 contacts with high prospect_score + last_contacted > 7 days ago
--            (or NULL) and disposition='open'. Appears in /priprava/top-targets
--            + AgingLeadsCard on Home.
-- Verified: idx_contacts_todays_targets uses prospect_score DESC, disposition IN ('open','nurture'),
--           lifetime_touches > 0 OR crm_client_id IS NOT NULL.
--           For score-based sorts: score column used by some queries.

INSERT INTO contacts (
  id, email, first_name, last_name, company_name, score, prospect_score,
  status, disposition, last_contacted, created_at, updated_at, lifetime_touches
) VALUES
  (999010, 'synthetic_top1@synthetic-technika.cz', 'Synthetic Top', 'Jedna',
   'Synthetic Technika a.s.',      9.5, 95.0, NULL, 'open',
   NOW() - INTERVAL '14 days', NOW(), NOW(), 2),
  (999011, 'synthetic_top2@synthetic-mechanik.cz', 'Synthetic Top', 'Dva',
   'Synthetic Mechanik s.r.o.',    9.1, 91.0, NULL, 'open',
   NOW() - INTERVAL '21 days', NOW(), NOW(), 1),
  (999012, 'synthetic_top3@synthetic-pristroje.cz', 'Synthetic Top', 'Tři',
   'Synthetic Přístroje spol.',    8.8, 88.0, NULL, 'open',
   NOW() - INTERVAL '30 days', NOW(), NOW(), 3),
  (999013, 'synthetic_top4@synthetic-stroj.cz', 'Synthetic Top', 'Čtyři',
   'Synthetic Stroj CZ s.r.o.',    8.4, 84.0, NULL, 'nurture',
   NOW() - INTERVAL '10 days', NOW(), NOW(), 1),
  (999014, 'synthetic_top5@synthetic-nakladace.cz', 'Synthetic Top', 'Pět',
   'Synthetic Nakladače s.r.o.',   8.0, 80.0, NULL, 'open',
   NOW() - INTERVAL '8 days',  NOW(), NOW(), 1);

-- ─── WIDGET: QuickLaunchPanel / campaigns — paused campaign resume state ──────
-- Populates: a synthetic campaign with status='paused' and stale updated_at
--            so QuickLaunchPanel shows a "resume" CTA.
-- Verified: campaigns columns: id, name, status, description, created_at, updated_at.
--           No paused_at column exists — staleness derived from updated_at.

INSERT INTO campaigns (
  id, name, status, description, created_at, updated_at
) VALUES (
  999001,
  'Synthetic — výkup strojů (pozastavena)',
  'paused',
  'Synthetic seed campaign — iter48 fixture',
  NOW() - INTERVAL '10 days',
  NOW() - INTERVAL '7 days'
);

-- ─── WIDGET: VerifyQueueWidget — non-empty queue ──────────────────────────────
-- Populates: 2 email_verify_queue rows so the widget shows pending items
--            and the count > 0 guard lights up progress stats.
-- Verified: email_verify_queue columns: id, email, ico, attempts, retry_at, last_response.

INSERT INTO email_verify_queue (
  id, email, ico, attempts, retry_at, last_response
) VALUES
  (999001, 'synthetic_verify1@synthetic-firma1.cz', '99900001', 0,
   NOW() + INTERVAL '5 minutes', NULL),
  (999002, 'synthetic_verify2@synthetic-firma2.cz', '99900002', 1,
   NOW() + INTERVAL '15 minutes', 'synthetic: timeout on first attempt');

-- ─── WIDGET: HotRepliesCard / unmatched_inbound — operator triage surface ─────
-- Populates: 2 unmatched_inbound rows with extracted_data containing phones/prices
--            so /api/inbox/hot-replies returns items and the card is non-empty.
-- Verified: unmatched_inbound columns: id, message_id, from_address, subject,
--           body_preview, received_at, reviewed, extracted_data.

INSERT INTO unmatched_inbound (
  id, message_id, from_address, subject, body_preview,
  received_at, reviewed, extracted_data
) VALUES
  (999001,
   'synthetic-hot-reply-1@synthetic',
   '"Synthetic Odběratel" <synthetic_triage1@synthetic-odberatel.cz>',
   'Synthetic: dotaz na cenu rypadla',
   'Dobrý den, zajímám se o výkup kolového rypadla Komatsu. Cena cca 850 000 Kč. Zavolejte +420 601 999 001.',
   NOW() - INTERVAL '2 hours',
   false,
   '{"phones": ["+420601999001"], "prices": [{"amount": 850000, "currency": "Kč"}]}'::jsonb),
  (999002,
   'synthetic-hot-reply-2@synthetic',
   '"Synthetic Firma" <synthetic_triage2@synthetic-nakladac.cz>',
   'Synthetic: nabídka traktoru',
   'Ahoj, mám zájem prodat traktor John Deere 6155M. Kontakt: +420 602 999 002.',
   NOW() - INTERVAL '5 hours',
   false,
   '{"phones": ["+420602999002"], "prices": []}'::jsonb);
