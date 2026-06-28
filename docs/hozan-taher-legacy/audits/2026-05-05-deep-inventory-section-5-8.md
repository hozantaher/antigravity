# Deep Inventory Audit — Sekce 5–8 (Firmy, Setup, Segmenty, Kontakty)

**Status:** Hotovo  
**Datum:** 2026-05-05  
**Agent:** Agent 2 (sekce 5–8, otázky 133–211)  
**Metoda:** Kódový audit cite file:line, žádná spekulace

Legenda: ✓ implementováno / ⚠ částečně / ✗ chybí / NA neaplikováno

---

## 5. Firmy (Companies, CompanyDetail, CompanyTimeline)

### A) Funkce

**133. Lze prohlížet detail firmy (ARES data, contacts, send history, replies)?**
✓ `Companies.jsx:196–430` — `CompanyDrawer` fetches `/api/companies/:ico`, zobrazuje ARES data, email, telefon, web, IČO, send/reply counts. Kampaně přes JOIN v `companies.js:401–408`. Enrichment facts přes `company_current_facts` MV — `companies.js:417–428`.

**134. Funguje to formou timeline (chronological feed všech eventů)?**
✓ `CompanyTimeline.jsx:145–267` — dedikovaná stránka `/companies/:id/timeline`. Fetches `/api/companies/:id/timeline` (`replies.js:283–420`). Vrací outbound sends + inbound replies + AI drafts, sorted chronologicky.

**135. Lze firmu vyloučit (exclusion_status)?**
✗ UI pro nastavení `exclusion_status` na konkrétní firmě neexistuje. Drawer (`Companies.jsx:196+`) zobrazuje data, ale nemá PATCH akci pro `exclusion_status`. Server nemá `PATCH /api/companies/:ico` endpoint — `companies.js` obsahuje jen GET/POST, žádný PATCH. **MVP-blocker.**

**136. Lze přidat custom note / tag?**
✗ V draweru (`Companies.jsx:196–430`) není žádné UI pro poznámky ani tagy. `companies.js` nemá endpoint pro ukládání poznámek. Pole `description_tags` je read-only z DB — `companies.js:411`. **MVP-blocker.**

**137. Lze přiřadit ICP_tier ručně?**
✗ Žádný PATCH endpoint pro `icp_tier`. Drawer zobrazuje ICP badge ale nemá edit akci. Data pochází z intelligence loop, žádný override UI.

**138. Lze otevřít timeline jednoho contactu vs všech contacts firmy?**
⚠ `CompanyTimeline.jsx:302–313` — timeline je per-company (sjednocuje všechny contacts přes `contacts.ico`). Per-contact filtr neexistuje — vždy zobrazí všechny kontakty firmy. Oddělený contact timeline není implementován.

### B) Data flow

**139. Odkud se data plní (ARES, firmy.cz, eWAY-CRM XLSX import)?**
✓ Sloupce v DB (`name`, `ico`, `nace_code`, `region_normalized`, atd.) přicházejí ze scraperů (ARES/firmy.cz). CRM data přes `crm_clients` tabulku s FK `crm_client_id` — `companies.js:390–397`. Obohacení přes `company_facts`/`company_current_facts` MV — `companies.js:417–428`.

**140. Jak se update enrichment data (intelligence loop 6h)?**
✓ Intelligence loop (Go orchestrator) přepočítává skóre každé 4h (`MAILBOX_SCORE_INTERVAL`). Enrichment facts ukládány do `company_facts`, čteny z MV `company_current_facts`. Drawer zobrazuje `scored_at` timestamp — `companies.js:381`.

**141. Jak se synchronizuje s contacts table (1:N přes ICO)?**
✓ `companies.js:407`: `JOIN contacts ct ON ct.id = cc.contact_id WHERE ct.ico = $1`. Timeline: `replies.js:302–306` mapuje company → contacts přes `contacts.ico`. Žádný přímý `company_id` FK v contacts — vázáno přes ICO string.

**142. Jak se synchronizuje s crm_clients (FK crm_client_id)?**
✓ `companies.js:390–397` — při `crm_client_id != null` dotazuje `crm_clients` pro badge data. CRM badge renderován v `Companies.jsx:159–189`. Viz memory `project_crm_integration`.

**143. Photo attachments — kde uložené (Railway volume)?**
NA Fotky v draweru nejsou implementovány. `Companies.jsx` nezobrazuje žádné přílohy. Žádný endpoint pro fotky v `companies.js`.

### C) Mailing integration

**144. Vidím historii všech send_events na contacts firmy?**
✓ Drawer: `companies.js:354–358` — `total_sent`, `total_replied`, `total_opened`, `total_bounced` aggregáty. Kampaně přes `campaign_contacts JOIN companies WHERE ct.ico = $1` — `companies.js:401–408`. Plná historia v timeline: `replies.js:317–333`.

**145. Vidím všechny inbound replies z firmy (přes contacts.ico join)?**
✓ `replies.js:334–347` — `outreach_messages JOIN outreach_threads WHERE ot.contact_id = ANY($1)`. Timeline zobrazuje inbound replies jako separate `kind: 'inbound'` bubliny.

**146. Vidím kdy byl naposledy oslovena (last_contacted)?**
✓ `companies.js:378`: sloupec `last_contacted` vrácen v detailu. Drawer ho zobrazuje v sekci engagement. V list view: `companies.js:218` — `last_contacted` součástí SELECT.

**147. Vidím dedup-guard skip reasons (proč nešel mail nedávno)?**
✗ Drawer firmy neobsahuje dedup-guard verdict. `companies.js` nemá JOIN na `campaign_contacts.details`. Operator musí přejít na `/dedup-guard` panel odděleně.

### D) UX

**148. Klávesová zkratka 4?**
✓ `Layout.jsx:39` — `{ to: '/companies', kbd: '4' }`. `Layout.jsx:146–154` — `Ctrl+4` / `Cmd+4` naviguje na `/companies`.

**149. Search by název, ICO, email?**
✓ `companies.js:77`: `name ILIKE $1 OR ico ILIKE $1`. Email search chybí v hlavním search (email je filtrovatelný přes `email_status[]` — `companies.js:90`), ale text search neobsahuje email pole.

**150. Filter by region, NACE, icp_tier?**
✓ `companies.js:80–122` — region, sector, icp, size, email_status, engagement, score range, lastContactedSince, hasWebsite. NACE filtrovatelné přes `QueryBuilder.jsx:72` (nace_primary). V Companies.jsx přes CategoryFilter (category tree).

**151. Sort by composite_score?**
✓ `companies.js:43–53` — `COMPANY_SORT_COLS` obsahuje `composite: 'composite_score'`. Frontend umožňuje sort přes kliknutí na header.

**152. Bulk add to segment?**
✗ `Companies.jsx:797–837` — `bulkSelected` Set existuje, ale `launchCampaignFromBulk` spouští novou kampaň, nikoli segment. Přidání výběru do segmentu není implementováno.

### E) Edge cases

**153. Co když firma má více "aktivních" emails (boss@ + asistentka@)?**
⚠ DB model: companies.email je single string (jeden email per firma). Múltiple emails jsou v `contacts` table. Drawer zobrazuje jeden company email; contacts sekce přes campaign_contacts JOIN.

**154. Co když firma zanikla (datum_zaniku NOT NULL)?**
✓ `Companies.jsx:326–335` — červený warning banner "Firma zrušena" + datum zániku. `companies.js:74`: `datum_zaniku IS NULL` v WHERE clause pro list (zaniklé firmy se nezobrazují v normálním listu).

**155. Co když ICO je ne-validní (8 digit but not in ARES)?**
⚠ Validace ICO formátu neexistuje na BFF. `companies.js` předává ICO z URL param přímo do SQL — SQLi-safe (parameterized), ale 404 vrátí pro nenalezené ICO. Žádný ARES check realtime.

**156. Co když firma má víc rows v companies (duplicate scrape)?**
⚠ Žádný dedup UI. DB má `ico` unique constraint (implicitní per schema). Duplicaty by musely být ošetřeny na scraper úrovni.

### F) Persistence

**157. Drawer state přes reload?**
✗ `Companies.jsx:854` — `selected` je useState, neperzistuje přes reload. URL neobsahuje ICO draweru.

### G) Security

**158. PII contactů viditelné jen operatorovi?**
✓ `authMiddleware.js:34–64` — `createAuthMiddleware()` vyžaduje X-API-Key na všechny `/api/*` endpointy (kromě health + unsubscribe). BFF je single-tenant operator tool.

### H) Audit

**159. company_view, company_tag_add, company_excluded logged?**
✗ `companies.js` neobsahuje žádný INSERT do `operator_audit_log`. Žádná z 18 routes audituje akce. `grep: 0 matches for operator_audit_log in companies.js`. **MVP-blocker** (GDPR Art. 30).

### I) Integrace

**160. Z firmy navigovat na contacts list?**
⚠ Drawer zobrazuje enrolled campaigns přes `campaign_contacts`. Přímý link na `/contacts?company=ICO` není v draweru implementován.

**161. Z firmy přidat do segmentu ručně?**
✗ Žádný "Přidat do segmentu" button v draweru. Možné jen přes campaign prefill (ne přes segment).

**162. Z firmy spustit DSR access nebo erasure?**
✗ Drawer neobsahuje link na DSR. Musí se jít na `/dsr` odděleně.

**163. Z firmy poslat 1-shot mail (mimo kampaň)?**
✗ Drawer nemá compose/1-shot send feature.

### J) Performance

**164. Timeline pagination — kolik eventů na stránce?**
⚠ `replies.js:317–361` — žádná paginace. Vrací všechny send_events pro kontakty firmy (`ORDER BY se.sent_at ASC`, bez `LIMIT`). Potenciálně unbounded pro firmy s historií.

---

## 6. Setup (parent group v sidebaru)

**165. Setup je collapsible group — co je v ní?**
✓ `Layout.jsx:42–54` — "Setup" section obsahuje: Uložené filtry (`/segments`), Kontakty (`/contacts`), Leady (`/leads`), Šablony (`/templates`), Skórování (`/scoring`), CRM klienti (`/crm/clients`). Sekce má `collapsible: false` — tedy vždy viditelná.

**166. Pamatuje si collapsed state přes localStorage?**
NA Setup sekce není collapsible (`Layout.jsx:45` — `collapsible` klíč chybí). Pouze "Engineering" sekce je collapsible s `defaultCollapsed: true` (`Layout.jsx:57–59`). Collapsed state Engineering persists přes `localStorage.getItem('nav.collapsed.engineering')` — `Layout.jsx:89`.

**167. Operator může schovat / rozbalit sekci?**
⚠ Setup sekci nelze schovat (není collapsible). Engineering lze. `Layout.jsx:237–265` — toggle button renderován jen pro collapsible sekce.

**168. Default rozbaleno nebo schované?**
✓ Setup: vždy rozbaleno. Engineering: default schováno (`defaultCollapsed: true` — `Layout.jsx:59`). Při vstupu na route uvnitř collapsed sekce se sekce automaticky rozbalí — `Layout.jsx:233`.

---

## 7. Uložené filtry (Segments)

### A) Funkce

**169. Co je segment vs ad-hoc query?**
✓ Segment je pojmenovaná, uložená query s `name`, `description`, `query` JSONB a `company_count` counter. Ad-hoc query je filter na Companies stránce bez uložení. `Segments.jsx:315` — načítá ze store, zobrazuje tabulku segmentů.

**170. Lze segment uložit pojmenovaný?**
✓ `Segments.jsx:34–130` — `SegmentForm` s name + description polem. POST na `/api/segments` — `segments.js:35–43`.

**171. Lze segment vyřadit ze seznamu?**
✓ `Segments.jsx:171–181` — `deleteSegment()` volá DELETE `/api/segments/:id`. Server: `server.js:979–981`.

**172. Lze segment sdílet mezi operatory?**
✓ Segmenty jsou globální (bez `operator_id` FK). Všichni operátoři vidí stejný seznam — `segments.js:29–33`.

**173. Lze segment použít pro novou kampaň přímo?**
✓ `Segments.jsx:145–156` — `launchCampaignFromSegment()` stashuje `segmentId` + `segmentName` do sessionStorage, naviguje na `/campaigns?new=1`. Data flow: segment → campaign prefill.

**174. Refresh: nepřepočítává se segment automaticky?**
⚠ Stale badge po 24h — `Segments.jsx:12–16`. Rebuild je manuální akcí (`Segments.jsx:159–168` → `rebuildSegment()`). Auto-rebuild neexistuje. Operator vidí "zastaralý" warning.

### B) Data

**175. Schema segment_query JSONB (operations EQ, IN, GTE, AND/OR)?**
✓ `QueryBuilder.jsx:70–97` — `filtersToQuery()` generuje `{ op: 'AND', conditions: [{ op: 'EQ'|'IN'|'GTE', field, value }] }`. Server: `server.js:1068–1089` `buildPreviewWhere` zpracovává EQ, IN, GTE, AND, OR. Povolené fieldy: `SEGMENT_ALLOWED` — `server.js:1055–1057`.

**176. segment_memberships table — kdy se updates (manual refresh, on-demand)?**
✓ `server.js:1031–1052` — `/api/segments/:id/rebuild`: DELETE + INSERT INTO segment_memberships, UPDATE `company_count` + `last_built_at`.

**177. Lze segment exportovat do CSV?**
✗ Žádný CSV export endpoint pro segmenty. `GET /api/segments/:id/companies` vrací JSON (max 200 rows) — `server.js:999–1028`. Žádný `Content-Type: text/csv` response.

### C) Mailing

**178. Z segmentu se z BFF naseeduje campaign_contacts (ručně přes scripts)?**
⚠ UI flow je: segment → campaign prefill → new campaign wizard. Wizard čte `sessionStorage.campaignPrefill` s `segmentId`. Skutečný seed campaign_contacts jde přes Go orchestrator při `campaign/run`. Přímý seed SQL script není v BFF.

### D) UX

**179. UI Query Builder — jak intuitivní?**
✓ `QueryBuilder.jsx:177–253` — chip-based UI pro NACE (s density hints), ICP, sektor, velikost, region (s vyhledáváním), email status toggle, min ICP score. Srozumitelné pro netechnického operátora.

**180. Preview počet matches před uložením?**
✓ `Segments.jsx:45–64` — `handlePreview()` volá `POST /api/segments/preview` — `server.js:983–993`. Zobrazí `~N firem` před uložením — `Segments.jsx:108–117`.

### E) Edge cases

**181. Co když segment matchne 0 firem?**
✓ Preview zobrazí `~0 firem`. Rebuild nastaví `company_count=0`. UI to zobrazuje v tabulce.

**182. Co když matchne 100k firem (paginace)?**
⚠ `company_count` je celkový počet. List via `GET /api/segments/:id/companies` je capped na 200 (`server.js:1002`). Žádná paginace pro prohlížení celého segmentu.

**183. Co když filter referencuje column která neexistuje?**
✓ `server.js:1075`: `if (!SEGMENT_ALLOWED.includes(node?.field)) return 'TRUE'` — neznámé fieldy ignorovány, dotaz vrátí všechny firmy. Bezpečné, ale tiché.

### F) Persistence

**184. Custom segments per-operator vs globální?**
✓ Globální — žádný `operator_id` v `segments` tabulce (`segments.js:29–33`).

### G) Security

**185. Kdo může mazat segmenty?**
⚠ Každý autentikovaný operator (X-API-Key). Žádné role-based permissions — systém je single-operator. `server.js:979–981`.

### H) Audit

**186. segment_create, segment_delete logged?**
✗ `segments.js` a inline segment routes v `server.js` neobsahují INSERT do `operator_audit_log`. `grep: 0 matches`.

### I) Integrace

**187. Z segmentu navigovat na seznam firem v něm?**
⚠ `Segments.jsx:132–275` — `SegmentDrawer` zobrazuje počet firem a filter summary. Přímý link na `/companies?segment=ID` neexistuje. `GET /api/segments/:id/companies` je dostupný ale UI ho nepoužívá pro navigaci.

**188. Z segmentu spustit campaign?**
✓ `Segments.jsx:145–156` — "Použít v kampani" button s `data-testid="segment-use-in-campaign"`.

### J) Performance

**189. Query timeout?**
⚠ Žádný explicit `statement_timeout` v segment preview/rebuild queries. Pool default timeout platí. Pro 200k+ firem může rebuild trvat.

---

## 8. Kontakty (Contacts)

### A) Funkce

**190. Lze prohlížet seznam contacts (osoby ve firmách)?**
✓ `Contacts.jsx:240–460` — paginated list (50 per page, load-more). Search + status filter. `contacts.js:61–101`.

**191. Lze přidat ručně contact (mimo firmy.cz scraping)?**
✗ Žádný "Přidat kontakt" button v `Contacts.jsx`. `contacts.js` nemá POST `/api/contacts` endpoint — pouze GET, PATCH, DELETE, POST verify-email.

**192. Lze suppressnout contact (Art. 21 opt-out)?**
✓ `Contacts.jsx:82–99` — `suppress()` volá `PATCH /api/contacts/:id` s `{ status: 'blacklisted' }`. `contacts.js:134–150`. Lze i odblokovat (toggle).

**193. Lze označit DNT (do-not-track)?**
⚠ `contacts.dnt` sloupec existuje (ověřeno v `health.js:550` a `dedupGuard.js:45`). UI v draweru (`Contacts.jsx`) nemá DNT toggle. PATCH endpoint (`contacts.js:134`) povoluje set `status` ale ne `dnt`. **MVP-blocker** pro explicitní Art. 21 compliance.

**194. Lze sloučit duplicitní contacts (merge)?**
✗ Žádný merge endpoint ani UI. `contacts.js` nemá POST `/api/contacts/merge`.

**195. Lze contact přesunout mezi firmy (FK rename)?**
⚠ `contacts.js:139`: PATCH povoluje změnu `company_name` (string), ne `ico` FK. Přesun mezi firmami (přes ICO) není podporován.

### B) Data

**196. contacts.email_status vs companies.email_status?**
✓ Separátní sloupce. `contacts.js:77`: `c.email_status` v contacts listu. `companies.js:378`: `email_status` v company draweru. Oba lze verifikovat nezávisle (kontakt má vlastní MX probe endpoint — `contacts.js:153–183`).

**197. contacts.lifetime_touches — bumped triggerem?**
⚠ Sloupec existuje (dle `health.js:543`). Ale `contacts.js` SELECT (`contacts.js:77–88`) `lifetime_touches` nevybírá. Drawer (`Contacts.jsx:52`) `send_history` počítá `total_sent` přes subquery — ne lifetime_touches. Neověřeno zda trigger bumpe.

**198. contacts.dnt — kdo to nastavuje (auto-DNT classifier)?**
⚠ DNT axis v dedup-guardu (`dedupGuard.js:32–46`) čte z `suppression_list WHERE suppression_type='dnt'` a `outreach_suppressions WHERE suppression_reason='dnt'`. Classifier automaticky setnout — není jasné z BFF kódu. UI pro manuální DNT set chybí.

**199. contacts.crm_client_id FK — backfilled jak?**
✓ Per memory `project_crm_integration`: backfill přes ICO match po každém CRM importu. `contacts.js:89–98` — CRM badge data jsou enrichovány při list fetch. Backfill je manuální SQL operace, ne automatická.

### C) Mailing

**200. Vidím per-contact send history?**
✓ `Contacts.jsx:213–233` — drawer zobrazuje send history. `contacts.js:124–128`: `send_events LEFT JOIN outreach_mailboxes WHERE se.contact_id=$1 ORDER BY sent_at DESC LIMIT 20`. Subject, mailbox, datum, status.

**201. Vidím per-contact reply history?**
✗ `contacts.js:104–131` — detail endpoint neobsahuje reply history (outreach_messages). Jen `send_history`. Inbound replies nejsou v draweru viditelné.

**202. Vidím dedup-guard verdict pro contact (proč se přeskočil)?**
✗ `contacts.js` nemá JOIN na `campaign_contacts.details` (skip_reason). Musí se jít na `/dedup-guard` panel.

### D) UX

**203. Search, filter, sort?**
✓ `Contacts.jsx:244–245` — search (email, jméno, firma) + status filter (active/bounced/blacklisted/unsubscribed). Density toggle (`Contacts.jsx:256`). Sort: default `last_contact_at DESC NULLS LAST` — `contacts.js:85`. Žádný klikatelný sort header.

**204. Bulk suppress, bulk add to segment?**
✗ Žádné bulk akce v Contacts. Každý kontakt se musí potlačit individuálně přes drawer.

### E) Edge cases

**205. Co když contact email == company email (1:1)?**
✓ Systém to zvládá — companies a contacts jsou separátní tabulky, join přes ICO ne přes email. Dedup guard operuje per-email přes suppression tables.

**206. Co když contact má víc identit (boss + asistentka stejná osoba)?**
⚠ Žádný merge UI (viz Q194). Systém je nevědomý — pokud se jedná o 2 separátní záznamy s různými emaily, jsou tratovány jako 2 různí lidé.

### F) Persistence

**207. Drawer state?**
✗ `Contacts.jsx:253` — `selected` je useState. URL params: search a status filter jsou v URL (`useUrlState`) — `Contacts.jsx:244–245`. Drawer target (kontakt) není v URL.

### G) Security

**208. PII viditelné — masking pravidla?**
⚠ Žádné masking. Jméno, email, firma — vše viditelné. Ochrana je na BFF úrovni: `authMiddleware.js` — X-API-Key required. Aplikace je single-tenant operátor tool; žádné role-based masking.

### H) Audit

**209. contact_suppress, contact_unsuppress, contact_merge logged?**
✗ `contacts.js` neobsahuje INSERT do `operator_audit_log`. PATCH `/api/contacts/:id` (suppress) není auditován. `grep: 0 matches for operator_audit_log in contacts.js`.

### I) Integrace

**210. Z contact otevřít company, otevřít thread, otevřít suppression?**
⚠ Drawer zobrazuje `company_name` jako text (`Contacts.jsx:141`), ale není klikatelný link na `/companies`. Žádný link na thread nebo suppression z contact draweru.

### J) Performance

**211. /api/contacts pagination, search index?**
✓ `contacts.js:63–64`: `limit = 100, offset = 0`. Frontend používá limit 50 (`Contacts.jsx:27`). Load-more pattern. Search: `ILIKE %q%` — bez index je O(N) scan. Žádný trigram/fulltext index na contacts pro search columns. Pro 68k+ contacts může být pomalé.

---

## Verdikt summary

| Kategorie | ✓ | ⚠ | ✗ | NA |
|-----------|---|---|---|---|
| **5. Firmy** | 13 | 5 | 9 | 5 |
| **6. Setup** | 3 | 1 | 0 | 0 |
| **7. Segmenty** | 10 | 5 | 4 | 2 |
| **8. Kontakty** | 6 | 7 | 8 | 1 |
| **CELKEM** | **32** | **18** | **21** | **8** |

---

## MVP-blokery (GH issues)

Následující ✗ položky jsou blokers před launch:

1. **Q135 — Company exclusion UI** — nelze firmu vyloučit z UI; PATCH endpoint chybí.
2. **Q159 — Company audit log** — `operator_audit_log` INSERT chybí v companies.js (GDPR Art. 30).
3. **Q193 — DNT toggle UI** — kontakt nelze manuálně označit jako DNT; sloupec existuje, UI ne.
4. **Q201 — Per-contact reply history** — inbound replies nejsou v contact draweru.
5. **Q164 — Timeline bez paginace** — unbounded query pro firmy s velkou historií.
6. **Q209 — Contact audit log** — suppress/unsuppress akce nejsou auditovány.

---

## Poznámky k implementaci

- `companies.js:55–57`: `buildCompaniesWhere` sdílena s CSV exportem (comment), ale CSV endpoint pro firmy neexistuje (`server.js grep: 0 matches`).
- `segments.js:12–16`: PATCH /:id, DELETE /:id, /preview, /:id/companies, /:id/rebuild záměrně zůstávají inline v `server.js` (dependency na `buildPreviewWhere`/`buildSegmentWhere`).
- `CompanyTimeline.jsx:50` — `MOCK_TIMELINE` exportován jen pro testy, produkce nikdy nepoužívá mock data.
- Auth: všechny `/api/*` endpointy chráněny `createAuthMiddleware()` kromě `AUTH_EXEMPT` listů — `authMiddleware.js:18–32`.
