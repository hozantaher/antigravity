# Deep Inventory — Cross-Cutting Audit (otázky 390–591)

**Status:** Dokončeno  
**Datum:** 2026-05-05  
**Trigger:** Audit před launch — cross-cutting téma pokrývající IMAP, reply attribution, timeline, mailový klient, attachments, sales completeness, RFC compliance, GDPR, performance, resilience.

Metodologie: každá otázka ✓ = implementováno / ⚠ = částečně / ✗ = chybí / NA = neaplikováno. Citace file:line.

---

## A. IMAP Integration (390–396)

**390. Stahuje systém data z IMAP a ukládá?**  
✓ `features/inbound/orchestrator/imap/poller.go:119` — `PollOnce` prochází všechny mailboxy, volá `doFetch` a výsledek předává `thread.InboundProcessor.ProcessReply`. Zprávy jsou persistovány do `outreach_messages` a `reply_inbox`.

**391. Jak často poll (default 60-90s)?**  
⚠ Default je **2 minuty**, ne 60–90s. `cmd/outreach/main.go:702` — `imapInterval := 2 * time.Minute`. Override přes `IMAP_INTERVAL` env var. Tento interval je konzervativnější než question předpokládala.

**392. UID watermark per mailbox — pamatuje co už staženo?**  
⚠ Implementováno přes **in-memory LRU dedupe set** (Message-ID based), nikoliv persistent UID watermark v DB. `poller.go:27-86` — `defaultSeenCap = 50_000`, FIFO eviction. Po restartu orchestratoru se seen-set vyprázdní a poller se opírá o `SEARCH UNSEEN SINCE {lastPoll}`. Pokud lastPoll není zachovaný (restart), záleží na IMAP serveru, co vrátí jako UNSEEN. Neexistuje DB-backed watermark.

**393. UIDvalidity-aware (mailbox rebuilt → re-fetch all)?**  
✗ Žádná logika pro `UIDVALIDITY`. CLAUDE.md orchestratoru sice zmiňuje "UID watermark + uidValidity-aware delta detection" jako funkci, ale v `poller.go` není žádná zmínka o UIDVALIDITY nebo CONDSTORE. Grep v celém `imap/` — žádné výsledky pro `uidvalidity`. **MVP-blocker risk: při rebuild mailboxu server přečísluje UIDs, seen-set je neplatný, duplicity v DB.**

**394. Multi-folder polling (INBOX, Spam, Trash)?**  
✗ `poller.go:300` — `command(conn, "SELECT INBOX")` — pouze INBOX, bez dalších složek. Odpovědi v Spamu nebo přesunuté do Trash jsou přeskočeny.

**395. Auth fail handling (3× 401 → circuit_open)?**  
⚠ Auth chyba způsobuje, že `doFetch` vrátí error → `fetchNewMessages` propaguje error → `PollOnce` zaznamenává `result.Errors = 1` a pokračuje na další mailbox. `runWithReconnect` dělá exponential backoff (1s → 5min). Neexistuje explicitní circuit breaker "3× auth fail → circuit_open". BFF má vlastní IMAP circuit breaker v `server.js:4172`, ale Go orchestrátorův poller nemá.

**396. TLS / STARTTLS?**  
⚠ Implicit TLS (port 993) implementováno správně s `tls.Client` + `HandshakeContext(ctx)` — `poller.go:368-406`. STARTTLS (port 143 + UPGRADE) **není implementováno** — `connect()` buď použije TLS (port 993) nebo plaintext TCP (jakýkoliv jiný port). `conn_test.go:585` to explicitně dokumentuje: non-993 port se připojuje bez TLS.

---

## B. Reply Attribution (397–401)

**397. Přiřazují se odpovědi ke správné firmě a kontaktům?**  
✓ `thread/inbound.go:413-451` — `matchToThread` hledá `In-Reply-To` → `outreach_messages.message_id` → `outreach_threads.contact_id`. Primární i fallback přes `References` header.

**398. Match by email lower(trim) → contact → company.ico?**  
⚠ Přiřazení probíhá přes **Message-ID chain** (In-Reply-To / References), nikoliv přes email adresu. Pokud odpovídá někdo jiný (jiný email = jiný kontakt), kdo není v `outreach_contacts` s outbound thread, nebude matchnutý. `matchToThread` nepoužívá email lookup jako fallback.

**399. Co když odepsal někdo jiný v té samé firmě (boss → asistentka)?**  
✗ Bez fallbacku na email lookup v DB. Pokud boss je kontakt s threadem ale asistentka odepíše z jiné adresy, `matchToThread` nenajde thread a zpráva je zalogována jako `inbound no matching thread` (`inbound.go:137-138`). **Reply je ztracen (nezachycen).**

**400. Co s aliasy (info@firma.cz → boss@firma.cz)?**  
✗ Stejný problém — pokud `info@firma.cz` není kontakt s aktivním threadem, alias reply nebude matchnutý. Žádná alias-expansion logika.

**401. Forwarded mail (Outlook auto-fwd)?**  
✗ Forwarded mail obvykle neobsahuje původní `In-Reply-To`, takže nenajde thread. Žádná specifická logika pro detekcifwd.

---

## C. Conversation History / Timeline (402–406)

**402. Mohu si projít historii konverzace s firmou?**  
✓ `CompanyTimeline.jsx` — existuje component, volá `GET /api/companies/:id/timeline`, zobrazuje chronologický feed outbound + inbound + ai_draft zpráv. BFF endpoint wired v `server-routes/replies.js`.

**403. Funguje to formou timeline (chronological feed)?**  
✓ `CompanyTimeline.jsx:148-185` — chronologická fetchování + render `MessageRow` se `KIND_META` (outbound, inbound, ai_draft).

**404. Per-company nebo per-contact thread?**  
✓ Timeline je per-company (`GET /api/companies/:id/timeline`). Interně BFF joinuje `outreach_threads → contacts → companies` přes ICO.

**405. Visualization (timeline graph, kanban, list)?**  
⚠ Pouze **chronologický list** (bubble-chat styl). Žádný kanban, žádný timeline graph. Dostačující pro MVP, ale omezené.

**406. Filterable per-event-type (send, open, click, reply, bounce)?**  
✗ `CompanyTimeline.jsx` nemá filtrování per-event-type. Zobrazuje všechny zprávy bez filtru.

---

## D. Mailový klient pocit (407–412)

**407. Chová se to jako mailový klient (Apple Mail / Outlook)?**  
⚠ Částečně. `ThreadDetail.jsx` má bubble-chat layout, classify akce, compose box, attachments při odeslání. Ale chybí: thread listing jako Inbox, multiple threads per company view, unread indicators, search across messages.

**408. Lze odpovědět z UI (compose box)?**  
✓ `ThreadDetail.jsx:138-173` — `handleSendReply`, FormData + multipart upload, `POST /api/replies/:id/reply`. Max 3 přílohy × 10 MB.

**409. Lze přepojit / forward?**  
✗ Není implementováno. Žádný forward tlačítko/handler v `ThreadDetail.jsx` ani v BFF routes.

**410. Lze označit jako spam (manual classifier override)?**  
⚠ Klasifikace je možná (`handleClassify`) — lze nastavit `positive`, `negative`, `question`, `unsubscribe`. Žádná explicitní "spam" klasifikace. Unsubscribe = nejbližší ekvivalent.

**411. Drafts perzistent?**  
✗ Draft state je čistě in-memory v React (`const [body, setBody] = useState('')`). Reload = ztráta draftu. Žádný localStorage/IndexedDB persistence.

**412. Inbox vs Sent split?**  
⚠ `Replies.jsx` — inbox view s tab filtry (Vše / Nezpracované / Zájem / Odmítnutí / Auto-reply). Sent view není — odeslané odpovědi se zobrazují v ThreadDetail jako "manual" MessageBubble, ne v separátním Sent folderu.

---

## E. Attachments (413–418)

**413. Mohu vidět fotky které firma pošle?**  
⚠ Inbound fotky jsou zachytávány a ukládány (`photostore`, `message_attachments` tabulka), ale **UI nezobrazuje inbound attachments** z přijatých zpráv. `ThreadDetail.jsx` zobrazuje pouze attachments pro odeslání (outbound compose). Inbound message bubbles (`MessageBubble`) nezobrazují attachment list.

**414. Inline image preview (lightbox)?**  
✗ Není implementováno.

**415. Download attachment?**  
⚠ BFF endpoint pro stažení attachment existuje (dle `replies.js:471` — query na `message_attachments`), ale **UI nemá tlačítko Download** pro inbound attachments. Outbound compose attachments lze odebrat ze seznamu, ale nejsou downloadable.

**416. Storage location (Railway volume, S3)?**  
✓ `internal/photostore/photostore.go:36` — `DefaultRoot = "/data/photos"`, Railway persistent volume. Layout `{root}/{thread_id}/{message_id}/{filename}`. Atomic write-temp-rename.

**417. PDF preview?**  
✗ Není. Ani inline image preview není, natož PDF preview.

**418. Antivirus scan (clamav)?**  
✗ Žádný antivirus. Attachments jsou ukládány bez skenování. `photostore.go` nemá žádný reference na clamav nebo jiný AV.

---

## F. Sales System Completeness (419–424)

**419. Vytěžíme ze získaných dat maximum?**  
⚠ Základ pipeline existuje (scoring, segmenty, leads, timeline), ale chybí prediktivní vrstva.

**420. Per-firma intent score (engagement intensity)?**  
⚠ `intelligence/engagement.go:9-59` — `UpdateEngagementClusters` agreguje metriky do `engagement_cluster` pole v `companies`. Ale toto je segmentace, ne real-time intent score. UI nemá widget zobrazující "tento kontakt je hot right now".

**421. Predikce reply pravděpodobnosti?**  
✗ Není implementována. Intelligence loop recalculuje `composite_score`, ale reply-probability model neexistuje.

**422. Kdy je nejlepší čas znovu oslovit (cool-off recommendation)?**  
✗ Campaign runner má send window gate (Mon–Fri 08-17h), ale žádná personalizovaná "best time to reach" logika per firma/kontakt.

**423. Auto-segmentace high-intent firem?**  
⚠ `engagement_cluster` je blízko, ale není exponovaný jako "auto-segment" v UI. Operator musí ručně vytvořit segment s filter na `engagement_cluster = 'high'`.

**424. Campaign lift analysis (A vs B template)?**  
✗ Žádné A/B test framework. Campaigns nemají `variant_group` nebo split logic.

---

## G. CRM Integration (425–427)

**425. eWAY-CRM XLSX import (Sprint CRM-1 až CRM-7)?**  
✓ `server-routes/crm.js` existuje, `scripts/migrations/050_crm_clients_import.sql` — `crm_clients` tabulka. `CrmImportModal.jsx` existuje. CrmBadge komponenta wired do Replies a ThreadDetail.

**426. Bidirectional sync (export back to eWAY)?**  
✗ Export zpět do eWAY není implementován. `Leads.jsx:217` — export do CRM není k dispozici. Pouze jednostranný import.

**427. Conflict resolution (CRM updated, naše DB updated)?**  
⚠ Import je UPSERT (migrace 050), ale žádná conflict resolution strategie pro bidirectional sync (není potřeba, dokud 426 neexistuje).

---

## H. Plný prodejní systém (428–433)

**428. Je to plný prodejní systém?**  
⚠ Je to **B2B sales engagement platform**, nikoliv full CRM. Má: send pipeline, reply triage, leads tracker, company timeline. Chybí: forecast, multi-user, reminder/follow-up scheduler, pipeline value.

**429. Funnel stages (Lead → MQL → SQL → Opportunity → Customer)?**  
⚠ `Leads.jsx:9` — `STATUS_OPTIONS = ['new', 'contacted', 'qualified', 'won', 'lost']`. Funkční ale zjednodušený funnel. MQL/SQL explicit staging není.

**430. Forecast / pipeline value?**  
✗ Chybí. Žádné `deal_value`, `expected_close_date`, nebo aggregace pipeline hodnoty.

**431. Activity log per firma?**  
⚠ `CompanyTimeline` je de facto activity log, ale zahrnuje pouze email events, ne manual activities (call, meeting).

**432. Reminders + follow-up scheduler?**  
✗ Není. Thread pause (OOO/Later) existuje pro automatické pauzy, ale operator-initiated reminder s datumem neexistuje.

**433. Multi-user assignment (operator A vlastní firma X)?**  
✗ Není. Systém je single-operator. Žádný `assigned_to` field na leads nebo threads.

---

## Random Brutal Otázky — UX/App (434–490)

**434. Co když operator otevře 2 taby a každý udělá jinou změnu?**  
✗ Last-write-wins. Žádný optimistic locking v žádné tabulce.

**435. Optimistic locking?**  
✗ Neimplementováno. Ani `version` column, ani `updated_at` guard v UPDATE statements.

**436. Service worker / offline mode?**  
✗ Žádný service worker. `main.jsx` neregistruje SW. Offline = prázdná aplikace.

**437. Mobile responsive (smartphone in field)?**  
⚠ Částečně. App je responsive CSS, ale není primárně navržena pro smartphone. Tabulky mohou overflow na malých displejích.

**438. Screen reader accessible?**  
⚠ Axe-core gate `tests/e2e/a11y.spec.ts` blokuje PR na critical violations. Serious violations (color contrast) zatím nejsou gated. `CLAUDE.md:outreach-dashboard` dokumentuje one-way ratchet.

**439. Dark mode persistent přes reload?**  
⚠ Dark mode toggle existuje, pravděpodobně v localStorage (neověřeno). Žádná evidence persistence.

**440. Keyboard navigation všude?**  
⚠ Klávesové zkratky pro navigaci (0-9) existují (`HelpOverlay.jsx`), ale celoplošná Tab navigation nebyla auditována.

**441. Focus trap v modals?**  
⚠ `Modal.jsx` existuje, ale focus trap pattern nebyl auditován.

**442. Confirmation dialog před destructive akcí?**  
⚠ Unsubscribe má `window.confirm()` (`ThreadDetail.jsx:214`). Jiné destructive akce — neověřeno systematicky.

**443. Undo functionality (last action)?**  
✗ Není implementováno.

**444. Bulk select stable přes pagination?**  
⚠ Bulk akce existují v `Replies.jsx` (select + mark handled), ale stabilita přes pagination nebyla auditována.

**445–453 (right-click, drag-drop, search autocomplete, saved views, custom columns, density, pin column, resize, multi-sort):**  
Density toggle existuje (`DensityToggle.jsx`). Ostatní: ✗ chybí.

**454. Multi-sort?**  
✗ Chybí.

**455. Column-specific filter?**  
✗ Chybí Excel-like per-column filter.

**456. Inline edit?**  
✗ Chybí.

**457. Cell-level audit?**  
✗ Chybí.

**458–461 (Export selected, saved CSV exports, scheduled exports, PDF print):**  
✗ Všechny chybí v production UI.

**462. Quick action bar?**  
⚠ Command palette `CommandPalette.jsx` existuje — slouží jako quick action bar.

**463–466 (Floating help, notification center, operator presence, activity feed):**  
`HelpOverlay.jsx` existuje (klávesové zkratky). Notification center, operator presence, activity feed: ✗ chybí.

**467. Notes per entity?**  
✗ Chybí free-form notepad per company/contact.

**468–490 (Tags, smart suggestions, "did you mean", recently changed, soft delete, versioning, diff viewer, audit log search, RBAC, feature flags, A/B, PostHog, feedback widget, error boundary, graceful degradation, skeleton loading, empty states, onboarding, keyboard shortcuts help, changelog):**  
- `ErrorBoundary.jsx` existuje ✓  
- `ShortcutsHelp.jsx` existuje ✓  
- `EmptyFilterState.jsx` existuje ✓  
- Feature flags: ✗  
- RBAC: ✗  
- A/B framework: ✗  
- Analytics (PostHog): ✗ (pouze Sentry)  
- Onboarding tutorial: ✗  
- Soft delete / trash: ✗  
- Versioning per entity: ✗  

---

## Mailing / Pipeline Brutal Otázky (491–526)

**491. Kdo je odpovědný za rendering Subject line?**  
✓ Template engine — `content/template.go` — subject se extrahuje z `{{/* subject: ... */}}` komentáře. Render se děje v `runner.go` při build SendRequest.

**492. Kdy se přepočítává Reply-To (per-mailbox unique)?**  
⚠ `Reply-To` header není explicitně nastaven v `engine.go:buildMessage`. Příjemce vidí `From:` adresu mailboxu jako reply-to. Žádný dedikovaný per-mailbox Reply-To bounce trap.

**493. List-Unsubscribe header povinný (RFC 2369)?**  
✓ List-Unsubscribe **je v headers mapě propagována** přes `rendered.Headers → engine.Enqueue → buildMessage:1285`. `runner.go:376` builduje `unsubURL`, vkládá do `vars.UnsubURL`, template pak může do HTML footer. Ale List-Unsubscribe jako **email header** (ne jen odkaz v těle) není automaticky injektován! `content/template.go:128-138` — headers map obsahuje jen `"Content-Language": "cs"`. UnsubURL jde do těla šablony přes `{{unsuburl}}`, ne do email headeru.  
**⚠ MVP concern: List-Unsubscribe email header se neinjektuje automaticky — závisí na tom, zda šablona předá `List-Unsubscribe` do rendered.Headers.**

**494. List-Unsubscribe-Post header (RFC 8058 one-click)?**  
⚠ Testy v `sender/e2e_test.go:22` ověřují propagaci, ale automatická injekce v `runner.go` nebo `template.go` chybí (stejný problém jako 493).

**495. Precedence: bulk header?**  
✗ Není v production kódu. Nalezeno pouze v `mailsim/reply.go:57` — simulátor, ne production sender. `buildMessage` v `engine.go` nenastavuje `Precedence: bulk`.

**496. X-Campaign-ID header?**  
✗ Není implementován.

**497. Message-ID format unique guaranteed?**  
✓ `headers.go:66-84` — `BuildMessageIDHeader` = HMAC-SHA256(recipient + envelopeID, hmacKey)[:16] + nanosecond timestamp. Per-recipient unikátní.

**498. References header (chain replies)?**  
✗ Follow-up zprávy (step 2, 3) nenastavují `References` na předchozí message ID. `runner.go` nepropaguje previous Message-ID do `References` v SendRequest.

**499. In-Reply-To header?**  
✗ Follow-up zprávy (bumps) nenastavují `In-Reply-To` na původní zprávu. Engine nevidí `previous_message_id` v SendRequest schema.

**500. SPF record na sending domain?**  
NA — konfigurace DNS je mimo kód. Závisí na nastavení domén mailboxů.

**501. DKIM signing?**  
NA — závisí na poskytovateli mailboxů / DNS nastavení.

**502. DMARC policy?**  
NA — DNS konfigurace.

**503. BIMI logo?**  
✗ Není implementováno ani zmíněno v kódu.

**504. Authenticated Received Chain (ARC)?**  
✗ ARC je implementováno mail serverem, ne klientem. Relay neemituje ARC headers.

**505. Feedback Loop (FBL) registration s Seznam/Gmail?**  
✗ Není implementováno. Žádná FBL processing logika.

**506. Postmaster tools monitoring?**  
✗ Není integrováno.

**507. RBL check before send?**  
✗ Žádný RBL check.

**508. SPF SoftFail vs Fail behavior?**  
NA — závisí na DNS.

**509. Reverse DNS (PTR) match?**  
NA — závisí na Railway IP a DNS.

**510. Open relay test?**  
NA — relay vyžaduje autentizaci.

**511. Greylisting smart retry?**  
✓ `sender/backoff.go` — greylisting backoff. BFF `server.js:529-670` má greylist retry cron.

**512. TLS verify (StartTLS vs implicit TLS)?**  
⚠ Relay side: `internal/delivery/smtp.go` používá TLS ale STARTTLS status vyžaduje deeper audit. IMAP: viz 396.

**513. SMTP banner randomization?**  
✗ SMTP banner je fixed (relay nezměňuje).

**514. EHLO / HELO hostname per envelope?**  
✓ `relay/delivery` — `pickHELODomain` vybírá FQDN z mailbox adresy, viz memory `HELO audit blind spot`.

**515. MAIL FROM normalization (RFC 5321)?**  
✓ Relay normalizuje fromAddr.

**516. RCPT TO encoding (UTF-8 SMTPUTF8)?**  
⚠ Není explicitní SMTPUTF8 EHLO extension handling. Česká jména v email adresách by mohla způsobit problémy.

**517. DATA boundary (CRLF.CRLF dot-stuffing)?**  
⚠ `buildMessage` neimplementuje dot-stuffing explicitně — závisí na Go `net/smtp` (nebo relay).

**518. Long line handling (>998 chars)?**  
⚠ Není explicitní line-wrapping na 998 chars. Quoted-printable handling zabraňuje nejhorším scénářům, ale není garantováno.

**519. Content-Transfer-Encoding (quoted-printable, base64)?**  
✓ `engine.go:1328,1334` — `Content-Transfer-Encoding: quoted-printable` pro HTML i plain text. Plain-text-only path: `8bit`.

**520. Charset declaration (utf-8 forced)?**  
✓ `engine.go:1326,1332` — `Content-Type: text/html; charset=utf-8` a `text/plain; charset=utf-8`.

**521. MIME multipart/alternative (text + html)?**  
✓ `engine.go:1311-1337` — multipart/alternative s boundary.

**522. Attachment Content-Disposition?**  
NA — outbound zprávy neobsahují přílohy (pouze inline tracking pixel).

**523. Reply tracking pixel placement?**  
✓ Open pixel `/o` endpoint v `web/server.go`. Pixel URL je injektována do HTML body šablony.

**524. Click-tracking redirect URL pattern?**  
✓ Click redirect `/c` endpoint v `web/server.go`.

**525. Cookie-less tracking?**  
✓ Tracking je URL-token-based, ne cookie-based.

**526. UTM parameters auto-injection?**  
✗ Není implementováno.

---

## IMAP Brutal Otázky (527–539)

**527. SELECT vs EXAMINE folder (read-write vs read-only)?**  
⚠ `poller.go:300` — používá `SELECT INBOX` (read-write). RFC 3501 doporučuje `EXAMINE` pokud nepotřebujeme nastavovat \Seen flag. Systém nesetuje \Seen explicitně, takže `SELECT` může mít nežádoucí side-effects pokud server setne \Seen při FETCH.

**528. UID FETCH vs SEQ FETCH?**  
✗ `poller.go:334-348` — `SEARCH UNSEEN` vrací sequence numbers, ne UIDs. `fetchMessage` používá sequence numbers. Při concurrent přístupu k mailboxu mohou sequence numbers divergovat. Správnější by bylo `UID SEARCH` + `UID FETCH`.

**529. CAPABILITY before LOGIN check?**  
✗ Žádná `CAPABILITY` command před LOGIN. Neověřuje se zda server podporuje potřebné extensions.

**530. IDLE protocol support (push notifications)?**  
✗ Není implementováno. Polling only.

**531. CONDSTORE extension (modseq)?**  
✗ Není implementováno.

**532. QRESYNC for fast sync?**  
✗ Není implementováno.

**533. SEARCH UNSEEN performance?**  
⚠ `SEARCH UNSEEN SINCE {date}` — bez UID prefix a bez CONDSTORE může být pomalé na velkých mailboxech.

**534. Empty mailbox handling?**  
✓ `poller.go:329` — `if len(uids) == 0 { command(conn, "LOGOUT"); return nil, nil }` — správně vrací prázdný slice.

**535. Flags update (\Seen, \Deleted, \Flagged)?**  
✗ Systém nenastavuje \Seen po přečtení. Zprávy zůstávají jako UNSEEN v mailboxu indefinitely (viz 527). `BODY.PEEK[]` (`poller.go:489`) explicitně zabraňuje nastavení \Seen — záměrné.

**536. Move vs copy+delete?**  
✗ Systém nemove ani nekopíruje zprávy mezi složkami.

**537. Append (drafts persist)?**  
✗ Drafts nejsou perzistovány na IMAP server.

**538. Quota check?**  
✗ Žádný QUOTA check.

**539. Mailbox subscribe / unsubscribe?**  
NA — automatické subscription management není potřeba.

---

## Anti-trace Brutal Otázky (540–555)

**540. HELO domain leak v Received: from `<client-name>`?**  
✓ `relay/delivery` — `pickHELODomain` volí FQDN z mailbox adresy. Memory `HELO audit blind spot` popisuje PR #740 fix. Relay nyní emituje správný FQDN.

**541. EHLO IP literal vs FQDN?**  
✓ `pickHELODomain` zakazuje `localhost` a prázdný string — vždy FQDN.

**542. X-Originating-IP header strip?**  
✓ `relay/internal/delivery/privacy.go:13-25` — `privacySensitiveHeaders` obsahuje `"x-originating-ip": true`.

**543. X-Mailer header strip / spoof?**  
✓ Stripován (`privacySensitiveHeaders:17`). Humanize fingerprint layer může injektovat `X-Mailer: Seznam.cz` (viz `sender/engine.go:16`).

**544. Date header timezone match egress timezone?**  
✓ `headers.go:197-215` — `BuildDateHeader` formátuje v `mailbox.Timezone` (IANA), default "Europe/Prague".

**545. Message-ID domain match sending mailbox domain?**  
✓ `headers.go:66-84` — `domainOf(fromAddress)` extrahuje FQDN z mailbox adresy.

**546. Boundary string randomized per envelope?**  
⚠ `engine.go:1315` — `boundary := "----=_Part_" + boundaryID` kde `boundaryID = messageID[:8]`. MessageID je HMAC-based unikátní, ale boundary je deterministicky odvozená z prvních 8 znaků message ID, ne samostatně randomizovaná.

**547. Header order preservation (RFC 5321)?**  
⚠ `buildMessage` iteruje přes `map[string]string` pro custom headers — Go map iteration je non-deterministic. Header order může variovat per send (hashmap randomization). RFC 5322 nemandátuje order, ale konzistentní order je menší fingerprint.

**548. Body ending CRLF.CRLF dot-stuffing?**  
⚠ Není explicitní dot-stuffing. Závisí na relay/smtp library.

**549. SMTP pipelining vs sequential commands?**  
NA — relay side závisí na Go `net/smtp`.

**550. Connection reuse same envelope vs fresh?**  
⚠ `poller.go` otevírá fresh connection per poll cycle — intentional pro anonymitu. Relay side: per-send fresh connections.

**551. SOCKS5 versioning correctness?**  
✓ SOCKS5 implementace v relay/delivery — existuje test coverage.

**552. WireGuard packet handshake replay protection?**  
✓ WireGuard protokol má built-in replay protection.

**553. VPN handshake fingerprinting (DPI detection)?**  
⚠ Mullvad WireGuard je komerční VPN navržená pro odolnost vůči fingerprinting, ale aktivní DPI obfuskace není implementována v kódu (závisí na Mullvad service).

**554. DNS leakage outside VPN tunnel?**  
⚠ DNS leakage závisí na deployment konfiguraci. Kód explicitně neřeší DNS routing.

**555. NTP / time sync (clock skew detection)?**  
✗ Žádná clock skew detekce. Railway containers závisí na systémovém NTP.

---

## GDPR / Compliance Brutal (556–570)

**556. Privacy notice link v každém emailu (HTML footer)?**  
⚠ `UnsubURL` se injektuje do šablony přes `{{unsuburl}}`. Privacy notice URL závisí na **obsahu šablony** — není automaticky garantován. `scripts/migrations/025_campaign_455_unsub_footer.sql` přidal footer migraci, ale samotná šablona to musí implementovat. Žádný systémový audit, zda footer existuje v každé šabloně.

**557. List-Unsubscribe + List-Unsubscribe-Post oba?**  
⚠ Viz 493 — headers nejsou automaticky injektovány do email headers, pouze do těla šablony.

**558. Unsubscribe link 1-click bez login?**  
✓ `buildUnsubURL` generuje token-gated URL (`/unsubscribe?c=&id=&t=`). BFF zpracovává bez autentizace.

**559. Soft unsub vs hard unsub semantics?**  
✓ Unsubscribe zapisuje do `suppression_list` + `outreach_suppressions`. Thread classifier má kategorie (negative → hard suppression, unsubscribe → suppression list zápis). `ThreadDetail.jsx:213` — dvoustupňový flow.

**560. DSR access response time SLA (1 měsíc)?**  
✓ `dsr.js:56` — `GET /api/dsr/access` implementován. SLA garantuje kód (vždy <1s response), ale operativní SLA (1 měsíc) je procesní záležitost.

**561. DSR erasure cascades všechny tabulky?**  
✓ `dsr.js:152` — `POST /api/dsr/erase` + migrace 050 Art. 17 anonymization. CRM cascade dokumentován.

**562. Data minimisation v audit_log?**  
✓ PII audit `2026-05-05-pii-secret-leakage.md` a PR #841 dokumentovány v CLAUDE.md.

**563. Pseudonymization possible?**  
⚠ Erasure anonymizuje (ICO retained, PII nullified) dle migrace 050. Plná pseudonymizace není implementována.

**564. Data retention 1825 days?**  
⚠ Migration zmíněna v otázce (PR #852), ale v migračních souborech nebyl nalezen 1825-day retention policy. `scripts/migrations/` neobsahuje retention migration s explicitním 1825-day TTL.

**565. Operator audit_log immutable (no UPDATE/DELETE)?**  
✓ `operator_audit_log` nemá UPDATE/DELETE v kódu. Pouze INSERT operace.

**566. CMS / cookie consent banner if dashboard public?**  
NA — dashboard není veřejný. Chráněn X-API-Key.

**567. Geographic restriction (EU-only data residency)?**  
⚠ Railway App je hosting provider. `docs/legal/scc-railway.md` existuje. Railway dokáže hostovat v EU regionu, ale není garantováno v kódu.

**568. Cross-border transfer (Railway EU? Mullvad endpoints?)?**  
⚠ `docs/legal/art30-register.md:21` — Railway listed jako subprocessor s "TODO — zajistit DPA/SCC". Mullvad endpoints pro SOCKS5 mohou být mimo EU.

**569. Sub-processor list documented?**  
⚠ `docs/legal/art30-register.md:128-137` — sub-processor list existuje, ale 4 ze 5 providerů mají status DPA "TODO": Railway, Anthropic, Sentry (Ollama NA). **MVP concern pro GDPR audit.**

**570. DPA agreement template ready?**  
✗ `docs/legal/scc-railway.md` existuje (Standard Contractual Clauses), ale aktívní DPA agreements s Railway, Anthropic, Sentry nejsou podepsané dle `art30-register.md`.

---

## Performance Brutal (571–583)

**571. Largest table row count?**  
NA — nelze auditovat bez prod DB access.

**572. Index coverage on hot queries?**  
⚠ `scripts/migrations/047_email_lower_indexes.sql` — email lower-case indexy existují. Kompletní index coverage audit vyžaduje `EXPLAIN ANALYZE` na produkci.

**573. N+1 query detection?**  
⚠ `CompanyTimeline` a `ThreadDetail` dělají parallel fetches (Promise.all), ale interní SQL queries za ně nejsou auditovány pro N+1.

**574. Query timeout config (statement_timeout)?**  
✗ `server.js:100` — `new pg.Pool({ connectionString: ... })` — žádný `statement_timeout`. Dlouhé queries mohou držet connection pool.

**575. Connection pool size (pgxpool)?**  
⚠ Go side: `database/sql` default pool. BFF side: `pg.Pool` bez explicitního `max` nebo `min` nastavení. Default `pg.Pool.max = 10`.

**576. Slow query log review?**  
NA — závisí na Railway/PostgreSQL konfiguraci.

**577. Redis / cache layer needed?**  
⚠ Intelligence loop 6h aggregations mohou být pomalé. Žádný Redis. BFF používá in-process cache (Map) pro některé endpoints.

**578. CDN for static assets?**  
⚠ Vite build produkuje dist/, ale CDN integration není konfigurována. Static assets servuje Railway přímo.

**579. WebSocket / SSE per page?**  
✓ SSE na `GET /api/threads/stream` (`server-routes/threads.js:90`). PG LISTEN/NOTIFY → SSE fan-out. Jeden SSE endpoint.

**580. Bundle size dashboard (gzip <500kb)?**  
⚠ `vite.config.js:51` — `manualChunks` pro code splitting. Gzip cíl nespecifikován. P-2 fix zmíněn v komentáři (~140KB gzip pro lucide icons). Cílová velikost není definována v kódu.

**581. Time to first byte (<1s)?**  
NA — nelze auditovat bez real traffic data.

**582. Time to interactive (<3s)?**  
NA — nelze auditovat bez real traffic data.

**583. Largest contentful paint (LCP <2.5s)?**  
NA — nelze auditovat bez Lighthouse/Web Vitals data.

---

## Resilience Brutal (584–591)

**584. Graceful degradation when Go orchestrator unreachable?**  
✓ `store/outreachHealth.ts` — `useOutreachHealth` degraded flag. BFF fallback routes pro campaign API (`CLAUDE.md:outreach-dashboard:proxy-routes`). Banner zobrazující degraded stav.

**585. BFF retry with backoff?**  
⚠ Go proxy calls v `server.js` nemají explicitní retry logic. `sendReply` má 30s timeout (`server.js:1600-1602`). Žádný exponential backoff.

**586. Circuit breaker frontend → BFF?**  
✗ Frontend nemá circuit breaker. Volání BFF endpoints fail přímo s error state v komponentách.

**587. Service worker fallback offline?**  
✗ Viz 436. Žádný SW.

**588. Localstorage backup of unsent forms?**  
✗ Viz 411 (Drafts). Žádný localStorage backup.

**589. Browser refresh = lost state mitigation?**  
⚠ Zustand store persists přes render, ale ne přes page refresh. URL state pro filtry (searchParams) pomáhá, ale není systematický.

**590. Memory leak in long-running tabs (24h+)?**  
⚠ SSE connection (`/api/threads/stream`) udržuje heartbeat interval. Leak risk u komponent co zapomenou unsubscribe z SSE. Není auditováno systematicky.

**591. Background fetch refresh?**  
⚠ `useResource` hook s polling (`useEffect` + refresh) existuje v některých komponentách. Není systematický background refresh pattern.

---

## MVP-Blocker Souhrn

| # | Otázka | Popis | Severity |
|---|--------|-------|----------|
| 1 | 393 | UIDvalidity neimplementováno — po mailbox rebuild duplicity | HIGH |
| 2 | 398-400 | Reply attribution pouze přes Message-ID chain, ne email fallback — aliasy a asistentky ztraceny | HIGH |
| 3 | 413-415 | Inbound attachments se nezobrazují v UI (fotky zákazníků neviditelné) | HIGH |
| 4 | 493-494 | List-Unsubscribe email header není auto-injektován — závisí na šabloně; RFC 2369 compliance risk | HIGH |
| 5 | 498-499 | Follow-up emaily (bumps) nesetují In-Reply-To/References — nebudou threadovány v MUA příjemce | MEDIUM |
| 6 | 495 | Precedence: bulk header chybí — spam filtry mohou klasifikovat jako phishing | MEDIUM |
| 7 | 528 | SEQ FETCH místo UID FETCH — race condition při concurrent mailbox access | MEDIUM |
| 8 | 574 | Žádný `statement_timeout` v pg.Pool — dlouhé queries mohou vyčerpat pool | MEDIUM |
| 9 | 569-570 | DPA agreements s Railway/Anthropic/Sentry chybí — GDPR subprocessor compliance gap | MEDIUM |
| 10 | 411 | Drafts neper zistovány — reply ztracena při reload | LOW |
