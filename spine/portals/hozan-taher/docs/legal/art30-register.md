# Záznam o činnostech zpracování (GDPR čl. 30)

**Controller:** Garaaage s.r.o., Purkyňova 74/2, 110 00 Praha 1, IČO 23219700
**Datum poslední aktualizace:** 2026-05-06
**Verze:** 1.2

> **Změny ve verzi 1.2 (2026-05-06):** Činnost zpracování č. 1 — sjednocen termín na "výkup použité techniky pro vývoz", rozšířena kategorie subjektů z NACE 41–43 na NACE 41–43 + 45 + 46 + 49 + 77 + 01 (v souladu s aktualizovanou LIA verze 1.2).
>
> **Změny ve verzi 1.1 (2026-04-30):** Přidána Činnost zpracování č. 6 — interní photo parsing přes lokální Ollama LLM (M+3 minimal scope, ROPA #2 v exekučním plánu). Aktualizován scope DSR cascade o tři nové audit tabulky (`channel_audit_log`, `ai_suggestion_audit`, `photo_parse_audit`) — viz `privacy-notice.md` § 7 a migration `scripts/migrations/019_audit_log_schemas.sql`.

---

## Činnost zpracování č. 1 — B2B přímý marketing (výkup techniky)

| Pole | Hodnota |
|---|---|
| Název činnosti | B2B přímý marketing — výkup použité techniky pro vývoz do zahraničí |
| Účel | Oslovení firem s nabídkou výkupu použité techniky (automobil, dodávka, kamion, bagr, nakladač, traktor, jeřáb, vysokozdvižný vozík) |
| Právní základ | Čl. 6/1/f GDPR (oprávněný zájem) — viz `lia-direct-marketing.md` |
| Kategorie subjektů | Firmy zapsané ve veřejném obchodním rejstříku (firmy.cz), NACE 41–43 (stavebnictví), 45 (motorová vozidla), 46 (velkoobchod), 49 (doprava), 77 (pronájem strojů), 01 (zemědělství) |
| Kategorie údajů | E-mail, jméno, název firmy, IČO, sídlo, region, NACE, klasifikace činnosti |
| Zdroj údajů | firmy.cz (veřejný obchodní rejstřík), ARES, justice.cz |
| Příjemci | Anti-trace-relay (subprocessor — bezpečnostní e-mail infra), Railway.app (hosting), Seznam.cz (e-mail provider) |
| Předávání mimo EHP | NE |
| Doba uchování | 12 měsíců od posledního kontaktu; po opt-out trvale jen e-mail v suppression listu |
| Bezpečnostní opatření | TLS 1.3, AES-256-GCM šifrování, rotace tokenů, audit log, Sentry monitoring |

---

## Činnost zpracování č. 2 — Reply tracking + lead management

| Pole | Hodnota |
|---|---|
| Název činnosti | Klasifikace odpovědí + správa leads |
| Účel | Identifikace zájemců o spolupráci, follow-up, klasifikace sentiment |
| Právní základ | Čl. 6/1/f GDPR (oprávněný zájem) + souhlas implicitně přes odpověď na e-mail |
| Kategorie subjektů | Recipienti, kteří odpověděli na náš e-mail |
| Kategorie údajů | Obsah odpovědi, sentiment klasifikace, časové údaje, In-Reply-To header |
| Zdroj údajů | Odpovědi recipientů (IMAP fetch z mailboxů) |
| Příjemci | Garaaage interní tým (operátoři) |
| Doba uchování | 24 měsíců od poslední komunikace; thread se uzavře po negativní odpovědi nebo opt-out |
| Bezpečnostní opatření | Stejně jako činnost č. 1 + LLM klasifikace probíhá lokálně (Ollama), není odesílána třetí straně |

---

## Činnost zpracování č. 3 — Suppression management (opt-out)

| Pole | Hodnota |
|---|---|
| Název činnosti | Správa suppression listu (opt-out registr) |
| Účel | Trvalé zajištění, že subjekt po námitce již nedostane další e-maily |
| Právní základ | Čl. 6/1/c GDPR (právní povinnost — § 7 zákona č. 480/2004 Sb.) |
| Kategorie subjektů | Subjekty, které využily opt-out, námitku, nebo jsou identifikovány jako spamtrap/honeypot |
| Kategorie údajů | E-mailová adresa (hash + plain), důvod, časový razítka |
| Zdroj údajů | Click na unsubscribe link, e-mail na privacy@, manuální vložení operátorem |
| Příjemci | Pouze interní (suppression UNION query při každém send tick) |
| Doba uchování | TRVALE (důvod: prevence opětovného oslovení) |
| Bezpečnostní opatření | Database-level encryption, audit log, dual-table redundance |

---

## Činnost zpracování č. 4 — Tracking events (opens, clicks)

| Pole | Hodnota |
|---|---|
| Název činnosti | Sledování interakce s e-mailem |
| Účel | Měření efektivity kampaní, optimalizace timing, klasifikace engagement |
| Právní základ | Čl. 6/1/f GDPR (oprávněný zájem na měření efektivity B2B marketingu) |
| Kategorie subjektů | Recipienti, kteří otevřeli/klikli na e-mail |
| Kategorie údajů | IP adresa, User-Agent, časový razítka, message_id |
| Zdroj údajů | HTTP request na tracking pixel (`/o`) a click redirect (`/c`) |
| Příjemci | Pouze interní agregace; jednotlivé eventy nejsou exportovány |
| Doba uchování | 12 měsíců |
| Bezpečnostní opatření | EXISTS guard (BF-D4) zabraňuje injekci falešných tokenů; agregace bez identifikace jednotlivců |

---

## Činnost zpracování č. 5 — Audit log

| Pole | Hodnota |
|---|---|
| Název činnosti | Operátorský audit log |
| Účel | Compliance — záznam všech operací nad osobními údaji (send, opt-out, erasure, edit) |
| Právní základ | Čl. 5/2 + 24 + 30 GDPR (accountability) |
| Kategorie subjektů | Subjekty, jejichž údaje jsou zpracovávány |
| Kategorie údajů | Action type, actor, entity_id, timestamp, JSONB metadata |
| Doba uchování | 5 let (audit-retention cron) |
| Bezpečnostní opatření | Append-only, no DELETE povoleno |

---

## Činnost zpracování č. 6 — Interní photo parsing (Ollama lokální)

> Mapuje na **ROPA #2** v exekučním plánu M+3 minimal scope (`docs/strategy/`).

| Pole | Hodnota |
|---|---|
| Název činnosti | Interní extrakce atributů techniky z fotografií (Garaaage portal listing prep) |
| Účel | Z příchozí fotografie použité stavební techniky (e-mailová příloha) extrahovat strukturované atributy — značka, model, rok výroby, stav — pro přípravu inzerátu na Garaaage portálu. |
| Právní základ | Čl. 6/1/f GDPR (oprávněný zájem) — pokračování legitimního zájmu z Činnosti č. 1 (B2B sourcing). Viz `lia-direct-marketing.md` § 3.5 (per-channel balancing test). |
| Kategorie subjektů | Firmy a kontaktní osoby, které správci zaslaly fotografii v rámci komunikace o výkupu techniky |
| Kategorie údajů | Binární data fotografie (`blob_ref`), strukturované atributy techniky (`retained` JSONB), případně OCR text či detekované obličeje a SPZ vozidel jako součást `discarded` JSONB (data minimization audit) |
| Zdroj údajů | Pouze přímé zaslání subjektem v reakci na naše oslovení (nikdy ne třetí strana) |
| Příjemci | **Žádní externí subprocessoři.** LLM (Ollama llama3.2-vision) běží lokálně na infrastruktuře správce. Žádný přenos do třetí země. |
| Předávání mimo EHP | NE |
| Doba uchování | Fotografie: **12 měsíců** od přijetí. Extrahované atributy (`retained`): 12 měsíců. Audit záznam o parse-eventu (`photo_parse_audit`): 12 měsíců. |
| Bezpečnostní opatření | AES-256-GCM šifrování `blob_ref` storage, audit log v tabulce `photo_parse_audit`, data-minimization při parse-time (obličeje a SPZ se přesouvají do `discarded` JSONB a nejsou součástí `retained`), Sentry monitoring. |
| Migrační kotva | `scripts/migrations/019_audit_log_schemas.sql` (tabulka `photo_parse_audit`) |

---

## Audit tabulky (Track E, migration 019)

Tři nové append-only tabulky doplňují accountability vrstvu pro M+3 minimal scope. Všechny obsahují JSONB `details` pro forward-compatible rozšíření bez ALTER TABLE.

| Tabulka | Účel | Retence | Vazba na Činnost |
|---|---|---|---|
| `channel_audit_log` | Per-channel send/receive audit (e-mail dnes; whatsapp/portal_event rezervovány pro Phase 2) | 24 měsíců | Č. 1, Č. 2 |
| `ai_suggestion_audit` | RLHF dataset: AI návrh + akce operátora (`approved` / `edited` / `rejected`) | 24 měsíců (anonymizováno při DSR erase) | Č. 2 |
| `photo_parse_audit` | Audit lokální Ollama vision extrakce (extracted / retained / discarded) | 12 měsíců | Č. 6 |

**DSR cascade chování (čl. 17 GDPR):**

- `channel_audit_log` — DELETE (per-channel breadcrumb není nezbytný pro důkaz opt-outu; ten zajišťuje suppression UNION).
- `ai_suggestion_audit` — ANONYMIZE (`thread_id → NULL`, `operator_id → 'erased'`). Text návrhu zůstává jako interní accountability data dle čl. 5/2; vazba na subjekt je odstraněna.
- `photo_parse_audit` — bez kaskády. Schéma neobsahuje `subject_email` ani `contact_id`; tabulka eviduje pouze parse-event, nikoli subjekt.

---

## Subprocessory (DPA required)

| Provider | Účel | Status DPA |
|---|---|---|
| Railway.app | Hosting (PostgreSQL, Go services, Node BFF) | TODO — zajistit standard DPA |
| Anti-trace-relay (interní service na Railway) | E-mail egress přes SOCKS proxy pool | Vlastní service, žádný external DPA |
| Seznam.cz | E-mail SMTP provider (sender mailboxes) | Pokrytý ToS Seznam.cz Email služby |
| Ollama (lokální LLM) | Klasifikace replies + photo parsing (Činnost č. 6) | Lokální, bez external DPA |
| Anthropic (Claude API) | Generování personalizovaných openerů | TODO — zajistit standard DPA / MSA |
| Sentry | Error monitoring | TODO — zajistit standard DPA |

---

## Příští review

- Roční (duben 2027)
- Při přidání nového subprocessoru
- Při významné změně účelu nebo scope
