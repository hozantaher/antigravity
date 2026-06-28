# Operator Config Extraction — vyndat hardcoded business hodnoty z kódu

**Status:** Open
**Datum:** 2026-05-07
**Trigger:** Deep inventory dnes (po PR #1067 Garaaage rebrand) odhalila že "změna firmy v patičce" stála 16 souborů + 3 PR + ~3 hodiny práce. Operátor by měl být schopen změnit kontrolora, personu, telefon a šablony přes admin UI nebo SQL UPDATE — bez code review, bez deploye, bez audit ratchet flips. Aktuálně 9 kategorií business hodnot žije v Go/JS kódu místo v DB.

## Proč to je problém

Systém `outreach-dashboard` je administrátorský panel — operátor zvolí kampaň, šablonu, segment, pustí send. Implicitní design: operátor je vlastník dat a měl by mít kontrolu nad obsahem. Realita: legal entity, persona, telefon, default sekvence a šablony jsou drženy jako konstanty v `humanlike_score.go`, `gdpr_footer_audit_test.go`, 5 `.tmpl` souborů, a 3 různá místa s default sequence (s odlišnými delays). Drift je reálná chyba (Sprint AG níže) a změna kontrolora vyžaduje 16-souborový PR.

## Cíl

Po dokončení iniciativy bude platit:

1. **Změna kontrolora (entity)** = 1 SQL UPDATE řádku v `operator_settings`. Audit ratchet pochopí změnu a přečte aktuální hodnoty z DB.
2. **Změna persony nebo telefonu** = aktualizace v admin UI / DB. Žádný .tmpl, žádný env var.
3. **Default sekvence** = jeden zdroj pravdy v Go. UI handler i Go runner sahají do stejné funkce.
4. **Email šablony** = výhradně v `email_templates` DB tabulce. `configs/templates/` adresář smazán.
5. **LIA NACE scope** = sdílený zdroj přes JSON manifest nebo DB; Go i JS čtou totéž.
6. **ICP targeting** = editovatelný v admin UI; ne hardcoded v Go slice.
7. **Legal docs (Privacy Notice, LIA, Article 30)** = DB rows s verzováním, ne markdown v repu.
8. **Brand bleed** ("Forward to Garaaage", page titles) → generic labels nebo per-tenant config.

## Sprint AF — Entity + persona + telefon do `operator_settings` (PRIORITA 1)

Nejvyšší dopad: změna kontrolora dnes stála 3 PR, mělo by stát 1 UPDATE.

**Co uděláme:**

Vytvoříme DB tabulku `operator_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMPTZ DEFAULT NOW(), updated_by TEXT)`. Naplníme ji aktuálními hodnotami:

- `controller_name` = "BALKAN MOTORS INT DOO"
- `controller_id_label` = "PIB"
- `controller_id_value` = "03387194"
- `controller_seat_address` = "Oktobarske revolucije 130, 81000 Podgorica, Crna Gora"
- `controller_legal_basis_citation` = "čl. 6(1)(f) GDPR ve spojení s Recital 47"
- `sender_default_signature` = "Goran Nowak"
- `sender_default_phone` = "776 299 933"
- `unsubscribe_base_url` = "https://garaaage.cz" (pro orphan tokens)
- `privacy_contact_email` = "privacy@garaaage.cz" (zatím — operátor může změnit)
- `data_source_label` = "firmy.cz"

Migrace: přidá tabulku + INSERT seed. Loader v Go: balíček `features/platform/common/operatorconfig` s `Get(ctx, key) string` + cache (TTL 60s, invalidace na UPDATE event přes Postgres LISTEN). BFF middleware: stejný cache, sdílená logika přes `features/platform/outreach-dashboard/src/lib/operatorConfig.js`.

`humanlike_score.go` přestane mít `gdprNameRe = regexp.MustCompile("BALKAN MOTORS INT DOO")` jako konstantu na úrovni balíčku — místo toho funkce `scoreContent` zavolá `operatorconfig.Get("controller_name")` a zkonstruuje regex inline. Audit ratchet (`gdpr_footer_audit_test.go`) přečte stejnou hodnotu a porovná se substringem v .tmpl/DB body.

Send scripty (`campaign-send-batch.{js,mjs}`) zruší env-var fallback `'Goran Nowak'` a místo něj přečtou `operatorConfig.Get('sender_default_signature')`. Stejné pro telefon — ale telefon by měl být per-mailbox (rozšíření `outreach_mailboxes.sender_phone` už existuje od migrace 057), tak ho čteme primárně z mailbox row a fallback na operator_settings jen když mailbox.sender_phone IS NULL.

UI: nová stránka `/settings/branding` v dashboardu s formulářem pro 10 klíčů. Save = `PUT /api/operator-settings/:key` s X-Confirm-Send guard headerem. Audit log row na každou změnu.

**Tasks (veřejně sledovatelné v GH issues s prefixem `[AF.x]`):**

- AF.1 Migrace `060_operator_settings.sql` — tabulka + seed.
- AF.2 Go balíček `features/platform/common/operatorconfig` s LRU cache + Postgres LISTEN/NOTIFY pro invalidaci.
- AF.3 Refaktor `humanlike_score.go` na dynamic regex načtený z operatorconfig.
- AF.4 Refaktor `gdpr_footer_audit_test.go` — required substrings čte z operatorconfig (test setup nahraje hodnoty do test-DB).
- AF.5 BFF lib `features/platform/outreach-dashboard/src/lib/operatorConfig.js` s ekvivalentním API.
- AF.6 Send scripty (`campaign-send-batch.{js,mjs}`) — drop env fallback, čti z operatorconfig.
- AF.7 BFF endpoint `GET/PUT /api/operator-settings` + audit log integration.
- AF.8 React stránka `/settings/branding` s formulářem.
- AF.9 Inline-render: `features/outreach/campaigns/content/template.go` Render() proloží `{{.ControllerName}}`, `{{.ControllerID}}` atd. — operator uvidí placeholder v UI editoru, render dosadí z operatorconfig.
- AF.10 .tmpl files: nahradit literály placeholdery a checknout že audit ratchet stále prochází.

**Definice hotovo:** SQL UPDATE jednoho řádku v `operator_settings.controller_name` se promítne do nového odeslaného mailu během 60 sekund (cache TTL) bez restartu Go služeb a bez code change.

## Sprint AG — Default sequence drift fix (PRIORITA 1, BUG)

**Co je špatně:** dnes existují tři různé default sekvence:

- `features/outreach/campaigns/campaign/sequence.go:38–40` → step 1: 7d, step 2: 14d
- `features/outreach/campaigns/web/campaigns.go:90–92` → step 1: 5d, step 2: 12d
- `features/inbound/orchestrator/cmd/outreach/main.go:192–194` → step 1: 5d, step 2: 12d

Když operátor vytvoří kampaň přes BFF createCampaign endpoint, dostane 5/12. Když Go runner použije `DefaultSequence()` jako fallback, dostane 7/14. Stejná žádost, různý výsledek. To je bug.

**Co uděláme:** `sequence.DefaultSequence()` zůstává single source of truth. `campaigns.go` a `outreach/main.go` zruší své inline literály a zavolají `campaign.DefaultSequence()`. Hodnoty 7/14 vs 5/12 — operátor rozhodne (asi 5/12, protože to je co dnes vidí v UI). Migration 016_campaigns_sequence_config_default.sql aktualizovat na shodné hodnoty.

**Tasks:**

- AG.1 Operátor potvrdí kanonické delays (5/12 nebo 7/14).
- AG.2 Update `sequence.go DefaultSequence()` na konsensuální hodnoty.
- AG.3 `campaigns.go` zruší vlastní literál, zavolá `campaign.DefaultSequence()`.
- AG.4 `outreach/main.go` totéž.
- AG.5 Migration 060 (nebo bump 016) UPDATE `campaigns.sequence_config` DEFAULT.
- AG.6 Test `TestDefaultSequence_AcrossAllCallers` — všichni 3 callers vrátí stejnou strukturu.

**Definice hotovo:** test ratchet selže pokud někdo přidá 4. fallback s odlišnými hodnotami.

## Sprint AH — Migrace 5 .tmpl souborů do DB (PRIORITA 2)

**Co uděláme:** import obsahu `features/outreach/campaigns/configs/templates/{initial,followup1,final,heavy-01-intro,heavy-03-bump}.tmpl` do `email_templates` table jako řádky se stejnými jmény. Smazat `configs/templates/` adresář. Audit ratchet (`gdpr_footer_audit_test.go`, `gdpr-cascade-shape.test.js`) přepsat na `SELECT body FROM email_templates` query místo `os.ReadDir(dir)`.

`template.go Render()` ztratí file-fallback path (řádky 139–150) — DB-only. Pokud DB row chybí, render vrátí error místo aby tichcho fallbackoval na neexistující soubor.

UI editor `/templates/:id/edit` už existuje pro create/update; přidáme rich-text editor (textarea s preview placeholderů) a `/templates/:id/preview` který vrátí rendered body s ukázkovými vars.

**Tasks:**

- AH.1 Migration 061 — INSERT 5 řádků s body z .tmpl souborů.
- AH.2 Test `TestEmailTemplates_AllSeededFromMigration` — verifikuje že DB má všech 5.
- AH.3 Refaktor `template.go Render()` — odebrat file fallback, error když DB row chybí.
- AH.4 Audit ratchet refaktor — čte DB body, ne file.
- AH.5 Smazat `features/outreach/campaigns/configs/templates/` adresář.
- AH.6 UI: textarea editor v `/templates/:id` + preview button.
- AH.7 Test že editace přes UI invaliduje cache + nová render používá novou hodnotu.

**Definice hotovo:** `configs/templates/` neexistuje, všech 5 templates v DB, editor funguje, audit ratchet zelený.

## Sprint AI — LIA NACE scope unify (PRIORITA 3)

**Co je špatně:** `features/outreach/campaigns/sender/lia_scope.go:13–22` má 8 NACE kódů jako Go slice. `features/platform/outreach-dashboard/src/lib/campaign-send-batch.js:122` má identický seznam jako JS array, s komentářem "Mirrors features/outreach/campaigns/sender/lia_scope.go". Když legal udělá review a změní scope, musíš upravit obě a doufat že nikdo nezapomněl.

**Co uděláme:** vytvořit `configs/legal/lia-nace-scope.json` (single source v repu) — Go i JS to čte při startu. Nebo lépe: do `operator_settings` tabulky přidat klíč `lia_nace_scope` s JSON arrayem. Při legal change UPDATE řádku, oba runtimy vidí novou hodnotu.

**Tasks:**

- AI.1 Rozhodnout: JSON config soubor v repu, nebo `operator_settings` row.
- AI.2 Pokud JSON: `configs/legal/lia-nace-scope.json` + Go loader + JS loader.
- AI.3 Pokud DB: rozšířit Sprint AF tabulku o tento klíč.
- AI.4 Smazat duplicitní seznamy v `lia_scope.go` a `campaign-send-batch.js`.
- AI.5 Test `TestLIA_GoJSParity` — oba runtime vidí stejný set.

**Definice hotovo:** legal review přidá NACE 33 (oprava strojů) → 1 změna na 1 místě → oba runtimy vědí.

## Sprint AJ — ICP targeting do admin UI (PRIORITA 3)

**Co je špatně:** `features/acquisition/contacts/classify/icp.go:21–33` má 22 sektorů a `features/acquisition/contacts/classify/nace_map.go:78–90` má 11 anti-targets jako Go const. Operátor nemůže experimentovat se sector mixem bez code change.

**Co uděláme:** nová tabulka `icp_sectors (id, code, name, kind, weight, active)` — kind ∈ {target, anti-target}. Migrace seeduje aktuální hodnoty. UI stránka `/settings/icp` umožní operátorovi přidávat/deaktivovat sektory + měnit weight. Klasifikátor čte z DB při startu (cache 5min).

**Tasks:**

- AJ.1 Migration 062 — `icp_sectors` table + seed.
- AJ.2 Go classifier loader z DB s cache.
- AJ.3 Audit log na každou změnu (kdo, kdy, jaký sektor).
- AJ.4 React stránka `/settings/icp` s tabulkou + add/edit/deactivate.
- AJ.5 Smazat hardcoded slices v `icp.go` a `nace_map.go`.

**Definice hotovo:** operátor přidá novou cílovou kategorii v UI → další scoring tick zahrnuje nový sektor.

## Sprint AK — Legal docs do DB s verzováním (PRIORITA 4)

**Co je špatně:** `docs/legal/privacy-notice.md`, `docs/legal/lia-direct-marketing.md`, `docs/legal/art30-register.md` žijí jako markdown v repu. Změna = git PR. BFF route `/privacy` čte markdown ze souboru a renderuje. Když legal vydá novou verzi, přepiše se historie.

**Co uděláme:** tabulka `legal_documents (id, slug, version, content_md, published_at, supersedes_id, active)`. Migrace importuje aktuální obsah. BFF `/privacy` čte aktivní verzi z DB. Admin UI `/settings/legal` umožní operátorovi vystavit novou verzi (stará zůstane jako audit trail).

**Tasks:**

- AK.1 Migration 063 — `legal_documents` table + seed importem z `docs/legal/*.md`.
- AK.2 BFF `privacy.js` čte z DB, ne ze souboru.
- AK.3 Admin UI `/settings/legal` s editorem + version history.
- AK.4 Volitelně: smazat `docs/legal/*.md` (DB je SSoT) — nebo nechat jako mirror.

**Definice hotovo:** `/privacy` route ukazuje verzi z DB; operátor publikuje opravu bez PR.

## Sprint AL — Brand bleed cleanup (PRIORITA 5, pro white-label)

**Co je špatně:** `features/platform/outreach-dashboard/src/pages/Replies.jsx` má UI labely "Předat do Garaaage" a endpoint `/api/replies/:id/forward-to-garaaage`. Když systém pojede pro jinou firmu (Balkan Motors, white-label), tyto labely jsou matoucí.

**Co uděláme:** rename UI labelu na `Předat do CRM` (generic) nebo přečíst hodnotu z `operator_settings.brand_label`. Endpoint URL: zachovat `/forward-to-garaaage` jako alias (backward compat) + přidat `/forward-to-crm` jako primární. Po 2 měsících alias smazat.

**Tasks:**

- AL.1 Operátor rozhodne: generic "CRM"/"handoff", nebo konfigurovatelný label?
- AL.2 Replies.jsx — labely čtou z operatorconfig nebo i18n catalog.
- AL.3 Endpoint alias.
- AL.4 BFF `/privacy` + `/unsubscribe` HTML titles čtou z operatorconfig.
- AL.5 MCP auth page (`features/platform/mcp/mcp-server/auth.ts`) — title z env var nebo config.

**Definice hotovo:** systém lze nasadit pod jinou značkou bez touch repo.

## Pořadí + odhad

| Sprint | Priorita | Effort | Závislost |
|---|---|---|---|
| AF entity/persona/telefon do operator_settings | P1 | 2-3 dny | žádná — startuje první |
| AG default sequence drift fix | P1 (BUG) | 1 den | žádná — paralelně s AF |
| AH .tmpl → DB migrace | P2 | 2-3 dny | AF (template engine refaktor sahá do operatorconfig) |
| AI LIA NACE unify | P3 | 1 den | nezávislé |
| AJ ICP do admin UI | P3 | 2 dny | nezávislé |
| AK legal docs do DB | P4 | 2 dny | nezávislé |
| AL brand bleed cleanup | P5 | 1-2 dny | AF (čte brand_label z config) |

Total odhad: ~10–15 dní práce, ale dá se paralelně po sprintech AF/AG/AI/AJ/AK (různé soubory). AH a AL čekají na AF.

## Nepříjemné otázky pro operátora

Před spuštěním Sprintu AF potřebuju vyjasnit:

- **Persona model:** je `sender_signature` per-globální (1 hodnota platí pro všechny mailboxy), nebo per-mailbox (každá schránka má svůj podpis)? Dnešní stav je per-globální (`SENDER_SIGNATURE` env). Návrh: per-mailbox (rozšíření `outreach_mailboxes`) s globálním fallbackem v `operator_settings`. Souhlasíš?
- **Telefon model:** stejně — globální nebo per-mailbox? Návrh: per-mailbox `outreach_mailboxes.sender_phone` (už existuje od migrace 057).
- **Privacy contact email:** dnes `privacy@garaaage.cz`. Pro Balkan Motors? Operátor musí dodat; nebo necháme garaaage.cz jako kontakt + Privacy Notice v textu uvádí, že kontroller je BALKAN MOTORS.
- **Default sequence delays (Sprint AG):** 5/12 dní (UI stávající chování) nebo 7/14 dní (Go fallback). Mám pocit že 5/12 — operátor potvrdí.

## Co spustit první

Doporučuji **AF + AG paralelně** — AF je nejvyšší ROI (změna firmy = 1 SQL místo 16 souborů), AG opravuje real bug. Po jejich dokončení (3-4 dny) start AH.

