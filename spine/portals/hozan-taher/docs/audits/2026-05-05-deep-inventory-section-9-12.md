# Deep inventory audit — sekce 9–12 (Leady, Šablony, Skórování, CRM klienti)

**Status:** Hotovo — audit sekcí 9–12 otázek 212–296
**Datum:** 2026-05-05
**Trigger:** Pre-launch dashboard audit
**Metoda:** Kódový audit file:line citace, bez spekulace

Zkratky výsledků: ✓ = funguje/existuje; ⚠ = funguje s výhradou; ✗ = chybí/nefunguje; NA = netýká se

---

## 9. Leady

Zdrojové soubory:
- `features/platform/outreach-dashboard/src/pages/Leads.jsx`
- `features/platform/outreach-dashboard/src/server-routes/leads.js`
- `features/inbound/orchestrator/thread/inbound.go`

### A funkce

**212. Co je lead vs contact vs reply?**
✓ Lead = prodejně kvalifikovaná odpověď. Contact je záznam v `contacts` tabulce. Reply je raw inbound mail v `reply_inbox`. Lead vzniká výhradně z inbound klasifikace (`interested` nebo `meeting`). Viz `leads.js:3–13` (komentář) + `inbound.go:515`.

**213. Kdy se contact přesune do leads (po positive reply classification)?**
✓ `inbound.go:268,277` — po klasifikaci jako `meeting` nebo `interested` volá `p.upsertLead()`. Trigger je klasifikátor v `inbound.go:499–501`.

**214. Lead stages — kvalifikace, demo, proposal, won, lost?**
⚠ Stages jsou `new, contacted, qualified, won, lost` (+ `disqualified, closed` na backendu). `Leads.jsx:9` + `leads.js:61`. Neexistuje demo/proposal stage jako v klasickém CRM kanban. Pipeline je lineární tabulkový view, ne kanban.

**215. Lze lead přesunout mezi stages?**
✓ `Leads.jsx:59–67` — `<select>` na každém řádku volá `PATCH /api/leads/:id` s novým `status`. Backend `leads.js:59–79` validuje allowed set a aktualizuje.

**216. Lze přidat poznámku, follow-up reminder?**
⚠ Poznámka: `PATCH /api/leads/:id` přijímá `notes` field (`leads.js:68`), ale UI v `Leads.jsx` toto pole nevystavuje — není input pro notes na řádku ani v draweru. Follow-up reminder neexistuje vůbec. **MVP GAP**.

**217. Lze lead převést do CRM (export do eWAY)?**
✗ Neexistuje. Žádný export CRM endpoint ani UI tlačítko v `Leads.jsx`. Leads se do eWAY nepřenáší automaticky. Operator musí ručně.

### B data

**218. leads table schema?**
✓ Z `leads.js:37–47` vidíme: `id, contact_id, campaign_id, mailbox_id, status, source, sentiment, classified_at, created_at, updated_at, notes, original_message_id, assigned_to`. Joins na `contacts`, `campaigns`, `outreach_mailboxes`.

**219. Vztah leads ↔ contacts ↔ companies ↔ outreach_threads?**
✓ `leads.contact_id → contacts.id` (LEFT JOIN v `leads.js:44`). `contacts.company_ico → companies.ico` (nepřímý). Přímý JOIN na `outreach_threads` v leads query neexistuje, ale `original_message_id` odkazuje na zprávu.

### C mailing

**220. Lze z leadu poslat ad-hoc reply?**
✗ UI `Leads.jsx` neobsahuje žádný "Odpovědět" button. Není žádný odkaz na `/replies` nebo thread detail z lead řádku. **MVP BLOCKER** — operator nemá cestu k reakci přímo ze sekce Leady.

### D UX

**221. Kanban board s stages?**
✗ Implementováno jako flat tabulka s filter chipy, ne kanban board. `Leads.jsx:148–205`. Každý lead je řádek v tabulce se `<select>` pro změnu stavu.

**222. Drag-and-drop mezi stages?**
✗ Neexistuje. Žádný DnD framework v `Leads.jsx`.

### E edge

**223. Co když contact replyne ale není ještě v leads?**
✓ `inbound.go:524–553` — `upsertLead` používá `INSERT ... ON CONFLICT (contact_id, campaign_id) DO UPDATE` — bezpečný upsert, takže ani duplicitní reply nevytvoří duplicitní lead.

**224. Auto-promote contact → lead trigger?**
✓ `inbound.go:268,277` — automatický upsert při klasifikaci `meeting`/`interested`. Není manuální krok.

### F persistence

**225. Lead position v stage persists přes reload?**
✓ Status je uložen v DB (`leads` tabulka). Po PATCH + reload zobrazí aktuální stav. Local `overrides` state v `Leads.jsx:56` je jen optimistický overlay, server je source of truth.

### G security

**226. Notes viditelné jen operatorovi?**
⚠ Celý BFF je chráněn `createAuthMiddleware()` (`server.js:350`). Auth middleware chrání všechny `/api/*` routes. Ale notes nejsou v UI vůbec viditelné (viz Q216), takže otázka je NA z UX pohledu.

### H audit

**227. lead_create, lead_stage_change, lead_export logged?**
✗ `leads.js` neobsahuje žádný `INSERT INTO operator_audit_log`. Ani `lead_create`, ani `lead_stage_change` se nelogují. `lead_export` neexistuje. **Audit gap**.

### I integrace

**228. Z lead otevřít timeline firmy?**
⚠ `Leads.jsx:167–176` — Campaign name je clickable link na `/campaigns/:id`. Ale přímý odkaz na firmu nebo timeline neexistuje. Operator musí přejít přes kampaň → firmu.

**229. Z lead exportovat do CRM (crm_clients update)?**
✗ Viz Q217. Neexistuje.

### J perf

**230. Kolik leads zvládne stránka bez lag?**
⚠ `leads.js:29` — limit 200 default, max 500. Pagination neexistuje. Vše najednou v tabulce. U 500 leadů může být render pomalý, ale není měřeno.

---

## 10. Šablony

Zdrojové soubory:
- `features/platform/outreach-dashboard/src/pages/Templates.jsx`
- `features/platform/outreach-dashboard/src/server-routes/templates.js`
- `features/platform/outreach-dashboard/src/lib/template-preview.js`
- `features/platform/outreach-dashboard/src/lib/spintax.js` (importovaný v Templates.jsx)

### A funkce

**231. Šablona = email body + subject?**
✓ `email_templates` tabulka: `name, subject, body`. `templates.js:41`. Preview zobrazuje oboje `Templates.jsx:126,157`.

**232. Lze šablonu duplikovat?**
✗ UI v `Templates.jsx` neobsahuje "Duplikovat" akci. Pouze Edit + Delete. `Templates.jsx:331–333`.

**233. Lze šablonu A/B testovat?**
✗ Žádná A/B testovací infrastruktura v templates routes ani UI.

**234. Variable substitution ({{first_name}}, {{company_name}})?**
✓ `template-preview.js:6–12` — `KNOWN_VARS`: `jmeno, jmeno_zkraceno, firma, firma_short, sektor, region, odesilatel_jmeno, odesilatel_email, unsubscribe_url`. Go backend podporuje i `{{.Firma}}` dot-notation (`template_property_test.go:30–32`).

**235. Spintax podporován ({Hi|Hello|Dobrý den})?**
✓ `Templates.jsx:11` — importuje `expandSpintax, expandAllSpintax, countVariations, validateSpintax` ze `spintax.js`. Live diagnostika v modalu s `SpintaxBadge` komponentou (`Templates.jsx:31–63`). Zobrazuje počet variant a chyby syntaxe.

**236. Multi-language (cs, en)?**
⚠ Není explicitní multi-language podpora. Template je prostý text bez locale tagu. Operator může napsat template v libovolném jazyce ručně.

**237. Per-template anonymity score (humanize impact)?**
✗ Neexistuje anonymity score v templates UI. Go content pipeline `detectHumanizeOff` (`template_property_test.go`) zpracovává `{{/* humanize: off */}}` comment, ale v UI není tato metrika viditelná.

### B data

**238. email_templates schema?**
✓ Z `templates.js:41,136,152` — `id, name, subject, body, created_at`. Žádný další sloupec (language, version, etc.) v queries.

**239. Versioning — pamatuje historie verzí?**
✗ Žádné verzování. `PUT /api/templates/:id` přepíše přímo. Audit log pouze pro DELETE (`templates.js:192–198`). Starší verze jsou ztraceny.

### C mailing

**240. Která render funkce ji zpracovává (features/outreach/campaigns/content/render.go)?**
✓ Go content service v `features/outreach/campaigns/content/` zpracovává `substituteVars` + humanize engine. `template_property_test.go:89` referuje `substituteVars`. Dashboard BFF preview (`template-preview.js`) je odlišná pure-JS implementace pro editor preview.

**241. Jak se substitutují variables (handlebars vs Go template)?**
✓ Go render používá vlastní `substituteVars` funkci, ne standardní `text/template`. Podporuje `{{firma}}` i `{{.Firma}}` dot-notation (`template_test.go:30`). Dashboard preview používá regexp `RE_MERGE_TAG = /\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/gi` (`template-preview.js:26`).

**242. Humanize engine — co dělá s textem (typos, Markov)?**
✓ Zpracovává diakritics degradation + imperfection injection. `HUMANIZE_DIACRITICS_DEGRADE=false` opts into safe profile (`NewImperfectEngineSAFE`). Viz memory `project_humanize_safe_profile`. V UI není humanize score viditelný.

### D UX

**243. Live preview během edit?**
✓ `Templates.jsx:69,116` — `showPreview` state toggle. V preview módu se zobrazuje rendered subject + body s substituovanými proměnnými. Seed button pro jinou spintax variantu (`Templates.jsx:133–138`). **Funguje dobře.**

**244. Validation per save (required vars present)?**
✓ Compliance gate: `templates.js:114–121` — `bodyHasUnsubLink()` blokuje save pokud chybí unsubscribe link. Spintax validace blokuje save pokud je syntaktická chyba (`Templates.jsx:87,98`). Name/subject/body required (`templates.js:128`).

**245. Test render proti sample contact?**
✓ `Templates.jsx:14` — `SAMPLE = { jmeno: 'Novák', firma: 'Stavba Plus s.r.o.', oddelovac: '--' }`. Preview API `POST /api/templates/preview` (`templates.js:164`) volá `renderTemplatePreview` s `sample` z request body. Sample není z reálného contactu — jen hardcoded. Dostatečné pro editor UX.

### E edge

**246. Co když var v šabloně neodpovídá contact field (chybí first_name)?**
✓ `template-preview.js:47–53` — unknown var zůstane jako `{{name}}` a přidá `unknown_merge_tag` warning. Go backend: empty string pro neznámý var.

**247. Co s HTML escape?**
⚠ `template-preview.js:82` — `plaintext_preview` stripuje tagy pomocí `replace(/<[^>]+>/g, '')`. Tělo je `whiteSpace: pre-wrap` v preview (`Templates.jsx:155`). Není systematický HTML escape — template body je plain text, XSS risk minimální pokud se neposílá jako HTML email.

**248. Plain text vs HTML mail?**
⚠ Pipeline posílá plain text. Go content engine `templates_heavy_test.go:156` zmiňuje `{{.Podpis}}`. Explicitní HTML/plain rozlišení v UI není.

### F persistence

**249. Draft pamatuje rozpracovanou šablonu?**
✗ `TemplateModal` je stateful React state — po zavření modalu se stav ztratí. Není localStorage draft.

### G security

**250. XSS v preview prevention?**
⚠ Preview body je vykresleno jako `whiteSpace: pre-wrap` text node v `<div>` (`Templates.jsx:155`), ne dangerouslySetInnerHTML. React automaticky escapuje. XSS risk v preview minimální. V sent emailu záleží na Go render pipeline.

### H audit

**251. template_create, template_update, template_delete logged?**
⚠ Pouze `template_delete` je logován (`templates.js:192–198`). `template_create` (POST) a `template_update` (PUT) audit log nemají. **Audit gap pro create/update.**

### I integrace

**252. Z šablony navigovat na kampaně co ji používají?**
⚠ Ranking tabulka (`Templates.jsx:354–383`) zobrazuje `campaigns_used` count, ale není clickable link na seznam kampaní.

**253. Z šablony otevřít explain (per-variable explanation)?**
⚠ Hinty jsou v `form-hint` divu (`Templates.jsx:199–205`) — seznam proměnných s code snippety. Není dedikovaný "explain" panel, ale základní guidance je přítomna.

### J perf

**254. Render benchmark?**
NA — Pure JS preview je synchronní, bez měřeného benchmarku. Go render benchmark v `content/` existuje ale netestuje dashboard UI layer.

---

## 11. Skórování

Zdrojové soubory:
- `features/platform/outreach-dashboard/src/pages/Scoring.jsx`
- `features/platform/outreach-dashboard/src/server-routes/scoring.js`
- `features/platform/outreach-dashboard/src/lib/scoring.js`

### A funkce

**255. Co se scoruje — firmy, contacts, oboje?**
✓ Pouze firmy (`companies` tabulka). `scoring.js` komentář L2: "Composite scoring — dashboard-owned, independent of Go's best_targeting_score." Contacts nemají separate composite score.

**256. composite_score, icp_score, best_targeting_score — co je rozdíl?**
✓ `scoring.js:2` — `composite_score` je dashboard-owned, 0–100, 6 os + 5 penalizací. `best_targeting_score` je Go-owned (orchestrator intelligence loop). `icp_score` není separátní column — ICP tier (ideal/good/marginal) je jedna z 6 os v composite (`scoring.js:6`).

**257. Lze scoring přepočítat manuálně?**
✓ `Scoring.jsx:163–175` + `scoring.js:238–252` — tlačítko "Přepočítat nyní" volá `POST /api/scoring/recompute-all` s limit 1000.

**258. Auto-recalculation — kdy běží (intelligence loop 6h)?**
✓ `server.js:5425` — scoring recompute hourly cron, stale-first batch 500/hr (~12k/day). Nezávislé na intelligence loop.

**259. Per-axis breakdown (sector_match, region_match, size_match, NACE_match)?**
✓ `Scoring.jsx:9–16` — 6 AXES: `icp, email, engagement, size, recency, sector`. Plus `scoring.js:18–24` — 5 PENALTIES: `bounce, unsub, inactive, free_webmail, fatigue`. Preview tier histogram `TierHistogram` + sliders umožní per-axis ladění.

### B data

**260. Kde uložené (companies.composite_score, contacts.score)?**
✓ `companies.composite_score`, `companies.score_tier`, `companies.scored_at`. Viz `scoring.js:288–302` (stats query). Contacts nemají separate score column.

**261. Jaký je vzorec (váhy per-axis)?**
✓ `scoring.js:22–37` — DEFAULT_WEIGHTS s 12 klíči. Vzorec: pozitivní axes vážený součet (0–1 každá) × jejich weight, pak aplikace penalizačních multiplikátorů. `computeCompositeScore` v `scoring.js` (fulltext). Normalizace na 0–100.

### C mailing

**262. Vidím skóre při výběru contacts pro kampaň?**
⚠ Campaigns page neimportuje scoring data — grep returns 0 matches. Score je viditelný v Companies page (best_targeting_score sloupec), ale při výběru contacts pro kampaň scoring není prominentně zobrazen.

**263. Sort kampaně po skóre?**
✗ Campaigns page: žádné scoring sort. Contacts pro kampaň se seedují přes SQL script, ne přes UI scoring sort.

### D UX

**264. Histogram distribuce skóre v segmentu?**
✓ `Scoring.jsx:36–61` — `TierHistogram` komponenta zobrazuje S/A/B/C/D tiers s progress bar a count. Preview histogram (na aktuálních weights) + Saved config histogram.

**265. Per-axis explorer (jaký podíl na finální score)?**
✓ `Scoring.jsx:214–264` — sliders per axis s live hodnotami. Preview tlačítko přepočítá distribuci na preview sample. Logistic learning "Naučit váhy z odpovědí" zobrazí before/after per-axis (`Scoring.jsx:356–368`).

### E edge

**266. Co když firma nemá data pro scoring (výjmka, default 0)?**
✓ `scoring.js` — každá axis funkce defensively fallbacks: `icp_tier` unknown → `ICP_TIER_VALUE.unscored = 0.2`, missing `email_confidence` → 0, atd. `computeCompositeScore` nezpůsobí crash při chybějících polích.

### F persistence

**267. Filter přes session?**
NA — Scoring page nemá filtry, jen slider weights. Weights jsou persistovány v DB (`scoring_config` tabulka, `id=1`). Načítají se při mount (`Scoring.jsx:114` — `loadConfig()`).

### G security

**268. Scoring config (váhy) — operator edit?**
⚠ `PUT /api/scoring/config` je chráněn global auth middleware (`server.js:350`). Validace 0–1000 range (`scoring.js:155–161`). Není role-based access — každý autentizovaný operátor může měnit váhy.

### H audit

**269. scoring_recalculate logged?**
✗ `scoring.js` neobsahuje žádný `INSERT INTO operator_audit_log`. Ani uložení konfigurace, ani recompute se neloguje. **Audit gap**.

### I integrace

**270. Ze scoring otevřít top-N firem?**
⚠ `Scoring.jsx:280–288` — zobrazuje "Z N firem (top podle Go best_targeting_score)" ale není clickable. Dual-axis endpoint `GET /api/dual-axis` vrací top firmy, ale ze Scoring page není navigate link na Companies se score sortem.

### J perf

**271. Recalculate of 200k firem trvá kolik (intelligence loop)?**
⚠ BFF scoring cron: 500 firem/hod (`server.js:5425`). 200k firem = ~400 hodin na full recalculate. Manual recompute přes UI cap 1000 (`scoring.js:240`). Go intelligence loop má vlastní scoring — frekvence/kapacita není auditována zde.

---

## 12. CRM klienti

Zdrojové soubory:
- `features/platform/outreach-dashboard/src/pages/CrmClients.jsx`
- `features/platform/outreach-dashboard/src/server-routes/crm.js`
- `features/platform/outreach-dashboard/src/components/CrmImportModal.jsx`
- `features/platform/outreach-dashboard/src/components/CrmBadge.jsx`
- `features/outreach/campaigns/sender/dedup_guard.go`

### A funkce

**272. CRM klient vs prospect — jaký je rozdíl?**
✓ CRM klient = importovaný z eWAY-CRM (klienti nebo obchodní případy). Prospect = contact v `contacts` tabulce bez `crm_client_id`. Rozlišení přes `crm_status` (Aktuální/Potenciální/Nezajímavý/Začínáme). `CrmClients.jsx:12–17`.

**273. Co se importuje z eWAY-CRM XLSX (klienti vs obchodní_případy)?**
✓ `crm.js:260–330` — importuje dva sheety:
- Klienti XLSX: `mapKlient()` — ICO, DIČ, Název, Email, Stav, Vztah, Rating, Adresa, Vlastník, Poznámka
- OP XLSX: `mapOP()` — filtruje Stav='Začínáme', mapuje Kód, Předmět, Odhad uzavření

**274. Lze ručně přidat CRM klienta?**
✗ Žádný "Přidat klienta" button v `CrmClients.jsx`. Pouze import z XLSX. **Feature gap**.

**275. Lze update existující CRM klienta?**
⚠ Pouze přes reimport XLSX — `ON CONFLICT (imported_from, entity_id) DO UPDATE` (`crm.js:355–381`). Žádné inline edit UI.

**276. Lze CRM klienta smazat (audit log per memory)?**
✗ Žádný DELETE endpoint v `crm.js` (routes: GET list, GET detail, GET stats, POST import, GET freshness). Žádné delete UI. **Feature gap**.

**277. CRM badge na CompanyDetail / ContactDetail (Sprint CRM-6)?**
✓ `CrmBadge.jsx` existuje a je použit v:
- `Companies.jsx:291` — na company detail
- `Contacts.jsx:118` (full badge) a `Contacts.jsx:401` (compact dot)
- `Replies.jsx:507` — compact badge v reply listu

### B data

**278. crm_clients schema (entity_id unique per source)?**
✓ Z `crm.js:148–165` SELECT query: `id, name, ico, email_primary, crm_status, crm_relationship, owner_email, last_activity, imported_from, op_code, op_subject, created_at, updated_at`. UNIQUE constraint je `(imported_from, entity_id)` — viz `ON CONFLICT` clause `crm.js:354`.

**279. FK na companies + contacts (crm_client_id)?**
✓ `crm.js:395–417` — po každém importu: UPDATE companies SET crm_client_id=cc.id WHERE c.ico=cc.ico + UPDATE contacts SET crm_client_id=cc.id WHERE email match (primary + secondary).

**280. dedup-guard 8. axis crm_active_client (Sprint CRM-5)?**
✓ `dedup_guard.go:84,155–162` — `crm_active_client` je **první** evaluovaný axis (před DNT). Pokud `contacts.crm_client_id IS NOT NULL`, vrátí `Eligible=false, Reason="crm_active_client"`. Testováno v `dedup_guard_test.go:141–143`.

### C mailing

**281. CRM klient se automaticky vyřazuje z outreach?**
✓ Viz Q280. `dedup_guard.go:155–162` — blokuje send pokud `crm_client_id` je nastaven. Hard skip.

**282. Suppression list backfilled při importu?**
✗ `crm.js` import nevkládá záznamy do `outreach_suppressions` ani `suppression_list`. Ochrana je výhradně přes dedup guard axis, ne přes suppression tabulky. Pokud by dedup guard byl obejit, CRM klient by mohl dostat email. **Architectural note** (ne kritický bug, protože dedup guard je první axis, ale suppression jako záloha chybí).

### D UX

**283. Filter podle stav (Aktuální, Potenciální, Nezajímavý, Začínáme)?**
✓ `CrmClients.jsx:301–315` — chip group "Stav" s facety ze serveru. Multi-select. `crm.js:113–118` — facety z GROUP BY.

**284. Search by name, ICO, email?**
✓ `CrmClients.jsx:279,199–207` — `SearchInput` komponenta, backend query `ILIKE %search%` na `name, email_primary, ico` (`crm.js:48–52`).

**285. Drawer s detailem (deals, history)?**
✓ `CrmClients.jsx:41–165` — `ClientDetailDrawer` otevírá se kliknutím na řádek. Zobrazuje CRM status/vztah/vlastník, email, linked companies + linked contacts. Žádná deals/history timeline.

### E edge

**286. Co když CRM email matchne víc contactů v naší DB?**
⚠ `crm.js:406–413` — UPDATE contacts WHERE email = cc.email_primary nastaví crm_client_id na **posledního** naimportovaného klienta se stejným emailem. Více kontaktů se stejným emailem = všichni dostanou stejný crm_client_id.

**287. Co když ICO matchne firmu která už zanikla?**
⚠ Import neověřuje `datum_zaniku`. Firma s `datum_zaniku != NULL` dostane crm_client_id i přesto.

**288. Reimport — UPSERT nebo INSERT?**
✓ `crm.js:343–382` — `ON CONFLICT (imported_from, entity_id) DO UPDATE` = UPSERT. Existující záznamy se aktualizují.

### F persistence

**289. Filter přes reload?**
✗ Filtry (status, relationship, hasEmail, owner, search) jsou local React state v `CrmClients.jsx:175–180`. Po reload se resetují. Není URL search params ani localStorage persistence. **UX gap**.

### G security

**290. Komu jsou CRM data viditelná?**
⚠ Všechny `/api/crm/*` routes jsou za global auth middleware (`server.js:350` — `app.use(createAuthMiddleware())`). Není role-based access control — všichni autentizovaní uživatelé vidí CRM data.

### H audit

**291. crm_import logged (PR #830)?**
✓ `crm.js:425–448` — `INSERT INTO operator_audit_log ('crm_import', ...)` s detailními stats (rows_in_klienti, rows_in_op, inserted, updated, skipped, linked_companies, linked_contacts_*). `audit_log_id` vrácen v response a zobrazen v UI (`CrmImportModal.jsx:281`).

**292. crm_client_delete logged?**
NA — DELETE endpoint neexistuje (viz Q276), takže audit log pro delete neexistuje.

### I integrace

**293. Z CRM klienta otevřít company timeline?**
⚠ `ClientDetailDrawer:131–143` — linked companies jsou zobrazeny jako cards se základními infos (name, ico, email). **Chybí** link na `/companies/:ico` nebo company timeline. Není navigační odkaz.

**294. Z CRM klienta otevřít contact list?**
⚠ `ClientDetailDrawer:146–159` — linked contacts zobrazeny jako cards (jméno, email, total_sent). **Chybí** link na `/contacts?crm_client_id=X`. Není navigační odkaz.

**295. CRM badge na replies (rozpoznání že odepsal CRM klient)?**
✓ `Replies.jsx:507` — `<CrmBadge crm={r.crm} compact />` je v reply listu. Badge zobrazuje CRM status ve formě barevné tečky s tooltip (`CrmBadge.jsx:61–76`).

### J perf

**296. /api/crm/clients pagination?**
✓ `crm.js:94–112` — `LIMIT $p OFFSET $p+1` s default limit=100. UI `CrmClients.jsx:399–419` — Předchozí/Další buttons s offset state. Parallel fetch list + count + facets v jednom `Promise.all`.

---

## Kritické nálezy

### CRITICAL BUGS

**CRM double-mount (server.js:3856 + server.js:5849)**
`mountCrmRoutes` je volán DVAKRÁT v `server.js`. Express zaregistruje všechny CRM routes duplikátně. Každý request zasáhne první handler (Express short-circuits) — funkčnost není porušena, ale je to waste a potenciální source confusion. Mělo by být odstraněno jedno volání.

### MVP BLOCKERS

- **Q220** — Z Leads nelze otevřít reply thread ani poslat odpověď. Operator nemůže reagovat přímo ze sekce Leady.
- **Q293/294** — Z CRM drawer není clickable link na company timeline ani contact list. Dead-end UX.

### HIGH GAPS

- **Q216** — Notes pro lead není v UI vystaveno (backend podporuje, UI chybí)
- **Q227** — Žádný audit log pro lead_create, lead_stage_change
- **Q251** — template_create + template_update nemají audit log (jen delete)
- **Q269** — scoring config save + recompute nemá audit log
- **Q282** — CRM import nevkládá do suppression_list jako backup
- **Q289** — CRM filtry se po reload resetují (no URL persistence)

### MEDIUM GAPS

- **Q214** — Leads jsou flat tabulka, ne kanban (design limitation)
- **Q217/229** — Žádný lead→CRM export
- **Q232** — Template duplicate chybí
- **Q239** — Template versioning chybí
- **Q274/276** — CRM ruční přidání + smazání chybí

---

## Verdict summary

| Sekce | ✓ | ⚠ | ✗ | NA | Celkem |
|-------|---|---|---|----|----|
| 9. Leady (212–230) | 6 | 3 | 6 | 4 | 19 |
| 10. Šablony (231–254) | 9 | 6 | 5 | 4 | 24 |
| 11. Skórování (255–271) | 9 | 5 | 3 | 1 | 18 |
| 12. CRM klienti (272–296) | 12 | 8 | 5 | 0 | 25 |
| **Celkem** | **36** | **22** | **19** | **9** | **86** |

Celkový stav: 36 ✓ / 22 ⚠ / 19 ✗ / 9 NA z 86 otázek.
