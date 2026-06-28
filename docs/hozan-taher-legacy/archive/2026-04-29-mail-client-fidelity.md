# Mail Client Fidelity — full inbound capture + timeline render

**Status:** active
**Vlastník:** Chat A (Dev) — testy synchrony Chat B
**Datum založení:** 2026-04-29
**Trigger:** uživatel — "potřebujeme si být 100 % jistý, že v real-time ukládáme e-maily k nám společně s obrázky, tj. naše aplikace má fungovat jako reálný mailový klient s historií, avšak pouze ukazuje timeline chatu s jednotlivým klientem."

## Kontext

Audit 2026-04-29 ukázal, že inbound mail neukládáme v plné věrnosti — IMAP poller fetchne jen plain-text body, MIME parts (HTML alternativa, přílohy, inline obrázky) zahodí, DB tabulka `outreach_messages` nemá `body_html`/`body_text`/`attachments`, a UI v `ThreadDetail` ve skutečnosti rendruje subject místo body (`features/platform/outreach-dashboard/src/routes/replies.js:224` mapuje `body: reply.subject`).

Měřená fakta z investigace:
- `features/inbound/orchestrator/imap/poller.go:364` — `FETCH ... (BODY[HEADER.FIELDS (...)] BODY[TEXT])`, žádný RFC822/MIME
- `features/inbound/orchestrator/thread/inbound.go:58-66` — `RawInbound{ BodyPlain string }`, žádné HTML/Attachments
- `features/inbound/orchestrator/thread/messages.go:91-109` — `INSERT INTO outreach_messages (..., body_preview, body_hash, sentiment, ...)`, preview truncate na 200 znaků
- `features/platform/outreach-dashboard/server.js:4267-4279` — `reply_inbox` schema bez body/attachments
- `features/platform/outreach-dashboard/src/pages/ThreadDetail.jsx:52` — `<div style={{whiteSpace:'pre-wrap'}}>{msg.body}</div>` (plain-text only, žádný HTML, žádné `cid:` substituce)
- `grep -ic attachment features/platform/outreach-dashboard/server.js` → **0** hitů
- `ThreadDetail.jsx:120-128` má file picker, ale `handleSendReply:131` posílá jen `{ body }` — vybrané soubory **nikam neletí** (mrtvý kód)
- Žádný real-time push pro nové inbound zprávy (SSE existuje jen pro mailbox health)

## Cíle

Měřitelné:

1. **100 % MIME fidelity** — pro každý inbound mail s HTML alternativou + inline obrázkem + přílohou se po průchodu poller→DB→BFF→UI zobrazí HTML render s vykreslenými inline obrázky a přílohami ke stažení. Test fixturou (real-world mail dump z Mailpitu) ověří round-trip.
2. **0 datových ztrát při retain window** — `body_text + body_html + attachments` perzistované 90 dní (default; per ADR retention policy). GDPR Art. 17 erasure cascade smaže i přílohy.
3. **Timeline s ≤ 1s p95 first paint** — pro thread s ≤ 50 zprávami a celkovým objemem ≤ 20 MB (typický B2B prospect dialog).
4. **Real-time push** — nová inbound zpráva se objeví v otevřeném `ThreadDetail` < 5 s po doručení do mailboxu (po IMAP poll cyklu).
5. **Outbound parita** — operator může poslat reply s 1–3 přílohami; UI form to skutečně přenese na BFF → relay → SMTP. Kill dead UI state.

Non-goals:
- Plný IMAP klient (folders, labels, search-indexing) — jen B2B thread inbox.
- Encrypted-at-rest blob storage — bytea v PG s db-level encryption stačí pro start.
- S3/external object store — viz memory `feedback_no_external_services`.

## Architektura (rozhodnutí)

| Téma | Volba | Odůvodnění |
|---|---|---|
| Storage backend pro bytes | **bytea v Postgres** | <10 MB attachment limit × max 3 per zpráva = ≤30 MB řádek; PG zvládá; GDPR cascade jednoduchá; žádný external service (memory rule). Migrace na object store je upgrade-path, ne MVP problém. |
| MIME parser | **stdlib Go: `net/mail` + `mime` + `mime/multipart`** | Žádný third-party. Existující relay už MIME assembly dělá, parser je inverzní. |
| HTML sanitizace | **server-side bluemonday (Go) v RecordInbound** | Defense-in-depth: ukládáme **pouze sanitizovanou** verzi do `body_html`. Surový HTML zachováváme v `body_html_raw` (TEXT, lazy-load) jen pro DSR export. UI nikdy nedostane raw. |
| `cid:` → URL substituce | **server-side při BFF read** | BFF endpoint `/api/messages/:id` rewrituje `<img src="cid:foo">` na `<img src="/api/messages/:id/attachments/foo">` při serializaci. UI dostane už hotový HTML. |
| Real-time push | **rozšíření existujícího SSE patternu** | Nový endpoint `/api/threads/stream`, hook v thread-record-inbound emituje `inbound` event. Reuse `healthStreamClients` strukturu. |
| Outbound attachment upload | **multipart/form-data → BFF → relay** | BFF přijme `POST /api/replies/:id/reply` jako multipart, uloží přílohy do `message_attachments`, sestaví MIME a předá relay. |

Tyto volby žijí jako sekce této iniciativy; pokud sprint S1 vrátí měření, které je vyvrátí, otevřeme ADR.

## Plán (sprinty)

### Sprint S1 — Capture (foundation, ~3-4 dny)

Cíl: inbound mail dorazí → DB obsahuje plný body_html, body_text, body_html_raw a všechny přílohy s content_id. Bez UI změn.

- [x] **S1.1** Schema migrace `scripts/migrations/012_outreach_messages_full_body.sql` (additive ALTER: body_text, body_html, body_html_raw, body_size_bytes) + `013_message_attachments.sql` (CREATE TABLE s FK ON DELETE CASCADE + indexy `(message_id)` + partial `(message_id, content_id) WHERE NOT NULL`). Pozn.: `011_*` už existuje na origin/main, proto 012/013. Brutal test `scripts/migrations/test_012_013.sh` (33 assertions) — **PR #210**.
- [ ] **S1.2** IMAP poller plný RFC822 fetch — `features/inbound/orchestrator/imap/poller.go:364` z `BODY[TEXT]` na `BODY.PEEK[]` (nepřepisuje `\Seen`). Update `parseFetchResponse` aby vrátil raw bytes místo extracted text.
- [ ] **S1.3** MIME parser modul `features/inbound/orchestrator/mime/parser.go` (nový) — vstup raw RFC822, výstup `ParsedMessage{Plain, HTML, Attachments []Attachment{ContentID, Filename, ContentType, Data, IsInline}}`. Stdlib only. Test fixtures: `testdata/{plain.eml, html.eml, multipart-alt.eml, inline-image.eml, attachments.eml, nested-multipart.eml}`.
- [ ] **S1.4** `RawInbound` struct rozšířit + `RecordInbound` repo update — perzistovat plný `body_text`, sanitized `body_html`, `body_html_raw`, a `INSERT INTO message_attachments` v transakci. HTML sanitize přes `github.com/microcosm-cc/bluemonday` (jediná nová Go dep — zdokumentovat v ADR).
- [ ] **S1.5** Test suite — table-driven s real-world `.eml` fixturami. Acceptance: round-trip mail s `<img src="cid:logo">` + JPEG attachment → DB obsahuje 1 row v outreach_messages s body_html (sanitized) + 1 row v message_attachments (content_id="logo", is_inline=true).
- [ ] **S1.6** GDPR cascade — `features/inbound/orchestrator/web/handler_dsr.go` Article 17 erasure rozšířit o `DELETE FROM message_attachments WHERE message_id IN (SELECT id FROM outreach_messages WHERE thread_id IN (...))`. Audit log entry.

**Trailers:** `Needs-Tests: orchestrator/mime parser fixture suite` pro Chat B.

### Sprint S2 — Render (read path, ~2-3 dny)

Cíl: UI ThreadDetail vykreslí sanitized HTML s inline obrázky + chips pro stažitelné přílohy.

- [ ] **S2.1** BFF endpoint `GET /api/threads/:id/messages` přepsat — místo `reply_inbox.subject` jako body, joinout `outreach_messages` a vracet `{id, direction, body_text, body_html, attachments: [{cid, filename, content_type, size_bytes}], received_at}`. Rewrite `<img src="cid:X">` na `<img src="/api/messages/:id/attachments/X">` při serializaci (pomocný util `lib/cid-rewrite.js`).
- [ ] **S2.2** BFF endpoint `GET /api/messages/:id/attachments/:cid_or_filename` — streamuje bytes z PG bytea, sets `Content-Type` + `Content-Disposition: inline` (pro inline) nebo `attachment` (pro download). API-key auth jako ostatní `/api/*`.
- [ ] **S2.3** ThreadDetail.jsx — `<div data-testid="message-body">` rozdělit na `body_html` (přes sanitized + `dangerouslySetInnerHTML`) **nebo** fallback `body_text` (pokud HTML chybí). Defense-in-depth: client-side `DOMPurify` jako 2nd layer (server už sanitizoval, ale paranoid). Plus attachment chips section pod body.
- [ ] **S2.4** Replies.jsx — odebrat `body: reply.subject` mapping, joinout do nového endpointu. Update typecheck.
- [ ] **S2.5** Test suite — XSS resistance (`<script>alert(1)</script>` v body_html_raw, sanitized verze nesmí obsahovat `<script>`), graceful fallback (chybí `cid:` ref → `<img alt="missing">`), velký body (>1MB body_html, render < 500ms p95).

**Trailers:** `Covers: #<S1.5 PR>` (Chat B verifikuje fixture round-trip).

### Sprint S3 — Real-time + Outbound parity (~2-3 dny)

Cíl: nový mail v ThreadDetail < 5s, send-with-attachments funguje end-to-end, mrtvý UI state smazán.

- [ ] **S3.1** SSE `/api/threads/stream` na BFF — emit `inbound` event s `{thread_id, message_id}` payload. PG NOTIFY/LISTEN nebo poll-based fan-out z BFF cron. Reuse `healthStreamClients` pattern z `features/platform/outreach-dashboard/server.js:4759-4786`.
- [ ] **S3.2** Hook v `features/inbound/orchestrator/thread/messages.go RecordInbound` — po úspěšném INSERT poslat HTTP POST na BFF `POST /internal/threads/notify` (interní endpoint, sdílený secret) **nebo** PG NOTIFY. Volba podle latencie testu v S1. Default: PG LISTEN/NOTIFY (žádné network coupling).
- [ ] **S3.3** ThreadDetail.jsx — useEffect EventSource('/api/threads/stream'), filter podle thread_id, prepend new message, auto-scroll if at-bottom. Reconnect-on-close pattern z mailboxes/health-stream.
- [ ] **S3.4** Outbound multipart upload — `handleSendReply` z `JSON {body}` na `FormData {body, files[]}`. BFF `POST /api/replies/:id/reply` přijme multipart (express `multer` nebo manuální parser — rozhodneme v PR). Files → `INSERT INTO message_attachments` s `direction='outbound' message_id`. Předáno relay s MIME assembly.
- [ ] **S3.5** Smaž dead UI state (předchozí `attachments` state v ThreadDetail.jsx, který nikam neletěl). Replace s reálným uploadem.
- [ ] **S3.6** E2E test — Playwright spec `tests/e2e/thread-attachment-roundtrip.spec.ts`: start orchestrator + BFF + greenmail; pošli mail s inline obrázkem do testovací schránky; ověř že se objeví v UI < 10s; klikni reply, attachni JPEG, send; ověř že greenmail dostal mail s correct MIME boundaries.

**Trailers:** `Breaks-Contract: api/replies/:id/reply now multipart` pro Chat B (je třeba update contract testů).

## Rizika

- **Storage growth** — bytea v PG při 100 mailů/den s avg 500 KB attachment = ~50 MB/den = ~18 GB/rok. Sledovat `pg_size_pretty(pg_total_relation_size('message_attachments'))` v existujícím `/api/health/system`. Pokud > 50 GB, otevřít ADR pro object-store migration.
- **HTML sanitizace strictness** — bluemonday default policy může zařezat legitimní marketing HTML (CSS-in-style, position absolute v signatures). Plán: začít s `bluemonday.UGCPolicy()` + log řezů; po týdnu produkce vyhodnotit.
- **PG NOTIFY/LISTEN reliability** — pokud BFF spadne během notification, message se ztratí (nelze replay). Mitigace: SSE clients stejně mají 30s polling fallback z `/api/threads/:id/messages`. NOTIFY je optimization, ne SoT.
- **Backwards compat** — existující `outreach_messages` rows mají `body_preview` ale ne `body_html`. UI musí gracefully renderovat preview pro old rows (S2.3 fallback chain: body_html → body_text → body_preview).

## Blokátory

- Žádné. Schema migrace je additive (žádný DROP), runner BF-G3 zvládne. Bluemonday je single-purpose dep, žádný conflict s existujícím go.work.

## Log

- 2026-04-29 — založeno; audit ukázal end-to-end gap, plán 3 sprintů, S1 ready to start.
- 2026-04-29 — S1.1 shipped (PR #210); migrace 012/013 (collision detected — 011 existoval). 33/33 brutal asserts pass.
