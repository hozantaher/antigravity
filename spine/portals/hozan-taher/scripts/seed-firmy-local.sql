-- seed-firmy-local.sql
-- Minimal firmy DB schema + seed data for local development.
-- Mirrors the structure read by the dashboard (prospects endpoints + stats).
-- Idempotent: uses CREATE TABLE IF NOT EXISTS + ON CONFLICT DO NOTHING.

-- ── Schema ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS firmy_cz_businesses (
    id                SERIAL PRIMARY KEY,
    name              TEXT NOT NULL,
    email             TEXT,
    telephone         TEXT,
    website           TEXT,
    ico               TEXT,
    street_address    TEXT,
    address_locality  TEXT,
    postal_code       TEXT,
    description       TEXT,
    velikost_firmy    TEXT,
    pravni_forma      TEXT,
    category_path     TEXT,
    rating_value      REAL DEFAULT 0,
    rating_count      INT  DEFAULT 0,
    created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fb_name    ON firmy_cz_businesses(name);
CREATE INDEX IF NOT EXISTS idx_fb_email   ON firmy_cz_businesses(email);
CREATE INDEX IF NOT EXISTS idx_fb_ico     ON firmy_cz_businesses(ico);
CREATE INDEX IF NOT EXISTS idx_fb_region  ON firmy_cz_businesses(address_locality);

-- ── Seed: 20 firms matching the outreach machinery sector ───────────────
INSERT INTO firmy_cz_businesses
    (id, name, email, telephone, website, ico, street_address, address_locality,
     postal_code, description, velikost_firmy, pravni_forma, category_path,
     rating_value, rating_count)
VALUES
  (1001, 'Strojírny Praha s.r.o.',        'info@strojirny-praha.cz',    '+420212345678',  'www.strojirny-praha.cz',    '12345678', 'Průmyslová 1',    'Praha',    '10000', 'Výroba a opravy průmyslových strojů a CNC obráběcích center.',        '25 - 49 zaměstnanců', 's.r.o.', 'Průmysl > Strojírenství',           4.2, 12),
  (1002, 'Kovárna Brno a.s.',              'info@kovarna-brno.cz',       '+420513456789',  'www.kovarna-brno.cz',       '23456789', 'Kovářská 5',      'Brno',     '60200', 'Kovoobrábění a svařování ocelových konstrukcí.',                      '50 - 99 zaměstnanců', 'a.s.',   'Průmysl > Kovovýroba',              4.5, 8),
  (1003, 'Průmyslové Dílny Ostrava s.r.o.','info@dilny-ostrava.cz',      '+420596789012',  'www.dilny-ostrava.cz',      '34567890', 'Nádražní 22',     'Ostrava',  '70200', 'Montáž a výroba průmyslových zařízení. Zemní práce.',                 '10 - 19 zaměstnanců', 's.r.o.', 'Průmysl > Strojírenství',           3.8, 5),
  (1004, 'TechnoPlast Plzeň s.r.o.',       'info@technoplast.cz',        '+420377890123',  'www.technoplast.cz',        '45678901', 'Škodova 7',       'Plzeň',    '30100', 'Výroba plastových komponentů pro automobilový průmysl.',              '100 - 249 zaměstnanců','s.r.o.', 'Průmysl > Plasty',                  4.0, 15),
  (1005, 'MetalWorks Liberec s.r.o.',      NULL,                         '+420485901234',  'www.metalworks-liberec.cz', '56789012', 'Tovární 3',       'Liberec',  '46001', 'Přesné kovové díly a odlitky pro strojní průmysl.',                   '25 - 49 zaměstnanců', 's.r.o.', 'Průmysl > Kovovýroba',              3.5, 3),
  (1006, 'Svářečská Dílna Jihlava s.r.o.', 'info@svarecska-jihlava.cz',  '+420567012345',  NULL,                        '67890123', 'Havlíčkova 14',   'Jihlava',  '58601', 'Svářečské a zámečnické práce. Výroba ocelových konstrukcí na míru.',  '5 - 9 zaměstnanců',  's.r.o.', 'Řemesla > Svářečství',              4.8, 21),
  (1007, 'Obrábění CNC Hradec s.r.o.',     'info@cnc-hradec.cz',         '+420495123456',  'www.cnc-hradec.cz',         '78901234', 'Průmyslová 8',    'Hradec Králové', '50002', 'CNC obrábění na zakázku. Sériová i kusová výroba.',            '10 - 19 zaměstnanců', 's.r.o.', 'Průmysl > CNC obrábění',            4.3, 9),
  (1008, 'Malá Dílna Tábor',               NULL,                         NULL,             NULL,                        NULL,       'Náměstí 1',       'Tábor',    '39001', NULL,                                                                  '1 - 4 zaměstnanci',   'FO',     'Řemesla',                           0.0, 0),
  (1009, 'Zámečnictví Kutná Hora',         NULL,                         '+420327234567',  NULL,                        NULL,       'Čechova 3',       'Kutná Hora','28401', 'Zámečnické a klempířské práce.',                                      '1 - 4 zaměstnanci',   'FO',     'Řemesla > Zámečnictví',             3.2, 2),
  (1010, 'Klempířství Znojmo s.r.o.',      NULL,                         '+420515345678',  NULL,                        NULL,       'Horní náměstí 5', 'Znojmo',   '66902', 'Klempířské práce, oplechování střech.',                               '1 - 4 zaměstnanci',   's.r.o.', 'Řemesla > Klempířství',             0.0, 0),
  (1011, 'Hydraulika Olomouc a.s.',        'info@hydraulika-olomouc.cz', '+420585456789',  'www.hydraulika-olomouc.cz', '11111111', 'Kosmonautů 10',   'Olomouc',  '77900', 'Výroba a opravy hydraulických systémů a válců.',                      '50 - 99 zaměstnanců', 'a.s.',   'Průmysl > Hydraulika',              4.1, 6),
  (1012, 'Pneumatika CB s.r.o.',           'obchod@pneumatika-cb.cz',    '+420387567890',  'www.pneumatika-cb.cz',      '22222222', 'Lidická 20',      'České Budějovice','37001','Pneumatické komponenty a rozvody. Servis kompresory.',           '10 - 19 zaměstnanců', 's.r.o.', 'Průmysl > Pneumatika',              3.9, 4),
  (1013, 'Svářečská škola Praha s.r.o.',   'info@svarecska-skola.cz',    '+420222678901',  'www.svarecska-skola.cz',    '33333333', 'Sokolovská 44',   'Praha',    '18600', 'Kurzy svařování a certifikace EN 287/ISO 9606.',                      '5 - 9 zaměstnanců',  's.r.o.', 'Vzdělávání > Technické kurzy',      4.7, 18),
  (1014, 'Frézovna Děčín s.r.o.',          'freza@decin.cz',             NULL,             NULL,                        '44444444', 'Přístavní 2',     'Děčín',    '40502', 'Frézování a soustružení rotačních dílů.',                             '5 - 9 zaměstnanců',  's.r.o.', 'Průmysl > CNC obrábění',            4.0, 7),
  (1015, 'Lisovna Zlín a.s.',              'lisovna@zlin.cz',            '+420577789012',  'www.lisovna-zlin.cz',       '55555555', 'Průmyslová 15',   'Zlín',     '76001', 'Tváření a lisování kovových dílů. Prototypy i série.',                '100 - 249 zaměstnanců','a.s.',  'Průmysl > Kovovýroba',              4.4, 11),
  (1016, 'Elektro Montáže Brno s.r.o.',    'info@elektro-brno.cz',       '+420549890123',  NULL,                        '66666666', 'Vídeňská 80',     'Brno',     '63900', 'Průmyslové elektroinstalace a rozvaděče.',                            '10 - 19 zaměstnanců', 's.r.o.', 'Elektro > Průmyslové instalace',    3.7, 3),
  (1017, 'Robotika Praha s.r.o.',          'sales@robotika-praha.cz',    '+420221901234',  'www.robotika-praha.cz',     '77777777', 'Na příkopě 1',    'Praha',    '11000', 'Automatizace výrobních linek. Průmyslové roboty.',                    '25 - 49 zaměstnanců', 's.r.o.', 'Průmysl > Automatizace',            4.6, 14),
  (1018, 'Svářecí Technika Pardubice',     'info@svarecitechnika.cz',    '+420466012345',  NULL,                        '88888888', 'Masarykovo nám. 3','Pardubice','53002', 'Prodej a servis svářecích strojů a příslušenství.',                   '5 - 9 zaměstnanců',  'FO',     'Obchod > Průmyslové zboží',         4.2, 5),
  (1019, 'Průmyslové Čistírny Ostrava',    'cistirny@ostrava-ind.cz',    '+420596123456',  NULL,                        '99999990', 'Nová 7',          'Ostrava',  '70100', 'Průmyslové čistírny dílů. Odmašťování a fosfátování.',                '10 - 19 zaměstnanců', 's.r.o.', 'Průmysl > Povrchové úpravy',        3.6, 2),
  (1020, 'Kalírna Kladno a.s.',            'info@kalirna-kladno.cz',     '+420312234567',  'www.kalirna-kladno.cz',     '10101010', 'Hutnická 6',      'Kladno',   '27201', 'Tepelné zpracování kovů. Kalení, cementování, nitridování.',          '50 - 99 zaměstnanců', 'a.s.',   'Průmysl > Tepelné zpracování',      4.3, 8)
ON CONFLICT (id) DO NOTHING;

SELECT setval('firmy_cz_businesses_id_seq', GREATEST(1020, (SELECT COALESCE(MAX(id), 0) FROM firmy_cz_businesses)));
