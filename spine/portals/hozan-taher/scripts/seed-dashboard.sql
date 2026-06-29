-- seed-dashboard.sql
-- Adds test data for outreach-dashboard so all pages have data to display.
--
-- Self-contained: includes base data (domains, contacts) so it can be run
-- directly after migrations without needing test-local.sh first.
-- Idempotent: all inserts use ON CONFLICT DO NOTHING.

BEGIN;

-- ══════════════════════════════════════════════════════════════════════
-- 0. Base data: domain + contacts (prerequisites for all other seeds)
-- ══════════════════════════════════════════════════════════════════════

INSERT INTO outreach_domains (id, domain, domain_type, mx_verified, mx_provider,
    active_contacts, total_sent, daily_send_cap, is_suppressed)
VALUES
  (1, 'local.dev',       'corporate', true,  'greenmail', 3, 3, 10, false),
  (2, 'strojirny.cz',    'corporate', true,  'google',    0, 0, 5,  false),
  (3, 'kovarna.cz',      'corporate', true,  'google',    0, 0, 5,  false)
ON CONFLICT DO NOTHING;

SELECT setval('outreach_domains_id_seq', GREATEST(3, (SELECT COALESCE(MAX(id), 0) FROM outreach_domains)));

INSERT INTO outreach_contacts (id, email, email_hash, domain_id,
    first_name, last_name, company_name, ico, region,
    industry_tags, company_size, legal_form,
    consent_score, consent_factors, last_score_update,
    status, source, firmy_cz_id,
    total_sent, total_opened, total_replied, total_bounced)
VALUES
  (1, 'test@local.dev',  md5('test@local.dev'),  1,
   'Jan',  'Novák',    'Strojírny Praha s.r.o.',        '12345678', 'Praha',
   ARRAY['machinery','metalwork'], '25 - 49 zaměstnanců', 's.r.o.',
   0.72, '{"honeypot":0,"domain":0.1,"industry":0.3,"engagement":0.32}'::jsonb,
   NOW() - INTERVAL '1 day', 'active', 'firmy-cz', 1001,
   1, 1, 0, 0),
  (2, 'test2@local.dev', md5('test2@local.dev'), 1,
   'Petr', 'Svoboda',  'Kovárna Brno a.s.',             '87654321', 'Brno',
   ARRAY['metalwork','construction'], '50 - 99 zaměstnanců', 'a.s.',
   0.85, '{"honeypot":0,"domain":0.15,"industry":0.35,"engagement":0.35}'::jsonb,
   NOW() - INTERVAL '1 day', 'active', 'firmy-cz', 1002,
   1, 1, 1, 0),
  (3, 'test3@local.dev', md5('test3@local.dev'), 1,
   'Eva',  'Dvořáková', 'Průmyslové Dílny Ostrava s.r.o.', '11223344', 'Ostrava',
   ARRAY['machinery','construction'], '10 - 19 zaměstnanců', 's.r.o.',
   0.48, '{"honeypot":0,"domain":0.05,"industry":0.2,"engagement":0.23}'::jsonb,
   NOW() - INTERVAL '2 days', 'active', 'firmy-cz', 1003,
   1, 0, 0, 0)
ON CONFLICT DO NOTHING;

SELECT setval('outreach_contacts_id_seq', GREATEST(3, (SELECT COALESCE(MAX(id), 0) FROM outreach_contacts)));

-- ══════════════════════════════════════════════════════════════════════
-- 0b. Suppressions sample
-- ══════════════════════════════════════════════════════════════════════
INSERT INTO outreach_suppressions (email, domain, reason)
VALUES
  (NULL, 'blocked-domain.cz', 'manual'),
  (NULL, 'spam-trap.eu',      'bounce')
ON CONFLICT DO NOTHING;

-- ══════════════════════════════════════════════════════════════════════
-- 1. Threads (one per contact, campaign_id=1)
-- ══════════════════════════════════════════════════════════════════════

INSERT INTO outreach_threads (id, contact_id, campaign_id, status, current_step, next_action_at, next_action, pause_until, created_at, updated_at)
VALUES
  (1, 1, 1, 'active',  1, NOW() + INTERVAL '1 day', 'send_followup', NULL,                      NOW() - INTERVAL '3 days', NOW()),
  (2, 2, 1, 'replied', 1, NULL,                      NULL,            NULL,                      NOW() - INTERVAL '3 days', NOW() - INTERVAL '1 day'),
  (3, 3, 1, 'paused',  1, NULL,                      NULL,            NOW() + INTERVAL '7 days', NOW() - INTERVAL '3 days', NOW())
ON CONFLICT (id) DO NOTHING;

SELECT setval('outreach_threads_id_seq', GREATEST(3, (SELECT COALESCE(MAX(id), 0) FROM outreach_threads)));

-- ══════════════════════════════════════════════════════════════════════
-- 2. Outbound messages (one per thread)
-- ══════════════════════════════════════════════════════════════════════

INSERT INTO outreach_messages (id, thread_id, direction, message_id, subject, body_preview, mailbox_used, sent_at, opened_at, humanize_applied, is_bump, created_at)
VALUES
  -- Contact 1 (Strojírny Praha) — active, opened
  (1, 1, 'outbound', 'seed-msg-1',
   'Poptávka — Strojírny Praha s.r.o.',
   'Dobrý den, rád bych se zeptal na vaše služby...',
   'test@local.dev',
   NOW() - INTERVAL '3 days',
   NOW() - INTERVAL '3 days' + INTERVAL '4 hours',
   false, false,
   NOW() - INTERVAL '3 days'),

  -- Contact 2 (Kovárna Brno) — replied, opened
  (2, 2, 'outbound', 'seed-msg-2',
   'Poptávka — Kovárna Brno a.s.',
   'Dobrý den, rád bych se zeptal na vaše služby...',
   'test@local.dev',
   NOW() - INTERVAL '3 days',
   NOW() - INTERVAL '3 days' + INTERVAL '4 hours',
   false, false,
   NOW() - INTERVAL '3 days'),

  -- Contact 3 (Průmyslové Dílny Ostrava) — paused, not opened
  (3, 3, 'outbound', 'seed-msg-3',
   'Poptávka — Průmyslové Dílny Ostrava s.r.o.',
   'Dobrý den, rád bych se zeptal na vaše služby...',
   'test@local.dev',
   NOW() - INTERVAL '3 days',
   NULL,
   false, false,
   NOW() - INTERVAL '3 days')
ON CONFLICT (message_id) DO NOTHING;

-- ══════════════════════════════════════════════════════════════════════
-- 3. Inbound reply for contact 2 (Kovárna Brno)
-- ══════════════════════════════════════════════════════════════════════

INSERT INTO outreach_messages (id, thread_id, direction, message_id, in_reply_to, subject, body_preview, reply_type, sentiment, replied_at, mailbox_used, humanize_applied, is_bump, created_at)
VALUES
  (4, 2, 'inbound', 'seed-msg-4', 'seed-msg-2',
   'Re: Poptávka — Kovárna Brno a.s.',
   'Děkujeme za zájem, pošleme nabídku.',
   'positive', 'positive',
   NOW() - INTERVAL '1 day',
   'test@local.dev',
   false, false,
   NOW() - INTERVAL '1 day')
ON CONFLICT (message_id) DO NOTHING;

SELECT setval('outreach_messages_id_seq', GREATEST(4, (SELECT COALESCE(MAX(id), 0) FROM outreach_messages)));

-- ══════════════════════════════════════════════════════════════════════
-- 4. Events for timeline
-- ══════════════════════════════════════════════════════════════════════

-- Guard: only insert if no seed events exist yet
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM outreach_events WHERE metadata @> '{"source": "seed"}') THEN

    -- sent events for all 3 contacts
    INSERT INTO outreach_events (contact_id, thread_id, message_id, event_type, metadata, created_at)
    VALUES
      (1, 1, 1, 'sent',    '{"source": "seed"}'::jsonb, NOW() - INTERVAL '3 days'),
      (2, 2, 2, 'sent',    '{"source": "seed"}'::jsonb, NOW() - INTERVAL '3 days'),
      (3, 3, 3, 'sent',    '{"source": "seed"}'::jsonb, NOW() - INTERVAL '3 days');

    -- opened events for contacts 1 and 2
    INSERT INTO outreach_events (contact_id, thread_id, message_id, event_type, metadata, created_at)
    VALUES
      (1, 1, 1, 'opened',  '{"source": "seed"}'::jsonb, NOW() - INTERVAL '3 days' + INTERVAL '4 hours'),
      (2, 2, 2, 'opened',  '{"source": "seed"}'::jsonb, NOW() - INTERVAL '3 days' + INTERVAL '4 hours');

    -- replied event for contact 2
    INSERT INTO outreach_events (contact_id, thread_id, message_id, event_type, metadata, created_at)
    VALUES
      (2, 2, 4, 'replied', '{"source": "seed"}'::jsonb, NOW() - INTERVAL '1 day');

  END IF;
END $$;

-- ══════════════════════════════════════════════════════════════════════
-- 5. Update outreach_contacts counters
-- ══════════════════════════════════════════════════════════════════════

-- Link contacts to their domain (local.dev = domain id 1)
UPDATE outreach_contacts
SET domain_id = 1
WHERE domain_id IS NULL AND email LIKE '%@local.dev';

-- All contacts: total_sent=1, last_contacted=NOW()-3days
UPDATE outreach_contacts
SET total_sent = 1,
    last_contacted = NOW() - INTERVAL '3 days'
WHERE id IN (1, 2, 3);

-- Contacts 1 and 2: total_opened=1
UPDATE outreach_contacts
SET total_opened = 1
WHERE id IN (1, 2);

-- Contact 2: total_replied=1, last_replied=NOW()-1day
UPDATE outreach_contacts
SET total_replied = 1,
    last_replied = NOW() - INTERVAL '1 day'
WHERE id = 2;

-- ══════════════════════════════════════════════════════════════════════
-- 6. Companies (10 firms, full quality-tier spread)
-- ══════════════════════════════════════════════════════════════════════

INSERT INTO companies (id, firmy_cz_id, ico, name, email, telephone, website,
    street_address, address_locality, postal_code,
    description, velikost_firmy, pravni_forma, category_path,
    rating_value, rating_count,
    quality_tier, contact_count, thread_count, total_sent, total_replied,
    best_consent_score, last_contacted, last_replied,
    synced_at, created_at, updated_at)
VALUES
  -- engaged — has replied thread
  (1, 1001, '12345678', 'Strojírny Praha s.r.o.',         'info@strojirny-praha.cz', '+420212345678', 'www.strojirny-praha.cz',
   'Průmyslová 1', 'Praha', '10000',
   'Výroba a opravy průmyslových strojů a CNC obráběcích center.', '25 - 49 zaměstnanců', 's.r.o.', 'Průmysl > Strojírenství',
   4.2, 12, 'engaged', 1, 1, 1, 0, 0.72,
   NOW() - INTERVAL '3 days', NULL,
   NOW(), NOW(), NOW()),
  -- contacted — thread exists but no reply
  (2, 1002, '23456789', 'Kovárna Brno a.s.',               'info@kovarna-brno.cz', '+420513456789', 'www.kovarna-brno.cz',
   'Kovářská 5', 'Brno', '60200',
   'Kovoobrábění a svařování ocelových konstrukcí.', '50 - 99 zaměstnanců', 'a.s.', 'Průmysl > Kovovýroba',
   4.5, 8, 'contacted', 1, 1, 1, 1, 0.85,
   NOW() - INTERVAL '3 days', NOW() - INTERVAL '1 day',
   NOW(), NOW(), NOW()),
  -- contacted — paused thread
  (3, 1003, '34567890', 'Průmyslové Dílny Ostrava s.r.o.', 'info@dilny-ostrava.cz', '+420596789012', 'www.dilny-ostrava.cz',
   'Nádražní 22', 'Ostrava', '70200',
   'Montáž a výroba průmyslových zařízení.', '10 - 19 zaměstnanců', 's.r.o.', 'Průmysl > Strojírenství',
   3.8, 5, 'contacted', 1, 1, 1, 0, 0.48,
   NOW() - INTERVAL '3 days', NULL,
   NOW(), NOW(), NOW()),
  -- scored — high consent, no thread yet
  (4, 1004, '45678901', 'TechnoPlast Plzeň s.r.o.',        'info@technoplast.cz', '+420377890123', 'www.technoplast.cz',
   'Škodova 7', 'Plzeň', '30100',
   'Výroba plastových komponentů pro automobilový průmysl.', '100 - 249 zaměstnanců', 's.r.o.', 'Průmysl > Plasty',
   4.0, 15, 'scored', 0, 0, 0, 0, 0.61,
   NULL, NULL,
   NOW(), NOW(), NOW()),
  -- scored — contact enriched, score above threshold
  (5, 1005, '56789012', 'MetalWorks Liberec s.r.o.',        NULL, '+420485901234', 'www.metalworks-liberec.cz',
   'Tovární 3', 'Liberec', '46001',
   'Přesné kovové díly a odlitky pro strojní průmysl.', '25 - 49 zaměstnanců', 's.r.o.', 'Průmysl > Kovovýroba',
   3.5, 3, 'scored', 0, 0, 0, 0, 0.55,
   NULL, NULL,
   NOW(), NOW(), NOW()),
  -- enriched — contact exists, score below threshold
  (6, 1006, '67890123', 'Svářečská Dílna Jihlava s.r.o.',   'info@svarecska-jihlava.cz', '+420567012345', NULL,
   'Havlíčkova 14', 'Jihlava', '58601',
   'Svářečské a zámečnické práce. Výroba ocelových konstrukcí na míru.', '5 - 9 zaměstnanců', 's.r.o.', 'Řemesla > Svářečství',
   4.8, 21, 'enriched', 0, 0, 0, 0, 0.38,
   NULL, NULL,
   NOW(), NOW(), NOW()),
  -- enriched
  (7, 1007, '78901234', 'Obrábění CNC Hradec s.r.o.',       'info@cnc-hradec.cz', '+420495123456', 'www.cnc-hradec.cz',
   'Průmyslová 8', 'Hradec Králové', '50002',
   'CNC obrábění na zakázku. Sériová i kusová výroba.', '10 - 19 zaměstnanců', 's.r.o.', 'Průmysl > CNC obrábění',
   4.3, 9, 'enriched', 0, 0, 0, 0, 0.35,
   NULL, NULL,
   NOW(), NOW(), NOW()),
  -- raw — no linked contact, no email
  (8, 1008, NULL, 'Malá Dílna Tábor',                       NULL, NULL, NULL,
   'Náměstí 1', 'Tábor', '39001',
   NULL, '1 - 4 zaměstnanci', 'FO', 'Řemesla',
   0.0, 0, 'raw', 0, 0, 0, 0, 0.0,
   NULL, NULL,
   NOW(), NOW(), NOW()),
  -- raw
  (9, 1009, NULL, 'Zámečnictví Kutná Hora',                  NULL, '+420327234567', NULL,
   'Čechova 3', 'Kutná Hora', '28401',
   'Zámečnické a klempířské práce.', '1 - 4 zaměstnanci', 'FO', 'Řemesla > Zámečnictví',
   3.2, 2, 'raw', 0, 0, 0, 0, 0.0,
   NULL, NULL,
   NOW(), NOW(), NOW()),
  -- raw
  (10, 1010, NULL, 'Klempířství Znojmo s.r.o.',               NULL, '+420515345678', NULL,
   'Horní náměstí 5', 'Znojmo', '66902',
   'Klempířské práce, oplechování střech.', '1 - 4 zaměstnanci', 's.r.o.', 'Řemesla > Klempířství',
   0.0, 0, 'raw', 0, 0, 0, 0, 0.0,
   NULL, NULL,
   NOW(), NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

SELECT setval('companies_id_seq', GREATEST(10, (SELECT COALESCE(MAX(id), 0) FROM companies)));

-- Link contacts 1-3 to companies 1-3
UPDATE outreach_contacts SET company_id = 1 WHERE id = 1 AND company_id IS NULL;
UPDATE outreach_contacts SET company_id = 2 WHERE id = 2 AND company_id IS NULL;
UPDATE outreach_contacts SET company_id = 3 WHERE id = 3 AND company_id IS NULL;

-- ══════════════════════════════════════════════════════════════════════
-- 7. Score history for contacts 1 & 2
-- ══════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM outreach_score_history WHERE contact_id = 1) THEN
    INSERT INTO outreach_score_history (contact_id, old_score, new_score, old_tier, new_tier, trigger, created_at)
    VALUES
      (1, 0.310, 0.450, 'new',    'enriched', 'enrich',  NOW() - INTERVAL '10 days'),
      (1, 0.450, 0.580, 'enriched','scored',  'recalc',  NOW() - INTERVAL '6 days'),
      (1, 0.580, 0.720, 'scored', 'scored',   'recalc',  NOW() - INTERVAL '1 day'),
      (2, 0.200, 0.600, 'new',    'scored',   'enrich',  NOW() - INTERVAL '8 days'),
      (2, 0.600, 0.850, 'scored', 'scored',   'recalc',  NOW() - INTERVAL '2 days');
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════════════════
-- 8. Contact audit log for contacts 1 & 2
-- ══════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM contact_audit_log WHERE contact_id = 1) THEN
    INSERT INTO contact_audit_log (contact_id, action, reason, actor, old_value, new_value, created_at)
    VALUES
      (1, 'score_updated',  'Enrichment pipeline ran',   'enrich',    '0.31', '0.45', NOW() - INTERVAL '10 days'),
      (1, 'score_updated',  'Intelligence loop recalc',  'intel_loop','0.45', '0.58', NOW() - INTERVAL '6 days'),
      (1, 'score_updated',  'Intelligence loop recalc',  'intel_loop','0.58', '0.72', NOW() - INTERVAL '1 day'),
      (1, 'status_changed', 'Contact became active',     'dashboard', 'new',  'active', NOW() - INTERVAL '10 days'),
      (2, 'score_updated',  'Enrichment pipeline ran',   'enrich',    '0.20', '0.60', NOW() - INTERVAL '8 days'),
      (2, 'score_updated',  'Intelligence loop recalc',  'intel_loop','0.60', '0.85', NOW() - INTERVAL '2 days'),
      (2, 'status_changed', 'Reply received',            'imap_poll', 'active','active', NOW() - INTERVAL '1 day');
  END IF;
END $$;

COMMIT;
