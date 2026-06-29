-- =============================================================================
-- seed-scenario.sql — Synthetic fixtures for pre-launch UI walkthrough
-- =============================================================================
-- ALL rows are clearly synthetic / demo data. Every row is greppable via
-- '@seed.local' email domains, or scenario campaign name LIKE '[SCENARIO]%'.
--
-- Apply:  psql "$DATABASE_URL" -f scripts/scenario/seed-scenario.sql
-- Revert: psql "$DATABASE_URL" -f scripts/scenario/cleanup-scenario-seed.sql
--
-- DO NOT apply to shared production DB without removing [SCENARIO] campaign first.
-- Idempotent: ON CONFLICT DO NOTHING throughout. Safe to re-run.
-- =============================================================================

BEGIN;

-- =============================================================================
-- PREREQUISITES: Scenario campaign + 50 synthetic contacts
-- =============================================================================

-- 1. Scenario Campaign
-- We reserve a dedicated campaign row. Name prefix '[SCENARIO]' is the
-- cleanup marker used by cleanup-scenario-seed.sql.
INSERT INTO campaigns (
    name, description, status,
    sequence_config, sending_config, segment_query,
    stats, category_paths, category_match,
    started_at, completed_at, created_at, updated_at
)
VALUES (
    '[SCENARIO] Demo data — DELETE BEFORE PROD',
    'Synthetic fixtures for pre-launch UI walkthrough. All contacts, replies, bounces and events in this campaign are fake.',
    'completed',
    '{"steps":[{"delay_days":0},{"delay_days":3},{"delay_days":7}]}'::jsonb,
    '{"daily_cap":50,"mailbox_rotation":"round_robin"}'::jsonb,
    '{"industry":"machinery"}'::jsonb,
    '{"sent":200,"opened":80,"clicked":25,"replied":15,"bounced":30}'::jsonb,
    ARRAY['Průmysl > Strojírenství'],
    'prefix',
    NOW() - INTERVAL '8 days',
    NOW() - INTERVAL '1 day',
    NOW() - INTERVAL '8 days',
    NOW()
)
ON CONFLICT DO NOTHING;

-- Capture the scenario campaign_id into a temp variable for subsequent inserts
-- (used via subquery; no session vars needed for idempotent SQL)

-- 2a. Scenario outreach_contacts (for outreach_threads / outreach_messages FK)
-- Uses status values valid to the outreach_contacts CHECK constraint.
INSERT INTO outreach_contacts (
    email, email_hash, first_name, last_name,
    company_name, ico, region, industry_tags, company_size,
    targeting_score, status, source,
    created_at, updated_at, category_path
) VALUES
('lead-01@seed.local', md5('lead-01@seed.local'), 'Jan',     'Novák',      'Strojírny Kladno s.r.o.',       '11100001', 'Praha',          ARRAY['machinery'], '25 - 49 zaměstnanců', 0.72, 'active', 'scenario-seed', NOW()-'7d'::interval, NOW(), 'Průmysl > Strojírenství'),
('lead-02@seed.local', md5('lead-02@seed.local'), 'Petr',    'Kovář',      'Kovárna Zlín a.s.',             '11100002', 'Zlín',           ARRAY['metalwork'], '50 - 99 zaměstnanců', 0.68, 'active', 'scenario-seed', NOW()-'7d'::interval, NOW(), 'Průmysl > Kovovýroba'),
('lead-03@seed.local', md5('lead-03@seed.local'), 'Eva',     'Procházková','TechnoMetal Brno s.r.o.',       '11100003', 'Brno',           ARRAY['machinery'], '10 - 19 zaměstnanců', 0.61, 'active', 'scenario-seed', NOW()-'6d'::interval, NOW(), 'Průmysl > Strojírenství'),
('lead-04@seed.local', md5('lead-04@seed.local'), 'Tomáš',   'Blaha',      'CNC Centrum Olomouc s.r.o.',    '11100004', 'Olomouc',        ARRAY['cnc'],       '5 - 9 zaměstnanců',   0.55, 'active', 'scenario-seed', NOW()-'6d'::interval, NOW(), 'Průmysl > CNC obrábění'),
('lead-05@seed.local', md5('lead-05@seed.local'), 'Lucie',   'Marková',    'Průmysl Olomouc a.s.',          '11100005', 'Olomouc',        ARRAY['manufacturing'], '100 - 249 zaměstnanců', 0.78, 'active', 'scenario-seed', NOW()-'5d'::interval, NOW(), 'Průmysl > Výroba'),
('lead-06@seed.local', md5('lead-06@seed.local'), 'Martin',  'Novotný',    'Hydraulika Pardubice s.r.o.',   '11100006', 'Pardubice',      ARRAY['hydraulics'], '25 - 49 zaměstnanců', 0.63, 'active', 'scenario-seed', NOW()-'5d'::interval, NOW(), 'Průmysl > Hydraulika'),
('lead-07@seed.local', md5('lead-07@seed.local'), 'Kateřina','Horáčková',  'Svářečství Jihlava s.r.o.',     '11100007', 'Jihlava',        ARRAY['welding'],   '10 - 19 zaměstnanců', 0.49, 'active', 'scenario-seed', NOW()-'4d'::interval, NOW(), 'Řemesla > Svářečství'),
('lead-08@seed.local', md5('lead-08@seed.local'), 'Ondřej',  'Čech',       'Metal Fabrication s.r.o.',      '11100008', 'Ostrava',        ARRAY['metalwork'], '50 - 99 zaměstnanců', 0.71, 'active', 'scenario-seed', NOW()-'4d'::interval, NOW(), 'Průmysl > Kovovýroba'),
('lead-09@seed.local', md5('lead-09@seed.local'), 'Pavel',   'Říha',       'Strojní Výroba Praha s.r.o.',   '11100009', 'Praha',          ARRAY['machinery'], '25 - 49 zaměstnanců', 0.82, 'active', 'scenario-seed', NOW()-'6d'::interval, NOW(), 'Průmysl > Strojírenství'),
('lead-10@seed.local', md5('lead-10@seed.local'), 'Hana',    'Vlčková',    'Průmyslová Automatizace a.s.',  '11100010', 'Brno',           ARRAY['automation'], '100 - 249 zaměstnanců', 0.88, 'active', 'scenario-seed', NOW()-'5d'::interval, NOW(), 'Průmysl > Automatizace'),
('lead-11@seed.local', md5('lead-11@seed.local'), 'Radek',   'Šimánek',    'Přesné Odlitky Plzeň s.r.o.',  '11100011', 'Plzeň',          ARRAY['casting'],   '25 - 49 zaměstnanců', 0.75, 'active', 'scenario-seed', NOW()-'5d'::interval, NOW(), 'Průmysl > Slévárna'),
('lead-12@seed.local', md5('lead-12@seed.local'), 'Jana',    'Veselá',     'Kovové Konstrukce Liberec a.s.','11100012', 'Liberec',        ARRAY['construction'], '50 - 99 zaměstnanců', 0.79, 'active', 'scenario-seed', NOW()-'4d'::interval, NOW(), 'Průmysl > Kovové konstr.'),
('lead-13@seed.local', md5('lead-13@seed.local'), 'Jakub',   'Kratochvíl', 'Robotika Brno s.r.o.',          '11100013', 'Brno',           ARRAY['robotics'],  '10 - 19 zaměstnanců', 0.85, 'active', 'scenario-seed', NOW()-'3d'::interval, NOW(), 'Průmysl > Robotika'),
('lead-14@seed.local', md5('lead-14@seed.local'), 'Miroslav','Štefan',     'Strojní Opravna Ostrava s.r.o.','11100014', 'Ostrava',        ARRAY['repair'],    '25 - 49 zaměstnanců', 0.91, 'active', 'scenario-seed', NOW()-'5d'::interval, NOW(), 'Průmysl > Opravny'),
('lead-15@seed.local', md5('lead-15@seed.local'), 'Alena',   'Hovorková',  'Výroba Nástrojů Zlín a.s.',     '11100015', 'Zlín',           ARRAY['toolmaking'], '50 - 99 zaměstnanců', 0.87, 'active', 'scenario-seed', NOW()-'4d'::interval, NOW(), 'Průmysl > Nástrojárna'),
('lead-16@seed.local', md5('lead-16@seed.local'), 'Zdeněk',  'Beneš',      'Obrábění Hradec s.r.o.',        '11100016', 'Hradec Králové', ARRAY['cnc'],       '10 - 19 zaměstnanců', 0.83, 'active', 'scenario-seed', NOW()-'3d'::interval, NOW(), 'Průmysl > CNC obrábění'),
('lead-17@seed.local', md5('lead-17@seed.local'), 'Petra',   'Dvořáčková', 'Svářečské Centrum Brno s.r.o.', '11100017', 'Brno',           ARRAY['welding'],   '25 - 49 zaměstnanců', 0.80, 'active', 'scenario-seed', NOW()-'2d'::interval, NOW(), 'Řemesla > Svářečství'),
('lead-18@seed.local', md5('lead-18@seed.local'), 'Vladimír','Kratina',    'Průmyslové Čerpadla Praha s.r.o.','11100018','Praha',          ARRAY['pumps'],     '100 - 249 zaměstnanců', 0.95, 'active', 'scenario-seed', NOW()-'6d'::interval, NOW(), 'Průmysl > Čerpadla'),
('lead-19@seed.local', md5('lead-19@seed.local'), 'Šárka',   'Malá',       'Laserové Řezání Brno s.r.o.',   '11100019', 'Brno',           ARRAY['laser'],     '25 - 49 zaměstnanců', 0.92, 'active', 'scenario-seed', NOW()-'4d'::interval, NOW(), 'Průmysl > Laserové řez.'),
('lead-20@seed.local', md5('lead-20@seed.local'), 'Igor',    'Šimůnek',    'Strojní Díly Ústí n.L. s.r.o.','11100020', 'Ústí nad Labem', ARRAY['parts'],     '25 - 49 zaměstnanců', 0.45, 'active', 'scenario-seed', NOW()-'5d'::interval, NOW(), 'Průmysl > Strojní díly')
ON CONFLICT (email_hash) DO NOTHING;

-- 2b. Scenario Contacts in `contacts` table (50 rows, emails @seed.local — obvious fake domain)
-- email_hash is md5(email) per existing convention.
-- Status must be one of: valid, bounced, blacklisted, invalid, unsubscribed, suppressed, replied, replied_negative, replied_positive, auto_reply
INSERT INTO contacts (
    email, email_hash, first_name, last_name,
    company_name, ico, region, industry, company_size,
    score, status, source,
    imported_at, created_at, updated_at,
    category_path, email_status, lifetime_touches, dnt
) VALUES
-- qualifying stage leads (8) - varied companies
('lead-01@seed.local', md5('lead-01@seed.local'), 'Jan',    'Novák',      'Strojírny Kladno s.r.o.',      '11100001', 'Praha',         'machinery',     '25 - 49 zaměstnanců',   72, 'valid',           'scenario-seed', NOW()-'7d'::interval, NOW()-'7d'::interval, NOW(), 'Průmysl > Strojírenství', 'verified', 1, false),
('lead-02@seed.local', md5('lead-02@seed.local'), 'Petr',   'Kovář',      'Kovárna Zlín a.s.',            '11100002', 'Zlín',          'metalwork',     '50 - 99 zaměstnanců',   68, 'valid',           'scenario-seed', NOW()-'7d'::interval, NOW()-'7d'::interval, NOW(), 'Průmysl > Kovovýroba',  'verified', 1, false),
('lead-03@seed.local', md5('lead-03@seed.local'), 'Eva',    'Procházková','TechnoMetal Brno s.r.o.',      '11100003', 'Brno',          'machinery',     '10 - 19 zaměstnanců',   61, 'valid',           'scenario-seed', NOW()-'6d'::interval, NOW()-'6d'::interval, NOW(), 'Průmysl > Strojírenství', 'verified', 1, false),
('lead-04@seed.local', md5('lead-04@seed.local'), 'Tomáš',  'Blaha',      'CNC Centrum Olomouc s.r.o.',   '11100004', 'Olomouc',       'cnc',           '5 - 9 zaměstnanců',     55, 'valid',           'scenario-seed', NOW()-'6d'::interval, NOW()-'6d'::interval, NOW(), 'Průmysl > CNC obrábění','verified', 1, false),
('lead-05@seed.local', md5('lead-05@seed.local'), 'Lucie',  'Marková',    'Průmysl Olomouc a.s.',         '11100005', 'Olomouc',       'manufacturing', '100 - 249 zaměstnanců', 78, 'valid',           'scenario-seed', NOW()-'5d'::interval, NOW()-'5d'::interval, NOW(), 'Průmysl > Výroba',      'verified', 1, false),
('lead-06@seed.local', md5('lead-06@seed.local'), 'Martin', 'Novotný',    'Hydraulika Pardubice s.r.o.',  '11100006', 'Pardubice',     'hydraulics',    '25 - 49 zaměstnanců',   63, 'valid',           'scenario-seed', NOW()-'5d'::interval, NOW()-'5d'::interval, NOW(), 'Průmysl > Hydraulika',  'verified', 1, false),
('lead-07@seed.local', md5('lead-07@seed.local'), 'Kateřina','Horáčková', 'Svářečství Jihlava s.r.o.',   '11100007', 'Jihlava',       'welding',       '10 - 19 zaměstnanců',   49, 'valid',           'scenario-seed', NOW()-'4d'::interval, NOW()-'4d'::interval, NOW(), 'Řemesla > Svářečství',  'verified', 1, false),
('lead-08@seed.local', md5('lead-08@seed.local'), 'Ondřej', 'Čech',       'Metal Fabrication s.r.o.',     '11100008', 'Ostrava',       'metalwork',     '50 - 99 zaměstnanců',   71, 'valid',           'scenario-seed', NOW()-'4d'::interval, NOW()-'4d'::interval, NOW(), 'Průmysl > Kovovýroba',  'verified', 1, false),
-- demo stage leads (5)
('lead-09@seed.local', md5('lead-09@seed.local'), 'Pavel',  'Říha',       'Strojní Výroba Praha s.r.o.',  '11100009', 'Praha',         'machinery',     '25 - 49 zaměstnanců',   82, 'replied_positive','scenario-seed', NOW()-'6d'::interval, NOW()-'6d'::interval, NOW(), 'Průmysl > Strojírenství', 'verified', 2, false),
('lead-10@seed.local', md5('lead-10@seed.local'), 'Hana',   'Vlčková',    'Průmyslová Automatizace a.s.', '11100010', 'Brno',          'automation',    '100 - 249 zaměstnanců', 88, 'replied_positive','scenario-seed', NOW()-'5d'::interval, NOW()-'5d'::interval, NOW(), 'Průmysl > Automatizace','verified', 2, false),
('lead-11@seed.local', md5('lead-11@seed.local'), 'Radek',  'Šimánek',    'Přesné Odlitky Plzeň s.r.o.', '11100011', 'Plzeň',         'casting',       '25 - 49 zaměstnanců',   75, 'replied_positive','scenario-seed', NOW()-'5d'::interval, NOW()-'5d'::interval, NOW(), 'Průmysl > Slévárna',    'verified', 2, false),
('lead-12@seed.local', md5('lead-12@seed.local'), 'Jana',   'Veselá',     'Kovové Konstrukce Liberec a.s.','11100012','Liberec',       'construction',  '50 - 99 zaměstnanců',   79, 'replied_positive','scenario-seed', NOW()-'4d'::interval, NOW()-'4d'::interval, NOW(), 'Průmysl > Kovové konstr.','verified', 2, false),
('lead-13@seed.local', md5('lead-13@seed.local'), 'Jakub',  'Kratochvíl', 'Robotika Brno s.r.o.',         '11100013', 'Brno',          'robotics',      '10 - 19 zaměstnanců',   85, 'replied_positive','scenario-seed', NOW()-'3d'::interval, NOW()-'3d'::interval, NOW(), 'Průmysl > Robotika',    'verified', 2, false),
-- proposal stage leads (4)
('lead-14@seed.local', md5('lead-14@seed.local'), 'Miroslav','Štefan',    'Strojní Opravna Ostrava s.r.o.','11100014','Ostrava',       'repair',        '25 - 49 zaměstnanců',   91, 'replied_positive','scenario-seed', NOW()-'5d'::interval, NOW()-'5d'::interval, NOW(), 'Průmysl > Opravny',     'verified', 3, false),
('lead-15@seed.local', md5('lead-15@seed.local'), 'Alena',  'Hovorková',  'Výroba Nástrojů Zlín a.s.',    '11100015', 'Zlín',          'toolmaking',    '50 - 99 zaměstnanců',   87, 'replied_positive','scenario-seed', NOW()-'4d'::interval, NOW()-'4d'::interval, NOW(), 'Průmysl > Nástrojárna', 'verified', 3, false),
('lead-16@seed.local', md5('lead-16@seed.local'), 'Zdeněk', 'Beneš',      'Obrábění Hradec s.r.o.',       '11100016', 'Hradec Králové','cnc',           '10 - 19 zaměstnanců',   83, 'replied_positive','scenario-seed', NOW()-'3d'::interval, NOW()-'3d'::interval, NOW(), 'Průmysl > CNC obrábění','verified', 3, false),
('lead-17@seed.local', md5('lead-17@seed.local'), 'Petra',  'Dvořáčková', 'Svářečské Centrum Brno s.r.o.','11100017','Brno',          'welding',       '25 - 49 zaměstnanců',   80, 'replied_positive','scenario-seed', NOW()-'2d'::interval, NOW()-'2d'::interval, NOW(), 'Řemesla > Svářečství',  'verified', 3, false),
-- won leads (2)
('lead-18@seed.local', md5('lead-18@seed.local'), 'Vladimír','Kratina',   'Průmyslové Čerpadla Praha s.r.o.','11100018','Praha',       'pumps',         '100 - 249 zaměstnanců', 95, 'replied_positive','scenario-seed', NOW()-'6d'::interval, NOW()-'6d'::interval, NOW(), 'Průmysl > Čerpadla',    'verified', 4, false),
('lead-19@seed.local', md5('lead-19@seed.local'), 'Šárka',  'Malá',       'Laserové Řezání Brno s.r.o.',  '11100019', 'Brno',          'laser',         '25 - 49 zaměstnanců',   92, 'replied_positive','scenario-seed', NOW()-'4d'::interval, NOW()-'4d'::interval, NOW(), 'Průmysl > Laserové řez.','verified', 4, false),
-- lost leads (1)
('lead-20@seed.local', md5('lead-20@seed.local'), 'Igor',   'Šimůnek',    'Strojní Díly Ústí n.L. s.r.o.','11100020','Ústí nad Labem','parts',         '25 - 49 zaměstnanců',   45, 'replied_negative','scenario-seed', NOW()-'5d'::interval, NOW()-'5d'::interval, NOW(), 'Průmysl > Strojní díly','verified', 2, false),
-- additional contacts for replies/bounces/send_events (leads 21-50)
('lead-21@seed.local', md5('lead-21@seed.local'), 'Boris',  'Holub',      'Montáž Strojů České Budějovice','11100021','České Budějovice','assembly',    '10 - 19 zaměstnanců',   59, 'valid',           'scenario-seed', NOW()-'7d'::interval, NOW()-'7d'::interval, NOW(), 'Průmysl > Montáž',      'verified', 1, false),
('lead-22@seed.local', md5('lead-22@seed.local'), 'Renata', 'Pokorná',    'ElektroMetal Brno a.s.',       '11100022', 'Brno',          'metalwork',     '50 - 99 zaměstnanců',   66, 'valid',           'scenario-seed', NOW()-'7d'::interval, NOW()-'7d'::interval, NOW(), 'Průmysl > Elektro',     'verified', 1, false),
('lead-23@seed.local', md5('lead-23@seed.local'), 'Stanislav','Vích',      'Pneumatika Praha s.r.o.',      '11100023', 'Praha',         'pneumatics',    '25 - 49 zaměstnanců',   70, 'valid',           'scenario-seed', NOW()-'6d'::interval, NOW()-'6d'::interval, NOW(), 'Průmysl > Pneumatika',  'verified', 1, false),
('lead-24@seed.local', md5('lead-24@seed.local'), 'Ivana',  'Marešová',   'Technika Olomouc s.r.o.',      '11100024', 'Olomouc',       'machinery',     '10 - 19 zaměstnanců',   54, 'bounced',         'scenario-seed', NOW()-'6d'::interval, NOW()-'6d'::interval, NOW(), 'Průmysl > Strojírenství', 'unverified', 1, false),
('lead-25@seed.local', md5('lead-25@seed.local'), 'Vladimír','Pospíšil',  'Řezné Nástroje Zlín s.r.o.',  '11100025', 'Zlín',          'toolmaking',    '10 - 19 zaměstnanců',   62, 'bounced',         'scenario-seed', NOW()-'6d'::interval, NOW()-'6d'::interval, NOW(), 'Průmysl > Nástrojárna', 'unverified', 1, false),
('lead-26@seed.local', md5('lead-26@seed.local'), 'Michaela','Kopecká',   'Výroba Hliníku Liberec s.r.o.','11100026','Liberec',       'aluminum',      '25 - 49 zaměstnanců',   58, 'bounced',         'scenario-seed', NOW()-'5d'::interval, NOW()-'5d'::interval, NOW(), 'Průmysl > Hliník',      'unverified', 1, false),
('lead-27@seed.local', md5('lead-27@seed.local'), 'Ladislav','Červenka',  'Svářečské Práce Ústí a.s.',   '11100027', 'Ústí nad Labem','welding',       '50 - 99 zaměstnanců',   47, 'bounced',         'scenario-seed', NOW()-'5d'::interval, NOW()-'5d'::interval, NOW(), 'Řemesla > Svářečství',  'unverified', 1, false),
('lead-28@seed.local', md5('lead-28@seed.local'), 'Daniela','Nováková',   'Klempíři Praha s.r.o.',        '11100028', 'Praha',         'metalwork',     '5 - 9 zaměstnanců',     39, 'bounced',         'scenario-seed', NOW()-'4d'::interval, NOW()-'4d'::interval, NOW(), 'Řemesla > Klempíři',    'unverified', 1, false),
('lead-29@seed.local', md5('lead-29@seed.local'), 'Tomáš',  'Hlaváč',     'Průmyslové Filtry Brno s.r.o.','11100029','Brno',          'filters',       '10 - 19 zaměstnanců',   64, 'auto_reply',      'scenario-seed', NOW()-'4d'::interval, NOW()-'4d'::interval, NOW(), 'Průmysl > Filtrace',    'verified', 1, false),
('lead-30@seed.local', md5('lead-30@seed.local'), 'Marcela','Zemanová',   'Geodézie Praha s.r.o.',         '11100030', 'Praha',         'geodesy',       '10 - 19 zaměstnanců',   44, 'auto_reply',      'scenario-seed', NOW()-'3d'::interval, NOW()-'3d'::interval, NOW(), 'Služby > Geodézie',     'verified', 1, false),
('lead-31@seed.local', md5('lead-31@seed.local'), 'Ondřej', 'Toman',      'Průmyslové Haly Ostrava a.s.', '11100031', 'Ostrava',       'construction',  '100 - 249 zaměstnanců', 73, 'valid',           'scenario-seed', NOW()-'3d'::interval, NOW()-'3d'::interval, NOW(), 'Průmysl > Haly',        'verified', 1, false),
('lead-32@seed.local', md5('lead-32@seed.local'), 'Tereza', 'Kopečková',  'Mechanika Plzeň s.r.o.',       '11100032', 'Plzeň',         'mechanics',     '25 - 49 zaměstnanců',   67, 'valid',           'scenario-seed', NOW()-'3d'::interval, NOW()-'3d'::interval, NOW(), 'Průmysl > Mechanika',   'verified', 1, false),
('lead-33@seed.local', md5('lead-33@seed.local'), 'Radim',  'Fiala',      'Průmyslové Čerpadla Brno s.r.o.','11100033','Brno',         'pumps',         '50 - 99 zaměstnanců',   74, 'valid',           'scenario-seed', NOW()-'2d'::interval, NOW()-'2d'::interval, NOW(), 'Průmysl > Čerpadla',    'verified', 1, false),
('lead-34@seed.local', md5('lead-34@seed.local'), 'Lenka',  'Vybíralová', 'CNC Frézování Olomouc s.r.o.', '11100034', 'Olomouc',       'cnc',           '10 - 19 zaměstnanců',   60, 'valid',           'scenario-seed', NOW()-'2d'::interval, NOW()-'2d'::interval, NOW(), 'Průmysl > CNC obrábění','verified', 1, false),
('lead-35@seed.local', md5('lead-35@seed.local'), 'Roman',  'Bednář',     'Výroba Komponentů Praha a.s.', '11100035', 'Praha',         'parts',         '50 - 99 zaměstnanců',   76, 'valid',           'scenario-seed', NOW()-'1d'::interval, NOW()-'1d'::interval, NOW(), 'Průmysl > Komponenty',  'verified', 1, false),
('lead-36@seed.local', md5('lead-36@seed.local'), 'Veronika','Kuchařová', 'Svářečské Stroje Liberec s.r.o.','11100036','Liberec',      'welding',       '10 - 19 zaměstnanců',   53, 'valid',           'scenario-seed', NOW()-'1d'::interval, NOW()-'1d'::interval, NOW(), 'Řemesla > Svářečství',  'verified', 1, false),
('lead-37@seed.local', md5('lead-37@seed.local'), 'Pavel',  'Stýblo',     'Měření a Regulace Praha s.r.o.','11100037','Praha',         'measurement',   '25 - 49 zaměstnanců',   65, 'valid',           'scenario-seed', NOW()-'1d'::interval, NOW()-'1d'::interval, NOW(), 'Průmysl > Měření',      'verified', 1, false),
('lead-38@seed.local', md5('lead-38@seed.local'), 'Denisa', 'Horáková',   'Kování Znojmo s.r.o.',         '11100038', 'Znojmo',        'metalwork',     '5 - 9 zaměstnanců',     42, 'bounced',         'scenario-seed', NOW()-'2d'::interval, NOW()-'2d'::interval, NOW(), 'Řemesla > Kování',      'unverified', 1, false),
('lead-39@seed.local', md5('lead-39@seed.local'), 'Tomáš',  'Kratochvíl', 'Elektro Instalace Brno s.r.o.','11100039','Brno',          'electrical',    '10 - 19 zaměstnanců',   57, 'bounced',         'scenario-seed', NOW()-'2d'::interval, NOW()-'2d'::interval, NOW(), 'Průmysl > Elektro',     'unverified', 1, false),
('lead-40@seed.local', md5('lead-40@seed.local'), 'Marcela','Sedláčková', 'Průmyslové Armatury Brno s.r.o.','11100040','Brno',         'fittings',      '25 - 49 zaměstnanců',   69, 'valid',           'scenario-seed', NOW()-'1d'::interval, NOW()-'1d'::interval, NOW(), 'Průmysl > Armatury',    'verified', 1, false),
('lead-41@seed.local', md5('lead-41@seed.local'), 'Jiří',   'Musil',      'Technika Třinec s.r.o.',       '11100041', 'Třinec',        'machinery',     '25 - 49 zaměstnanců',   61, 'valid',           'scenario-seed', NOW()-'1d'::interval, NOW()-'1d'::interval, NOW(), 'Průmysl > Strojírenství', 'verified', 1, false),
('lead-42@seed.local', md5('lead-42@seed.local'), 'Monika', 'Vlčková',    'Průmyslové Potrubí Ostrava s.r.o.','11100042','Ostrava',    'piping',        '50 - 99 zaměstnanců',   71, 'valid',           'scenario-seed', NOW()-'7d'::interval, NOW()-'7d'::interval, NOW(), 'Průmysl > Potrubí',     'verified', 1, false),
('lead-43@seed.local', md5('lead-43@seed.local'), 'Libor',  'Šedivý',     'Výroba Forem Praha s.r.o.',    '11100043', 'Praha',         'molding',       '25 - 49 zaměstnanců',   77, 'valid',           'scenario-seed', NOW()-'6d'::interval, NOW()-'6d'::interval, NOW(), 'Průmysl > Formy',       'verified', 1, false),
('lead-44@seed.local', md5('lead-44@seed.local'), 'Nikola', 'Doubková',   'Kovoobrábění Liberec s.r.o.',  '11100044', 'Liberec',       'metalwork',     '10 - 19 zaměstnanců',   52, 'auto_reply',      'scenario-seed', NOW()-'5d'::interval, NOW()-'5d'::interval, NOW(), 'Průmysl > Kovovýroba',  'verified', 1, false),
('lead-45@seed.local', md5('lead-45@seed.local'), 'Oldřich','Novák',      'Průmyslové Stroje Zlín a.s.',  '11100045', 'Zlín',          'machinery',     '100 - 249 zaměstnanců', 84, 'valid',           'scenario-seed', NOW()-'5d'::interval, NOW()-'5d'::interval, NOW(), 'Průmysl > Strojírenství', 'verified', 1, false),
('lead-46@seed.local', md5('lead-46@seed.local'), 'Gabriela','Nejedlá',   'Tváření Kovů Plzeň s.r.o.',   '11100046', 'Plzeň',         'metalwork',     '50 - 99 zaměstnanců',   68, 'bounced',         'scenario-seed', NOW()-'4d'::interval, NOW()-'4d'::interval, NOW(), 'Průmysl > Tváření',     'unverified', 1, false),
('lead-47@seed.local', md5('lead-47@seed.local'), 'Václav', 'Klimek',     'Průmyslová Výroba Jihlava s.r.o.','11100047','Jihlava',     'manufacturing', '25 - 49 zaměstnanců',   63, 'bounced',         'scenario-seed', NOW()-'3d'::interval, NOW()-'3d'::interval, NOW(), 'Průmysl > Výroba',      'unverified', 1, false),
('lead-48@seed.local', md5('lead-48@seed.local'), 'Blanka', 'Suchá',      'Ocelové Nosníky Brno s.r.o.',  '11100048', 'Brno',          'steel',         '25 - 49 zaměstnanců',   66, 'valid',           'scenario-seed', NOW()-'2d'::interval, NOW()-'2d'::interval, NOW(), 'Průmysl > Ocel',        'verified', 1, false),
('lead-49@seed.local', md5('lead-49@seed.local'), 'Antonín','Müller',     'Průmyslové Těsnění Brno s.r.o.','11100049','Brno',          'sealing',       '10 - 19 zaměstnanců',   55, 'bounced',         'scenario-seed', NOW()-'1d'::interval, NOW()-'1d'::interval, NOW(), 'Průmysl > Těsnění',     'unverified', 1, false),
('lead-50@seed.local', md5('lead-50@seed.local'), 'Soňa',   'Pohlová',    'Montáž Vzduchotechnika Praha s.r.o.','11100050','Praha',    'hvac',          '50 - 99 zaměstnanců',   72, 'valid',           'scenario-seed', NOW()-'1d'::interval, NOW()-'1d'::interval, NOW(), 'Průmysl > Vzduchotechnika','verified', 1, false)
ON CONFLICT (email_hash) DO NOTHING;

-- =============================================================================
-- A. LEADS (20 rows across qualifying/demo/proposal/won/lost stages)
-- =============================================================================
-- NOTE: leads has UNIQUE(contact_id, campaign_id). We use scenario campaign.
-- status values in leads table: 'new','qualifying','demo','proposal','won','lost'
-- (based on leads_status_idx and UI kanban expectation — not constrained by CHECK,
--  so we use the kanban board values the UI expects)
INSERT INTO leads (
    contact_id, campaign_id, status, source, notes,
    mailbox_id, classified_at, sentiment,
    original_text, created_at, updated_at
)
SELECT
    c.id,
    (SELECT id FROM campaigns WHERE name = '[SCENARIO] Demo data — DELETE BEFORE PROD' LIMIT 1),
    l.status,
    'scenario-seed',
    l.notes,
    1,  -- mailbox_id=1 (mazher.a@email.cz)
    NOW() - l.classified_ago,
    l.sentiment,
    l.original_text,
    NOW() - l.classified_ago,
    NOW()
FROM (VALUES
    ('lead-01@seed.local', 'qualifying', '2 days'::interval, 'interested',  'Firma se zabývá výrobou CNC dílů. Majitel Jan Novák se zajímal o naše řešení. Plánujeme schůzku příští týden. Follow-up naplánován.',                    'Dobrý den, přečetl jsem si váš e-mail a rád bych se dozvěděl víc. Pošlete mi prosím více informací.'),
    ('lead-02@seed.local', 'qualifying', '3 days'::interval, 'interested',  'Kontakt ve fázi průzkumu. Kovárna má zájem o výkup starých strojů. Jednání s obchodním ředitelem.',                                                        'Dobrý den, posílám info z naší firmy. Máte zkušenosti s výkupem frézek značky DMG?'),
    ('lead-03@seed.local', 'qualifying', '4 days'::interval, 'later',       'Firma TechnoMetal aktuálně nepotřebuje, ale dle ředitelky jsou otevřeni v Q3. Naplánovat follow-up na červen.',                                            'Momentálně máme stroje obsazené, ale dejme si hovor v červnu.'),
    ('lead-04@seed.local', 'qualifying', '5 days'::interval, 'interested',  'Malá firma CNC v Olomouci, hledají výkupce pro starší centrum. Kontakt reagoval pozitivně. Čekáme na technické parametry stroje.',                         'Mám zájem, pošlu vám technické listy do konce týdne.'),
    ('lead-05@seed.local', 'qualifying', '5 days'::interval, 'meeting',     'Průmysl Olomouc velká a.s. Zájem o hromadný výkup několika strojů z provozu. Domluvena obhlídka na místě.',                                               'Ano, máme 3 stroje k odprodeji. Kdy byste mohli přijet na obhlídku?'),
    ('lead-06@seed.local', 'qualifying', '6 days'::interval, 'interested',  'Hydraulické stroje Pardubice — zájem potvrzen telefonicky. Čekáme na foto dokumentaci.',                                                                   'Zájem mám, pošlu fotky ze skladu.'),
    ('lead-07@seed.local', 'qualifying', '6 days'::interval, 'objection',   'Kontakt měl námitky ohledně ceny. Vysvětleno, že nabídka závisí na stavu strojů. Přislíbil zaslat specifikace.',                                           'Cena mi přijde nízká. Proč tolik?'),
    ('lead-08@seed.local', 'qualifying', '7 days'::interval, 'interested',  'Metal Fabrication Ostrava — zájem o výkup 2 svářecích robotů. Domluvena technická konzultace.',                                                            'Máme k prodeji 2 svářecí roboty Fanuc. Zájem o nabídku.'),
    ('lead-09@seed.local', 'demo',       '2 days'::interval, 'meeting',     'Demo call proběhl úspěšně. Zákazník spokojen s procesem výkupu. Čeká se na formální schválení vedením.',                                                    'Demo call byl skvělý. Pošleme vám souhlas od ředitele.'),
    ('lead-10@seed.local', 'demo',       '3 days'::interval, 'meeting',     'Průmyslová Automatizace — demo proběhlo, zákazník se chce poradit s technickým týmem. Další schůzka za 2 týdny.',                                          'Potřebujeme si to ještě probrat interně. Dáme vědět.'),
    ('lead-11@seed.local', 'demo',       '3 days'::interval, 'interested',  'Přesné odlitky Plzeň — demo ukázalo zájem. Budeme připravovat kalkulaci.',                                                                                 'Máte velmi zajímavou nabídku. Kdy bychom mohli dostat kalkulaci?'),
    ('lead-12@seed.local', 'demo',       '4 days'::interval, 'meeting',     'Kovové Konstrukce Liberec — schůzka domluvena na čtvrtek. Zákazník přizval i CFO.',                                                                        'Přijdeme ve čtvrtek, CFO bude také přítomen.'),
    ('lead-13@seed.local', 'demo',       '3 days'::interval, 'meeting',     'Robotika Brno — zájem vysoký, demo velmi úspěšné. Přistoupíme k přípravě nabídky.',                                                                        'Výborná prezentace, jsme připraveni pokračovat.'),
    ('lead-14@seed.local', 'proposal',   '2 days'::interval, 'interested',  'Nabídka odeslána. Strojní opravna Ostrava čeká na schválení vedením do konce týdne.',                                                                       'Nabídku jsme přijali interně, finální OK dáme do pátku.'),
    ('lead-15@seed.local', 'proposal',   '3 days'::interval, 'interested',  'Výroba Nástrojů Zlín — smlouva ve schvalování. Právní oddělení přezkoumává podmínky.',                                                                     'Naše právní oddělení to kontroluje. Dáme vám vědět.'),
    ('lead-16@seed.local', 'proposal',   '3 days'::interval, 'interested',  'CNC Obrábění Hradec — nabídka přijata, čeká se na podpis ředitele.',                                                                                       'Ředitel nabídku přijal, podepíšeme do 2 pracovních dnů.'),
    ('lead-17@seed.local', 'proposal',   '4 days'::interval, 'objection',   'Svářečské centrum Brno — zákazník vyjednává o ceně. Upravena nabídka o 5%.',                                                                               'Mohli bychom dostat lepší cenu? Nabídka je jinak v pořádku.'),
    ('lead-18@seed.local', 'won',        '5 days'::interval, 'interested',  'Průmyslové Čerpadla Praha — deal uzavřen! Smlouva podepsána, platba přijata. Stroje budou vyzvednuty v pondělí.',                                          'Smlouva podepsána, těšíme se na spolupráci.'),
    ('lead-19@seed.local', 'won',        '4 days'::interval, 'interested',  'Laserové Řezání Brno — úspěšně uzavřeno. Výkupní cena 380.000 Kč. Přeprava zajištěna na příští týden.',                                                   'Souhlasíme s cenou, pošleme fakturu.'),
    ('lead-20@seed.local', 'lost',       '3 days'::interval, 'negative',    'Strojní Díly Ústí n.L. — zákazník se rozhodl pro konkurenční firmu. Hlavní důvod: cena. Archivováno.',                                                     'Děkujeme za nabídku, rozhodli jsme se pro jiné řešení.')
) AS l(email, status, classified_ago, sentiment, notes, original_text)
JOIN contacts c ON c.email = l.email
ON CONFLICT (contact_id, campaign_id) DO NOTHING;

-- =============================================================================
-- B. OUTREACH THREADS + MESSAGES (replies — 50 inbound messages)
-- =============================================================================

-- Scenario outreach threads (one per lead-01..lead-20 for replies context)
INSERT INTO outreach_threads (contact_id, campaign_id, status, current_step, next_action_at, next_action, created_at, updated_at)
SELECT
    c.id,
    (SELECT id FROM campaigns WHERE name = '[SCENARIO] Demo data — DELETE BEFORE PROD' LIMIT 1),
    t.thread_status,
    1,
    CASE WHEN t.thread_status = 'active' THEN NOW() + INTERVAL '1 day' ELSE NULL END,
    CASE WHEN t.thread_status = 'active' THEN 'send_followup' ELSE NULL END,
    NOW() - '7 days'::interval,
    NOW()
FROM (VALUES
    ('lead-01@seed.local','active'),('lead-02@seed.local','active'),
    ('lead-03@seed.local','paused'),('lead-04@seed.local','active'),
    ('lead-05@seed.local','replied'),('lead-06@seed.local','active'),
    ('lead-07@seed.local','active'),('lead-08@seed.local','replied'),
    ('lead-09@seed.local','replied'),('lead-10@seed.local','replied'),
    ('lead-11@seed.local','replied'),('lead-12@seed.local','replied'),
    ('lead-13@seed.local','replied'),('lead-14@seed.local','replied'),
    ('lead-15@seed.local','replied'),('lead-16@seed.local','replied'),
    ('lead-17@seed.local','replied'),('lead-18@seed.local','completed'),
    ('lead-19@seed.local','completed'),('lead-20@seed.local','replied')
) AS t(email, thread_status)
JOIN outreach_contacts c ON c.email = t.email
ON CONFLICT DO NOTHING;

-- Outbound messages (one per thread — seeds message_id for in_reply_to references)
INSERT INTO outreach_messages (
    thread_id, direction, message_id, subject, body_preview,
    mailbox_used, sent_at, opened_at, humanize_applied, is_bump, created_at
)
SELECT
    ot.id,
    'outbound',
    'scen-out-' || c.email,
    'Nabídka výkupu průmyslových strojů — ' || c.company_name,
    'Dobrý den, obracím se na vás s nabídkou výkupu průmyslových strojů a zařízení...',
    'mazher.a@email.cz',
    NOW() - '7 days'::interval,
    NOW() - '6 days'::interval,
    true, false,
    NOW() - '7 days'::interval
FROM outreach_threads ot
JOIN outreach_contacts c ON c.id = ot.contact_id
WHERE ot.campaign_id = (SELECT id FROM campaigns WHERE name = '[SCENARIO] Demo data — DELETE BEFORE PROD' LIMIT 1)
  AND c.email LIKE '%@seed.local'
ON CONFLICT (message_id) DO NOTHING;

-- Inbound replies (50 rows, realistic CZ text, varied classifications)
-- Lead-01: interested
INSERT INTO outreach_messages (thread_id, direction, message_id, in_reply_to, subject, body_preview, reply_type, sentiment, replied_at, mailbox_used, humanize_applied, is_bump, created_at)
SELECT ot.id, 'inbound', 'scen-in-01', 'scen-out-lead-01@seed.local', 'Re: Nabídka výkupu průmyslových strojů', 'Dobrý den, přečetl jsem váš e-mail a mám zájem o více informací. Máme starší frézku, kterou bychom rádi prodali.', 'interested', 'positive', NOW()-'5d'::interval, 'mazher.a@email.cz', false, false, NOW()-'5d'::interval FROM outreach_threads ot JOIN outreach_contacts c ON c.id=ot.contact_id WHERE c.email='lead-01@seed.local' AND ot.campaign_id=(SELECT id FROM campaigns WHERE name='[SCENARIO] Demo data — DELETE BEFORE PROD' LIMIT 1) ON CONFLICT (message_id) DO NOTHING;
-- Lead-02: interested
INSERT INTO outreach_messages (thread_id, direction, message_id, in_reply_to, subject, body_preview, reply_type, sentiment, replied_at, mailbox_used, humanize_applied, is_bump, created_at)
SELECT ot.id, 'inbound', 'scen-in-02', 'scen-out-lead-02@seed.local', 'Re: Nabídka výkupu průmyslových strojů', 'Dobrý den, posílám info z naší firmy. Máte zkušenosti s výkupem frézek značky DMG? Rád bych se dozvěděl víc o procesu.', 'interested', 'positive', NOW()-'5d'::interval, 'mazher.a@email.cz', false, false, NOW()-'5d'::interval FROM outreach_threads ot JOIN outreach_contacts c ON c.id=ot.contact_id WHERE c.email='lead-02@seed.local' AND ot.campaign_id=(SELECT id FROM campaigns WHERE name='[SCENARIO] Demo data — DELETE BEFORE PROD' LIMIT 1) ON CONFLICT (message_id) DO NOTHING;
-- Lead-03: later (interested but delayed)
INSERT INTO outreach_messages (thread_id, direction, message_id, in_reply_to, subject, body_preview, reply_type, sentiment, replied_at, mailbox_used, humanize_applied, is_bump, created_at)
SELECT ot.id, 'inbound', 'scen-in-03', 'scen-out-lead-03@seed.local', 'Re: Nabídka výkupu průmyslových strojů', 'Momentálně máme stroje obsazené výrobou, ale dejme si hovor v červnu. Do té doby jsou stroje nepostradatelné.', 'ooo', 'neutral', NOW()-'4d'::interval, 'mazher.a@email.cz', false, false, NOW()-'4d'::interval FROM outreach_threads ot JOIN outreach_contacts c ON c.id=ot.contact_id WHERE c.email='lead-03@seed.local' AND ot.campaign_id=(SELECT id FROM campaigns WHERE name='[SCENARIO] Demo data — DELETE BEFORE PROD' LIMIT 1) ON CONFLICT (message_id) DO NOTHING;
-- Lead-04: interested
INSERT INTO outreach_messages (thread_id, direction, message_id, in_reply_to, subject, body_preview, reply_type, sentiment, replied_at, mailbox_used, humanize_applied, is_bump, created_at)
SELECT ot.id, 'inbound', 'scen-in-04', 'scen-out-lead-04@seed.local', 'Re: Nabídka výkupu průmyslových strojů', 'Mám zájem o výkup CNC centra z roku 2012. Pošlu vám technické listy do konce týdne. Kontaktujte mě prosím telefonicky.', 'interested', 'positive', NOW()-'4d'::interval, 'mazher.a@email.cz', false, false, NOW()-'4d'::interval FROM outreach_threads ot JOIN outreach_contacts c ON c.id=ot.contact_id WHERE c.email='lead-04@seed.local' AND ot.campaign_id=(SELECT id FROM campaigns WHERE name='[SCENARIO] Demo data — DELETE BEFORE PROD' LIMIT 1) ON CONFLICT (message_id) DO NOTHING;
-- Lead-05: meeting
INSERT INTO outreach_messages (thread_id, direction, message_id, in_reply_to, subject, body_preview, reply_type, sentiment, replied_at, mailbox_used, humanize_applied, is_bump, created_at)
SELECT ot.id, 'inbound', 'scen-in-05', 'scen-out-lead-05@seed.local', 'Re: Nabídka výkupu průmyslových strojů', 'Ano, máme 3 stroje k odprodeji z provozu. Kdy byste mohli přijet na obhlídku do Olomouce? Preferujeme úterý nebo středu.', 'interested', 'positive', NOW()-'3d'::interval, 'mazher.a@email.cz', false, false, NOW()-'3d'::interval FROM outreach_threads ot JOIN outreach_contacts c ON c.id=ot.contact_id WHERE c.email='lead-05@seed.local' AND ot.campaign_id=(SELECT id FROM campaigns WHERE name='[SCENARIO] Demo data — DELETE BEFORE PROD' LIMIT 1) ON CONFLICT (message_id) DO NOTHING;
-- Lead-06: interested
INSERT INTO outreach_messages (thread_id, direction, message_id, in_reply_to, subject, body_preview, reply_type, sentiment, replied_at, mailbox_used, humanize_applied, is_bump, created_at)
SELECT ot.id, 'inbound', 'scen-in-06', 'scen-out-lead-06@seed.local', 'Re: Nabídka výkupu průmyslových strojů', 'Zájem mám, pošlu fotky ze skladu. Máme hydraulický lis z roku 2008, potřebujeme generální opravu nebo výkup.', 'interested', 'positive', NOW()-'3d'::interval, 'mazher.a@email.cz', false, false, NOW()-'3d'::interval FROM outreach_threads ot JOIN outreach_contacts c ON c.id=ot.contact_id WHERE c.email='lead-06@seed.local' AND ot.campaign_id=(SELECT id FROM campaigns WHERE name='[SCENARIO] Demo data — DELETE BEFORE PROD' LIMIT 1) ON CONFLICT (message_id) DO NOTHING;
-- Lead-07: objection
INSERT INTO outreach_messages (thread_id, direction, message_id, in_reply_to, subject, body_preview, reply_type, sentiment, replied_at, mailbox_used, humanize_applied, is_bump, created_at)
SELECT ot.id, 'inbound', 'scen-in-07', 'scen-out-lead-07@seed.local', 'Re: Nabídka výkupu průmyslových strojů', 'Cena, kterou nabízíte, mi přijde velmi nízká. Proč za stroj stojící 2M Kč nabízíte jen 200K? Vysvětlete prosím svou metodiku.', 'objection', 'negative', NOW()-'2d'::interval, 'mazher.a@email.cz', false, false, NOW()-'2d'::interval FROM outreach_threads ot JOIN outreach_contacts c ON c.id=ot.contact_id WHERE c.email='lead-07@seed.local' AND ot.campaign_id=(SELECT id FROM campaigns WHERE name='[SCENARIO] Demo data — DELETE BEFORE PROD' LIMIT 1) ON CONFLICT (message_id) DO NOTHING;
-- Lead-08: meeting (interested in multiple robots)
INSERT INTO outreach_messages (thread_id, direction, message_id, in_reply_to, subject, body_preview, reply_type, sentiment, replied_at, mailbox_used, humanize_applied, is_bump, created_at)
SELECT ot.id, 'inbound', 'scen-in-08', 'scen-out-lead-08@seed.local', 'Re: Nabídka výkupu průmyslových strojů', 'Máme k prodeji 2 svářecí roboty Fanuc M-710iC z roku 2015. Mohu vám zaslat zájem o cenovou nabídku? Kdy jste dostupní?', 'interested', 'positive', NOW()-'2d'::interval, 'mazher.a@email.cz', false, false, NOW()-'2d'::interval FROM outreach_threads ot JOIN outreach_contacts c ON c.id=ot.contact_id WHERE c.email='lead-08@seed.local' AND ot.campaign_id=(SELECT id FROM campaigns WHERE name='[SCENARIO] Demo data — DELETE BEFORE PROD' LIMIT 1) ON CONFLICT (message_id) DO NOTHING;
-- Lead-09: meeting confirmed
INSERT INTO outreach_messages (thread_id, direction, message_id, in_reply_to, subject, body_preview, reply_type, sentiment, replied_at, mailbox_used, humanize_applied, is_bump, created_at)
SELECT ot.id, 'inbound', 'scen-in-09', 'scen-out-lead-09@seed.local', 'Re: Nabídka výkupu průmyslových strojů', 'Demo call byl skvělý, vaše firma vypadá profesionálně. Pošleme vám souhlas od ředitele do konce týdne. Těšíme se na spolupráci.', 'interested', 'positive', NOW()-'2d'::interval, 'mazher.a@email.cz', false, false, NOW()-'2d'::interval FROM outreach_threads ot JOIN outreach_contacts c ON c.id=ot.contact_id WHERE c.email='lead-09@seed.local' AND ot.campaign_id=(SELECT id FROM campaigns WHERE name='[SCENARIO] Demo data — DELETE BEFORE PROD' LIMIT 1) ON CONFLICT (message_id) DO NOTHING;
-- Lead-10: not-interested (tepid)
INSERT INTO outreach_messages (thread_id, direction, message_id, in_reply_to, subject, body_preview, reply_type, sentiment, replied_at, mailbox_used, humanize_applied, is_bump, created_at)
SELECT ot.id, 'inbound', 'scen-in-10', 'scen-out-lead-10@seed.local', 'Re: Nabídka výkupu průmyslových strojů', 'Děkujeme za nabídku. V tuto chvíli nemáme zájem o prodej strojního zařízení, stroje plně využíváme v provozu.', 'not_interested', 'negative', NOW()-'4d'::interval, 'mazher.a@email.cz', false, false, NOW()-'4d'::interval FROM outreach_threads ot JOIN outreach_contacts c ON c.id=ot.contact_id WHERE c.email='lead-10@seed.local' AND ot.campaign_id=(SELECT id FROM campaigns WHERE name='[SCENARIO] Demo data — DELETE BEFORE PROD' LIMIT 1) ON CONFLICT (message_id) DO NOTHING;
-- Lead-11: not-interested
INSERT INTO outreach_messages (thread_id, direction, message_id, in_reply_to, subject, body_preview, reply_type, sentiment, replied_at, mailbox_used, humanize_applied, is_bump, created_at)
SELECT ot.id, 'inbound', 'scen-in-11', 'scen-out-lead-11@seed.local', 'Re: Nabídka výkupu průmyslových strojů', 'Omlouváme se, ale v současné době neprodáváme žádné stroje. Budeme vás kontaktovat, pokud se situace změní.', 'not_interested', 'neutral', NOW()-'4d'::interval, 'mazher.a@email.cz', false, false, NOW()-'4d'::interval FROM outreach_threads ot JOIN outreach_contacts c ON c.id=ot.contact_id WHERE c.email='lead-11@seed.local' AND ot.campaign_id=(SELECT id FROM campaigns WHERE name='[SCENARIO] Demo data — DELETE BEFORE PROD' LIMIT 1) ON CONFLICT (message_id) DO NOTHING;
-- Lead-12: ooo (out-of-office)
INSERT INTO outreach_messages (thread_id, direction, message_id, in_reply_to, subject, body_preview, reply_type, sentiment, replied_at, mailbox_used, humanize_applied, is_bump, created_at)
SELECT ot.id, 'inbound', 'scen-in-12', 'scen-out-lead-12@seed.local', 'Automatická odpověď: Nepřítomnost v kanceláři', 'Jsem na dovolené od 28.4. do 5.5. Váš e-mail přečtu po návratu. V naléhavých případech kontaktujte kolegu Jana Nováka na jana.novak@firma.cz', 'ooo', 'neutral', NOW()-'6d'::interval, 'mazher.a@email.cz', false, false, NOW()-'6d'::interval FROM outreach_threads ot JOIN outreach_contacts c ON c.id=ot.contact_id WHERE c.email='lead-12@seed.local' AND ot.campaign_id=(SELECT id FROM campaigns WHERE name='[SCENARIO] Demo data — DELETE BEFORE PROD' LIMIT 1) ON CONFLICT (message_id) DO NOTHING;
-- Lead-13: ooo
INSERT INTO outreach_messages (thread_id, direction, message_id, in_reply_to, subject, body_preview, reply_type, sentiment, replied_at, mailbox_used, humanize_applied, is_bump, created_at)
SELECT ot.id, 'inbound', 'scen-in-13', 'scen-out-lead-13@seed.local', 'Re: Nabídka výkupu průmyslových strojů [Auto-Reply]', 'Automatická odpověď: Jsem momentálně mimo kancelář. Vrátím se 6.5.2026. Vaše zpráva bude zodpovězena po mém návratu.', 'ooo', 'neutral', NOW()-'5d'::interval, 'mazher.a@email.cz', false, false, NOW()-'5d'::interval FROM outreach_threads ot JOIN outreach_contacts c ON c.id=ot.contact_id WHERE c.email='lead-13@seed.local' AND ot.campaign_id=(SELECT id FROM campaigns WHERE name='[SCENARIO] Demo data — DELETE BEFORE PROD' LIMIT 1) ON CONFLICT (message_id) DO NOTHING;
-- Lead-14: interested (proposal stage reply)
INSERT INTO outreach_messages (thread_id, direction, message_id, in_reply_to, subject, body_preview, reply_type, sentiment, replied_at, mailbox_used, humanize_applied, is_bump, created_at)
SELECT ot.id, 'inbound', 'scen-in-14', 'scen-out-lead-14@seed.local', 'Re: Nabídka výkupu průmyslových strojů', 'Nabídku jsme přijali interně na poradě vedení. Finální OK od ředitele přijde do pátku. Pošleme vám podepsaný souhlas.', 'interested', 'positive', NOW()-'1d'::interval, 'mazher.a@email.cz', false, false, NOW()-'1d'::interval FROM outreach_threads ot JOIN outreach_contacts c ON c.id=ot.contact_id WHERE c.email='lead-14@seed.local' AND ot.campaign_id=(SELECT id FROM campaigns WHERE name='[SCENARIO] Demo data — DELETE BEFORE PROD' LIMIT 1) ON CONFLICT (message_id) DO NOTHING;
-- Lead-15: wrong-person
INSERT INTO outreach_messages (thread_id, direction, message_id, in_reply_to, subject, body_preview, reply_type, sentiment, replied_at, mailbox_used, humanize_applied, is_bump, created_at)
SELECT ot.id, 'inbound', 'scen-in-15', 'scen-out-lead-15@seed.local', 'Re: Nabídka výkupu průmyslových strojů', 'Nejsem správná osoba pro tuto komunikaci. O strojní vybavení se stará náš technický ředitel Ing. Petr Novotný, ozvěte se na p.novotny@firma.cz', 'wrong_person', 'neutral', NOW()-'3d'::interval, 'mazher.a@email.cz', false, false, NOW()-'3d'::interval FROM outreach_threads ot JOIN outreach_contacts c ON c.id=ot.contact_id WHERE c.email='lead-15@seed.local' AND ot.campaign_id=(SELECT id FROM campaigns WHERE name='[SCENARIO] Demo data — DELETE BEFORE PROD' LIMIT 1) ON CONFLICT (message_id) DO NOTHING;
-- Lead-16: wrong-person
INSERT INTO outreach_messages (thread_id, direction, message_id, in_reply_to, subject, body_preview, reply_type, sentiment, replied_at, mailbox_used, humanize_applied, is_bump, created_at)
SELECT ot.id, 'inbound', 'scen-in-16', 'scen-out-lead-16@seed.local', 'Re: Nabídka výkupu průmyslových strojů', 'Omylně zasláno na mě. Nákupní oddělení je info@firma.cz nebo telefonicky 596 XXX XXX.', 'wrong_person', 'neutral', NOW()-'4d'::interval, 'mazher.a@email.cz', false, false, NOW()-'4d'::interval FROM outreach_threads ot JOIN outreach_contacts c ON c.id=ot.contact_id WHERE c.email='lead-16@seed.local' AND ot.campaign_id=(SELECT id FROM campaigns WHERE name='[SCENARIO] Demo data — DELETE BEFORE PROD' LIMIT 1) ON CONFLICT (message_id) DO NOTHING;
-- Lead-17: objection (price)
INSERT INTO outreach_messages (thread_id, direction, message_id, in_reply_to, subject, body_preview, reply_type, sentiment, replied_at, mailbox_used, humanize_applied, is_bump, created_at)
SELECT ot.id, 'inbound', 'scen-in-17', 'scen-out-lead-17@seed.local', 'Re: Nabídka výkupu průmyslových strojů', 'Mohli bychom dostat lepší cenu? Nabídka je jinak v pořádku, ale potřebujeme lepší podmínky pro schválení vedením.', 'objection', 'neutral', NOW()-'1d'::interval, 'mazher.a@email.cz', false, false, NOW()-'1d'::interval FROM outreach_threads ot JOIN outreach_contacts c ON c.id=ot.contact_id WHERE c.email='lead-17@seed.local' AND ot.campaign_id=(SELECT id FROM campaigns WHERE name='[SCENARIO] Demo data — DELETE BEFORE PROD' LIMIT 1) ON CONFLICT (message_id) DO NOTHING;
-- Lead-18: won (positive close)
INSERT INTO outreach_messages (thread_id, direction, message_id, in_reply_to, subject, body_preview, reply_type, sentiment, replied_at, mailbox_used, humanize_applied, is_bump, created_at)
SELECT ot.id, 'inbound', 'scen-in-18', 'scen-out-lead-18@seed.local', 'Re: Nabídka výkupu průmyslových strojů', 'Smlouva podepsána ze strany ředitele. Platba odeslána na váš účet. Těšíme se na profesionální průběh výkupu.', 'interested', 'positive', NOW()-'4d'::interval, 'mazher.a@email.cz', false, false, NOW()-'4d'::interval FROM outreach_threads ot JOIN outreach_contacts c ON c.id=ot.contact_id WHERE c.email='lead-18@seed.local' AND ot.campaign_id=(SELECT id FROM campaigns WHERE name='[SCENARIO] Demo data — DELETE BEFORE PROD' LIMIT 1) ON CONFLICT (message_id) DO NOTHING;
-- Lead-19: spam/irrelevant
INSERT INTO outreach_messages (thread_id, direction, message_id, in_reply_to, subject, body_preview, reply_type, sentiment, replied_at, mailbox_used, humanize_applied, is_bump, created_at)
SELECT ot.id, 'inbound', 'scen-in-19', 'scen-out-lead-19@seed.local', 'STOP — Laserové Řezání', 'Prosím, přestaňte nám zasílat tyto e-maily. Nemáme zájem. Odeberte nás ze seznamu ihned.', 'spam', 'negative', NOW()-'2d'::interval, 'mazher.a@email.cz', false, false, NOW()-'2d'::interval FROM outreach_threads ot JOIN outreach_contacts c ON c.id=ot.contact_id WHERE c.email='lead-19@seed.local' AND ot.campaign_id=(SELECT id FROM campaigns WHERE name='[SCENARIO] Demo data — DELETE BEFORE PROD' LIMIT 1) ON CONFLICT (message_id) DO NOTHING;
-- Lead-20: not-interested (lost)
INSERT INTO outreach_messages (thread_id, direction, message_id, in_reply_to, subject, body_preview, reply_type, sentiment, replied_at, mailbox_used, humanize_applied, is_bump, created_at)
SELECT ot.id, 'inbound', 'scen-in-20', 'scen-out-lead-20@seed.local', 'Re: Nabídka výkupu průmyslových strojů', 'Děkujeme za vaši nabídku, avšak rozhodli jsme se pro jiné řešení. Uchovali jsme si vaše kontakty pro případ budoucí spolupráce.', 'not_interested', 'neutral', NOW()-'2d'::interval, 'mazher.a@email.cz', false, false, NOW()-'2d'::interval FROM outreach_threads ot JOIN outreach_contacts c ON c.id=ot.contact_id WHERE c.email='lead-20@seed.local' AND ot.campaign_id=(SELECT id FROM campaigns WHERE name='[SCENARIO] Demo data — DELETE BEFORE PROD' LIMIT 1) ON CONFLICT (message_id) DO NOTHING;

-- Additional 30 replies (leads 21-50) for realistic inbox volume
INSERT INTO outreach_messages (thread_id, direction, message_id, in_reply_to, subject, body_preview, reply_type, sentiment, replied_at, mailbox_used, humanize_applied, is_bump, created_at)
SELECT ot.id, 'inbound', 'scen-in-' || lpad(rn::text, 2, '0') || 'b', 'scen-out-' || c.email,
    'Re: Nabídka výkupu průmyslových strojů',
    b.body, b.reply_type, b.sentiment,
    NOW() - (b.days_ago || ' days')::interval,
    'mazher.a@email.cz', false, false,
    NOW() - (b.days_ago || ' days')::interval
FROM (VALUES
    ('lead-21@seed.local', 21, 'interested',   'positive', 'Dobrý den, máme zájem o výkup obráběcího centra. Pošlete prosím více informací.', 6),
    ('lead-22@seed.local', 22, 'not_interested','neutral',  'Děkujeme za nabídku, momentálně neuvažujeme o prodeji strojů.', 6),
    ('lead-23@seed.local', 23, 'ooo',           'neutral',  'Automatická odpověď: Pan Vích je na vzdělávací akci do 9.5. Kontaktujte kancelář na 485 xxx xxx.', 5),
    ('lead-24@seed.local', 24, 'interested',    'positive', 'Máte zkušenosti s výkupem soustruhů? Máme 2 starší KOVOSVIT stroje.', 5),
    ('lead-25@seed.local', 25, 'interested',    'positive', 'Výborná nabídka, pošleme vám technický list stroje příští týden.', 5),
    ('lead-26@seed.local', 26, 'not_interested','negative', 'Neuvažujeme o prodeji, stroje jsou součástí výrobní linky.', 4),
    ('lead-27@seed.local', 27, 'interested',    'positive', 'Zájem máme, kdy byste mohli přijet na prohlídku do Ústí?', 4),
    ('lead-28@seed.local', 28, 'wrong_person',  'neutral',  'Nejsem zodpovědná osoba, pište na info@klempiri-praha.cz', 4),
    ('lead-29@seed.local', 29, 'auto_reply',    'neutral',  'Automatická odpověď: Tomáš Hlaváč je dočasně nedostupný. Vrátí se 8.5.', 3),
    ('lead-30@seed.local', 30, 'auto_reply',    'neutral',  'Automatická odpověď: Marcela Zemanová je na pracovní cestě. Přečte zprávy po návratu 10.5.', 3),
    ('lead-31@seed.local', 31, 'interested',    'positive', 'Dobrý den, hledáme kupce pro halu s mostovým jeřábem. Máte zájem?', 3),
    ('lead-32@seed.local', 32, 'not_interested','neutral',  'V tomto okamžiku nevlastníme stroje k prodeji. Uložíme si váš kontakt.', 3),
    ('lead-33@seed.local', 33, 'interested',    'positive', 'Máme čerpadlo WILO k prodeji. Pošlete nabídku na základě specifikací.', 2),
    ('lead-34@seed.local', 34, 'objection',     'negative', 'Proč posíláte firemní e-mail bez souhlasu? Odeberte nás prosím.', 2),
    ('lead-35@seed.local', 35, 'interested',    'positive', 'Zájem o výkup 3 průmyslových kompresorů, rok výroby 2010–2014.', 2),
    ('lead-36@seed.local', 36, 'ooo',           'neutral',  'Autoreply: Veronika Kuchařová je v OPN do 7.5. Kontakty: vedeni@firma.cz', 2),
    ('lead-37@seed.local', 37, 'interested',    'positive', 'Máme přebytečné meřicí přístroje k prodeji, několik kusů Fluke.', 2),
    ('lead-38@seed.local', 38, 'not_interested','negative', 'Neposílejte mi více tyto zprávy. Odhlaste mě.', 1),
    ('lead-39@seed.local', 39, 'spam',          'negative', 'SPAM — prosíme o okamžité odebrání z databáze.', 1),
    ('lead-40@seed.local', 40, 'interested',    'positive', 'Dobrý den, máme zájem o výkup průmyslových armatur. Pošlete formulář.', 1),
    ('lead-41@seed.local', 41, 'interested',    'positive', 'Zájem o výkup soustruhů ze závodní dílny — máme 4 kusy.', 1),
    ('lead-42@seed.local', 42, 'ooo',           'neutral',  'Automatická odpověď: Monika Vlčková je na mateřské dovolené. Kontaktujte zastupujícího kolegu.', 1),
    ('lead-43@seed.local', 43, 'interested',    'positive', 'Máme formy pro injekční lisy k prodeji. Pošlete podmínky výkupu.', 1),
    ('lead-44@seed.local', 44, 'auto_reply',    'neutral',  'Automatická odpověď: Nikola Doubková je nepřítomna. Vrátí se 12.5.2026.', 1),
    ('lead-45@seed.local', 45, 'interested',    'positive', 'Zájem o výkup průmyslových strojů — máme 10-kusový komplex ze zrušené výroby.', 1),
    ('lead-46@seed.local', 46, 'spam',          'negative', 'Toto je SPAM. Hlásím na ÚOOÚ.', 1),
    ('lead-47@seed.local', 47, 'not_interested','neutral',  'Aktuálně nemáme zájem. Uchujeme váš kontakt do budoucna.', 1),
    ('lead-48@seed.local', 48, 'interested',    'positive', 'Ocelové nosníky máme přebytečné — 15 kusů různých profilů. Zájem?', 1),
    ('lead-49@seed.local', 49, 'objection',     'negative', 'Vaše ceny jsou příliš nízké. Stroje jsou v perfektním stavu a stojí 5× víc.', 1),
    ('lead-50@seed.local', 50, 'interested',    'positive', 'Vzduchotechnické jednotky k prodeji — 6 kusů VZT Remak, zájem?', 1)
) AS b(email, rn, reply_type, sentiment, body, days_ago)
JOIN outreach_contacts c ON c.email = b.email
JOIN outreach_threads ot ON ot.contact_id = c.id AND ot.campaign_id = (SELECT id FROM campaigns WHERE name = '[SCENARIO] Demo data — DELETE BEFORE PROD' LIMIT 1)
ON CONFLICT (message_id) DO NOTHING;

-- Populate reply_inbox rows (one per inbound send_event — we use a fake send_event reference via outreach_messages)
-- reply_inbox has UNIQUE(send_event_id); since reply_inbox.send_event_id → send_events.id,
-- and our inbound messages don't have send_events, we insert reply_inbox rows WITHOUT send_event_id.
INSERT INTO reply_inbox (campaign_id, contact_id, mailbox_id, from_email, subject, classification, received_at, handled, handled_at)
SELECT
    (SELECT id FROM campaigns WHERE name = '[SCENARIO] Demo data — DELETE BEFORE PROD' LIMIT 1),
    c.id,
    1,
    c.email,
    'Re: Nabídka výkupu průmyslových strojů',
    om.reply_type,
    om.replied_at,
    CASE WHEN om.reply_type IN ('not_interested','spam','ooo','auto_reply') THEN true ELSE false END,
    CASE WHEN om.reply_type IN ('not_interested','spam','ooo','auto_reply') THEN om.replied_at + INTERVAL '1 hour' ELSE NULL END
FROM outreach_messages om
JOIN outreach_threads ot ON ot.id = om.thread_id
JOIN outreach_contacts c ON c.id = ot.contact_id
WHERE om.direction = 'inbound'
  AND c.email LIKE '%@seed.local'
  AND om.message_id LIKE 'scen-in-%';

-- =============================================================================
-- C. BOUNCE EVENTS (30 rows: 20 hard + 10 soft)
-- =============================================================================
-- bounce_events has: send_event_id (nullable), contact_id, bounce_type, bounce_code, bounce_reason, processed_at
-- Hard bounce codes: 550/551/552/553 ; Soft: 421/451/452
-- 3 IČO clusters with 5+ bounces each, 5 firms 1-2 bounces, rest isolated

-- First we need send_events for the scenario campaign to FK reference.
-- We insert 30 scenario send_events (one per bounce row target)
INSERT INTO send_events (campaign_id, contact_id, step, mailbox_used, message_id, subject, status, sent_at, created_at)
SELECT
    (SELECT id FROM campaigns WHERE name = '[SCENARIO] Demo data — DELETE BEFORE PROD' LIMIT 1),
    c.id,
    1,
    'mazher.a@email.cz',
    'scen-se-bounce-' || c.email,
    'Nabídka výkupu průmyslových strojů',
    'sent',
    NOW() - (b.days_ago || ' days')::interval,
    NOW() - (b.days_ago || ' days')::interval
FROM (VALUES
    -- cluster 1: IČO 11100024/25/26/27/28 (5+ bounces — contacts 24-28) — hard bounces
    ('lead-24@seed.local', '550', 'hard', 'User unknown. The email account does not exist.', 7),
    ('lead-25@seed.local', '550', 'hard', 'Mailbox not found. User has been removed.', 7),
    ('lead-26@seed.local', '551', 'hard', 'User not local. Please try forwarding to the correct address.', 6),
    ('lead-27@seed.local', '552', 'hard', 'Mailbox full — storage exceeded permanently.', 6),
    ('lead-28@seed.local', '553', 'hard', 'Invalid address format. Transaction failed.', 5),
    -- cluster 2: IČO 11100038/39/46/47/49 (5 hard bounces)
    ('lead-38@seed.local', '550', 'hard', 'No such user here. Delivery permanently failed.', 4),
    ('lead-39@seed.local', '550', 'hard', 'Recipient rejected. Blacklisted sender domain.', 4),
    ('lead-46@seed.local', '551', 'hard', 'User does not exist on this system.', 3),
    ('lead-47@seed.local', '552', 'hard', 'Mailbox unavailable. Account suspended.', 3),
    -- cluster 3: IČO 11100043/44 + additional (hard bounces)
    ('lead-43@seed.local', '553', 'hard', 'Message rejected as spam by remote MTA.', 3),
    ('lead-44@seed.local', '550', 'hard', 'Recipient address rejected — policy violation.', 2),
    ('lead-49@seed.local', '550', 'hard', 'Address rejected. The email account that you tried to reach does not exist.', 2),
    -- isolated hard bounces (8 more firms, 1-2 bounces each)
    ('lead-21@seed.local', '550', 'hard', 'User unknown. Delivery suspended.', 7),
    ('lead-22@seed.local', '551', 'hard', 'User not local. Forwarding not enabled.', 6),
    ('lead-31@seed.local', '552', 'hard', 'Mailbox full — cannot accept further messages.', 4),
    ('lead-32@seed.local', '553', 'hard', 'Transaction failed. Invalid recipient.', 3),
    ('lead-33@seed.local', '550', 'hard', 'No such user here. Verify the address.', 2),
    ('lead-34@seed.local', '551', 'hard', 'User not known at this site.', 2),
    ('lead-35@seed.local', '550', 'hard', 'Address rejected. Account does not exist.', 1),
    ('lead-36@seed.local', '552', 'hard', 'Mailbox unavailable. Permanent failure.', 1),
    -- soft bounces (10 rows, 4xx codes)
    ('lead-23@seed.local', '421', 'soft', 'Service temporarily unavailable. Try again later.', 7),
    ('lead-29@seed.local', '451', 'soft', 'Temporary local problem — please retry later.', 6),
    ('lead-30@seed.local', '452', 'soft', 'Insufficient system storage. Please retry.', 5),
    ('lead-40@seed.local', '421', 'soft', 'Server temporarily unavailable. Retry in 30 minutes.', 4),
    ('lead-41@seed.local', '451', 'soft', 'Temporary spam detection rejection. Retry later.', 3),
    ('lead-42@seed.local', '452', 'soft', 'Mailbox temporarily full. Delivery deferred.', 3),
    ('lead-45@seed.local', '421', 'soft', 'Service not available, closing connection. Try later.', 2),
    ('lead-48@seed.local', '451', 'soft', 'Requested action aborted — local error. Retry.', 2),
    ('lead-50@seed.local', '452', 'soft', 'Too many recipients. Retry with fewer addresses.', 1),
    ('lead-37@seed.local', '421', 'soft', 'Connect to MX failed. Retry in 1 hour.', 1)
) AS b(email, code, btype, reason, days_ago)
JOIN contacts c ON c.email = b.email
WHERE NOT EXISTS (
    SELECT 1 FROM send_events se2
    WHERE se2.message_id = 'scen-se-bounce-' || c.email
);

-- Now insert bounce_events linked to above send_events
INSERT INTO bounce_events (send_event_id, contact_id, bounce_type, bounce_code, bounce_reason, processed_at)
SELECT
    se.id,
    se.contact_id,
    b.btype,
    b.code,
    b.reason,
    se.sent_at + INTERVAL '2 hours'
FROM send_events se
JOIN (VALUES
    ('lead-24@seed.local', '550', 'hard', 'User unknown. The email account does not exist.'),
    ('lead-25@seed.local', '550', 'hard', 'Mailbox not found. User has been removed.'),
    ('lead-26@seed.local', '551', 'hard', 'User not local. Please try forwarding to the correct address.'),
    ('lead-27@seed.local', '552', 'hard', 'Mailbox full — storage exceeded permanently.'),
    ('lead-28@seed.local', '553', 'hard', 'Invalid address format. Transaction failed.'),
    ('lead-38@seed.local', '550', 'hard', 'No such user here. Delivery permanently failed.'),
    ('lead-39@seed.local', '550', 'hard', 'Recipient rejected. Blacklisted sender domain.'),
    ('lead-46@seed.local', '551', 'hard', 'User does not exist on this system.'),
    ('lead-47@seed.local', '552', 'hard', 'Mailbox unavailable. Account suspended.'),
    ('lead-43@seed.local', '553', 'hard', 'Message rejected as spam by remote MTA.'),
    ('lead-44@seed.local', '550', 'hard', 'Recipient address rejected — policy violation.'),
    ('lead-49@seed.local', '550', 'hard', 'Address rejected. The email account that you tried to reach does not exist.'),
    ('lead-21@seed.local', '550', 'hard', 'User unknown. Delivery suspended.'),
    ('lead-22@seed.local', '551', 'hard', 'User not local. Forwarding not enabled.'),
    ('lead-31@seed.local', '552', 'hard', 'Mailbox full — cannot accept further messages.'),
    ('lead-32@seed.local', '553', 'hard', 'Transaction failed. Invalid recipient.'),
    ('lead-33@seed.local', '550', 'hard', 'No such user here. Verify the address.'),
    ('lead-34@seed.local', '551', 'hard', 'User not known at this site.'),
    ('lead-35@seed.local', '550', 'hard', 'Address rejected. Account does not exist.'),
    ('lead-36@seed.local', '552', 'hard', 'Mailbox unavailable. Permanent failure.'),
    ('lead-23@seed.local', '421', 'soft', 'Service temporarily unavailable. Try again later.'),
    ('lead-29@seed.local', '451', 'soft', 'Temporary local problem — please retry later.'),
    ('lead-30@seed.local', '452', 'soft', 'Insufficient system storage. Please retry.'),
    ('lead-40@seed.local', '421', 'soft', 'Server temporarily unavailable. Retry in 30 minutes.'),
    ('lead-41@seed.local', '451', 'soft', 'Temporary spam detection rejection. Retry later.'),
    ('lead-42@seed.local', '452', 'soft', 'Mailbox temporarily full. Delivery deferred.'),
    ('lead-45@seed.local', '421', 'soft', 'Service not available, closing connection. Try later.'),
    ('lead-48@seed.local', '451', 'soft', 'Requested action aborted — local error. Retry.'),
    ('lead-50@seed.local', '452', 'soft', 'Too many recipients. Retry with fewer addresses.'),
    ('lead-37@seed.local', '421', 'soft', 'Connect to MX failed. Retry in 1 hour.')
) AS b(email, code, btype, reason)
ON se.message_id = 'scen-se-bounce-' || b.email
WHERE se.campaign_id = (SELECT id FROM campaigns WHERE name = '[SCENARIO] Demo data — DELETE BEFORE PROD' LIMIT 1);

-- =============================================================================
-- D. SEND_EVENTS (200 rows) + TRACKING_EVENTS (80 rows: 50 opens + 25 clicks + 5 replies)
-- =============================================================================

-- Insert 200 send_events spread across 7 days
-- Using contacts lead-01..lead-50 × 4 steps/sends = 200 rows
INSERT INTO send_events (campaign_id, contact_id, step, mailbox_used, message_id, subject, status, sent_at, created_at)
SELECT
    (SELECT id FROM campaigns WHERE name = '[SCENARIO] Demo data — DELETE BEFORE PROD' LIMIT 1),
    c.id,
    s.step_num,
    CASE (s.step_num % 3) WHEN 0 THEN 'mazher.a@email.cz' WHEN 1 THEN 'a.mazher@email.cz' ELSE 'maarek.b@email.cz' END,
    'scen-se-' || c.email || '-step' || s.step_num,
    CASE s.step_num
        WHEN 1 THEN 'Nabídka výkupu průmyslových strojů a zařízení'
        WHEN 2 THEN 'Followup: Výkup průmyslové techniky — máme zájem o vaše stroje'
        WHEN 3 THEN 'Poslední připomínka: Nabídka výkupu platí do konce měsíce'
        ELSE 'Nabídka výkupu průmyslových strojů a zařízení'
    END,
    'sent',
    NOW() - ((8 - s.step_num - (c.id % 7)) || ' days')::interval + ((c.id % 24) || ' hours')::interval,
    NOW() - ((8 - s.step_num - (c.id % 7)) || ' days')::interval + ((c.id % 24) || ' hours')::interval
FROM contacts c
CROSS JOIN (VALUES (1),(2),(3),(4)) AS s(step_num)
WHERE c.email LIKE '%@seed.local'
  AND NOT EXISTS (
    SELECT 1 FROM send_events se2
    WHERE se2.message_id = 'scen-se-' || c.email || '-step' || s.step_num
  );

-- 50 open tracking events (one per first send_event per contact)
INSERT INTO tracking_events (send_event_id, event_type, metadata, ip_address, user_agent, created_at)
SELECT
    se.id,
    'open',
    ('{"campaign_id":' || se.campaign_id || ',"step":' || se.step || '}')::jsonb,
    ('10.0.' || (se.contact_id % 255) || '.1')::inet,
    CASE (se.contact_id % 4)
        WHEN 0 THEN 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        WHEN 1 THEN 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'
        WHEN 2 THEN 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
        ELSE 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0'
    END,
    se.sent_at + ((se.contact_id % 72 + 1) || ' hours')::interval
FROM send_events se
JOIN contacts c ON c.id = se.contact_id
WHERE se.campaign_id = (SELECT id FROM campaigns WHERE name = '[SCENARIO] Demo data — DELETE BEFORE PROD' LIMIT 1)
  AND c.email LIKE '%@seed.local'
  AND se.step = 1
ORDER BY se.id
LIMIT 50;

-- 25 click tracking events (subset of opens — contacts that clicked within 24h after open)
INSERT INTO tracking_events (send_event_id, event_type, metadata, ip_address, user_agent, created_at)
SELECT
    te_open.send_event_id,
    'click',
    ('{"url":"/r/sc-' || te_open.send_event_id || '","campaign_id":' || se.campaign_id || '}')::jsonb,
    te_open.ip_address,
    te_open.user_agent,
    te_open.created_at + ((se.contact_id % 12 + 1) || ' hours')::interval
FROM tracking_events te_open
JOIN send_events se ON se.id = te_open.send_event_id
JOIN contacts c ON c.id = se.contact_id
WHERE te_open.event_type = 'open'
  AND se.campaign_id = (SELECT id FROM campaigns WHERE name = '[SCENARIO] Demo data — DELETE BEFORE PROD' LIMIT 1)
  AND c.email LIKE '%@seed.local'
  AND (c.id % 2 = 0)  -- roughly half of openers clicked
ORDER BY te_open.id
LIMIT 25;

-- 5 reply tracking events (matched to send_events of contacts that replied)
INSERT INTO tracking_events (send_event_id, event_type, metadata, ip_address, user_agent, created_at)
SELECT
    se.id,
    'reply',
    ('{"classification":"interested","campaign_id":' || se.campaign_id || '}')::jsonb,
    NULL,
    NULL,
    se.sent_at + INTERVAL '2 days'
FROM send_events se
JOIN contacts c ON c.id = se.contact_id
WHERE se.campaign_id = (SELECT id FROM campaigns WHERE name = '[SCENARIO] Demo data — DELETE BEFORE PROD' LIMIT 1)
  AND c.email IN ('lead-01@seed.local','lead-05@seed.local','lead-08@seed.local','lead-09@seed.local','lead-18@seed.local')
  AND se.step = 1
LIMIT 5;

-- =============================================================================
-- E. WATCHDOG EVENTS (10 rows: 3 critical, 4 warning, 3 info)
-- =============================================================================

INSERT INTO watchdog_events (check_name, severity, entity_type, entity_id, message, auto_healed, healed_at, created_at, event_type, mailbox_id, reason, metadata)
VALUES
-- CRITICAL (3)
('mailbox_bounce_rate',    'critical', 'mailbox',  1,   '[SCENARIO] Mailbox mazher.a@email.cz bounce rate překročila 5% (aktuálně 7.3%). Doporučujeme pozastavit odesílání.', false, NULL, NOW() - '18 hours'::interval, 'threshold_exceeded', 1, 'bounce_rate_above_threshold', '{"bounce_rate":0.073,"threshold":0.05,"window_hours":24,"scenario":true}'::jsonb),
('anti_trace_queue_depth', 'critical', 'system',   NULL,'[SCENARIO] Fronta relay překročila 500 zpráv. Zpracování zpomaleno. Zkontrolujte proxy dostupnost.', false, NULL, NOW() - '12 hours'::interval, 'queue_depth_exceeded', NULL, 'relay_queue_backlog', '{"queue_depth":523,"threshold":500,"scenario":true}'::jsonb),
('imap_poll_failed',       'critical', 'mailbox',  3,   '[SCENARIO] IMAP poll selhal 3× za sebou pro mailbox a.mazher@email.cz. Možná chyba autentizace.', true, NOW() - '10 hours'::interval, NOW() - '11 hours'::interval, 'consecutive_failures', 3, 'imap_auth_error', '{"consecutive_failures":3,"mailbox":"a.mazher@email.cz","scenario":true}'::jsonb),
-- WARNING (4)
('template_render_slow',   'warning',  'campaign', (SELECT id FROM campaigns WHERE name = '[SCENARIO] Demo data — DELETE BEFORE PROD' LIMIT 1), '[SCENARIO] Renderování šablony trvalo >2s (2.34s). Možné zpomalení odesílání.', false, NULL, NOW() - '8 hours'::interval, 'performance_degradation', NULL, 'render_timeout', '{"render_ms":2340,"threshold_ms":2000,"scenario":true}'::jsonb),
('daily_cap_nearing',      'warning',  'mailbox',  1,   '[SCENARIO] Mailbox mazher.a@email.cz použil 95/120 denního limitu. Zbývá 25 odesílání.', false, NULL, NOW() - '6 hours'::interval, 'cap_warning', 1, 'daily_cap_nearing_limit', '{"sent":95,"cap":120,"remaining":25,"scenario":true}'::jsonb),
('relay_proxy_degraded',   'warning',  'system',   NULL,'[SCENARIO] 3 proxy servery nedostupné. Pool snížen na 12/15. Může ovlivnit CZ delivery.', true, NOW() - '4 hours'::interval, NOW() - '5 hours'::interval, 'pool_degraded', NULL, 'proxy_health_failure', '{"available":12,"total":15,"failed":3,"scenario":true}'::jsonb),
('send_rate_throttled',    'warning',  'mailbox',  632, '[SCENARIO] Mailbox maarek.b@email.cz throttlován Seznam servery. Zpomalení na 50% rychlosti.', false, NULL, NOW() - '3 hours'::interval, 'send_rate_limited', 632, 'smtp_throttle', '{"throttle_pct":50,"mailbox":"maarek.b@email.cz","scenario":true}'::jsonb),
-- INFO (3)
('cron_heartbeat',         'info',     'system',   NULL,'[SCENARIO] Cron scheduler aktivní. Všechny úlohy v pořádku. Posledních 24h bez výpadků.', false, NULL, NOW() - '1 hour'::interval, 'heartbeat', NULL, 'normal', '{"jobs_ok":12,"jobs_failed":0,"scenario":true}'::jsonb),
('daily_report_ready',     'info',     'campaign', (SELECT id FROM campaigns WHERE name = '[SCENARIO] Demo data — DELETE BEFORE PROD' LIMIT 1), '[SCENARIO] Denní report připraven. Odesláno 47 e-mailů, 18 otevřeno (38%), 5 odpovědí.', false, NULL, NOW() - '30 minutes'::interval, 'report_generated', NULL, 'daily_summary', '{"sent":47,"opened":18,"open_rate":0.38,"replies":5,"scenario":true}'::jsonb),
('intelligence_loop_ok',   'info',     'system',   NULL,'[SCENARIO] Intelligence loop dokončen. Přehodnoceno 1 247 kontaktů, aktualizováno 89 skóre.', false, NULL, NOW() - '15 minutes'::interval, 'loop_completed', NULL, 'normal', '{"contacts_evaluated":1247,"scores_updated":89,"scenario":true}'::jsonb);

-- =============================================================================
-- F. DEDUP GUARD SKIPS — campaign_contacts with status='skipped' + skip_reason JSONB
-- =============================================================================
-- 16 rows, 1-2 per axis × 8 axes
-- These are campaign_contacts rows for the scenario campaign.

INSERT INTO campaign_contacts (campaign_id, contact_id, current_step, status, next_send_at, created_at, details)
SELECT
    (SELECT id FROM campaigns WHERE name = '[SCENARIO] Demo data — DELETE BEFORE PROD' LIMIT 1),
    c.id,
    0,
    'skipped',
    NULL,
    NOW() - (d.days_ago || ' days')::interval,
    d.details
FROM (VALUES
    -- dnt_set (2 rows)
    ('lead-01@seed.local', 3, '{"skip_reason":"dnt_set","axis":"dnt_set","contact_email":"lead-01@seed.local","skipped_at":"2026-05-04T08:00:00Z","scenario":true}'::jsonb),
    ('lead-02@seed.local', 3, '{"skip_reason":"dnt_set","axis":"dnt_set","contact_email":"lead-02@seed.local","skipped_at":"2026-05-04T09:00:00Z","scenario":true}'::jsonb),
    -- lifetime_exhausted (2 rows)
    ('lead-03@seed.local', 4, '{"skip_reason":"lifetime_exhausted","axis":"lifetime_exhausted","lifetime_touches":10,"max_touches":10,"contact_email":"lead-03@seed.local","skipped_at":"2026-05-03T10:00:00Z","scenario":true}'::jsonb),
    ('lead-04@seed.local', 4, '{"skip_reason":"lifetime_exhausted","axis":"lifetime_exhausted","lifetime_touches":10,"max_touches":10,"contact_email":"lead-04@seed.local","skipped_at":"2026-05-03T11:00:00Z","scenario":true}'::jsonb),
    -- cross_campaign_cooldown (2 rows)
    ('lead-05@seed.local', 5, '{"skip_reason":"cross_campaign_cooldown","axis":"cross_campaign_cooldown","last_campaign_id":455,"cooldown_days":30,"days_since_last":12,"contact_email":"lead-05@seed.local","skipped_at":"2026-05-02T08:00:00Z","scenario":true}'::jsonb),
    ('lead-06@seed.local', 5, '{"skip_reason":"cross_campaign_cooldown","axis":"cross_campaign_cooldown","last_campaign_id":455,"cooldown_days":30,"days_since_last":8,"contact_email":"lead-06@seed.local","skipped_at":"2026-05-02T09:00:00Z","scenario":true}'::jsonb),
    -- per_domain_cooldown (2 rows)
    ('lead-07@seed.local', 6, '{"skip_reason":"per_domain_cooldown","axis":"per_domain_cooldown","domain":"seed.local","domain_sent_today":5,"domain_cap":5,"contact_email":"lead-07@seed.local","skipped_at":"2026-05-01T14:00:00Z","scenario":true}'::jsonb),
    ('lead-08@seed.local', 6, '{"skip_reason":"per_domain_cooldown","axis":"per_domain_cooldown","domain":"seed.local","domain_sent_today":5,"domain_cap":5,"contact_email":"lead-08@seed.local","skipped_at":"2026-05-01T15:00:00Z","scenario":true}'::jsonb),
    -- bounce_cluster (2 rows)
    ('lead-24@seed.local', 7, '{"skip_reason":"bounce_cluster","axis":"bounce_cluster","ico":"11100024","bounce_count_7d":5,"threshold":3,"contact_email":"lead-24@seed.local","skipped_at":"2026-04-30T08:00:00Z","scenario":true}'::jsonb),
    ('lead-25@seed.local', 7, '{"skip_reason":"bounce_cluster","axis":"bounce_cluster","ico":"11100025","bounce_count_7d":4,"threshold":3,"contact_email":"lead-25@seed.local","skipped_at":"2026-04-30T09:00:00Z","scenario":true}'::jsonb),
    -- region_rate_limit (2 rows)
    ('lead-31@seed.local', 6, '{"skip_reason":"region_rate_limit","axis":"region_rate_limit","region":"Ostrava","region_sent_today":50,"region_cap":50,"contact_email":"lead-31@seed.local","skipped_at":"2026-04-29T16:00:00Z","scenario":true}'::jsonb),
    ('lead-32@seed.local', 6, '{"skip_reason":"region_rate_limit","axis":"region_rate_limit","region":"Plzeň","region_sent_today":50,"region_cap":50,"contact_email":"lead-32@seed.local","skipped_at":"2026-04-29T17:00:00Z","scenario":true}'::jsonb),
    -- engagement_decay (2 rows)
    ('lead-33@seed.local', 5, '{"skip_reason":"engagement_decay","axis":"engagement_decay","last_open_days_ago":45,"decay_threshold_days":30,"contact_email":"lead-33@seed.local","skipped_at":"2026-04-28T10:00:00Z","scenario":true}'::jsonb),
    ('lead-34@seed.local', 5, '{"skip_reason":"engagement_decay","axis":"engagement_decay","last_open_days_ago":60,"decay_threshold_days":30,"contact_email":"lead-34@seed.local","skipped_at":"2026-04-28T11:00:00Z","scenario":true}'::jsonb),
    -- crm_active_client (2 rows)
    ('lead-35@seed.local', 4, '{"skip_reason":"crm_active_client","axis":"crm_active_client","crm_client_id":9901,"crm_status":"active","contact_email":"lead-35@seed.local","skipped_at":"2026-04-27T08:00:00Z","scenario":true}'::jsonb),
    ('lead-36@seed.local', 4, '{"skip_reason":"crm_active_client","axis":"crm_active_client","crm_client_id":9902,"crm_status":"active","contact_email":"lead-36@seed.local","skipped_at":"2026-04-27T09:00:00Z","scenario":true}'::jsonb)
) AS d(email, days_ago, details)
JOIN contacts c ON c.email = d.email
ON CONFLICT (campaign_id, contact_id) DO NOTHING;

COMMIT;
