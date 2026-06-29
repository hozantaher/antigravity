# Egress Consistency per Mailbox

**Status:** Open
**Datum:** 2026-05-08
**Trigger:** nowak.gorak@email.cz lockován Seznamem dnes (2026-05-08 ~13:00 UTC) po 30 min testů. Root cause: stejný account credentials viděný Seznamem ze 4-7 různých (IP, country) tuples — SMTP drain přes Mullvad pool, IMAP poll přes Railway native, full-check probe přes relay's free rotating pool, lokální dev cron z CZ residential. Multi-country same-account login pattern = fraud detection trigger.

PR #1100 (Sprint AN) opravil pouze SEND-side country pinning. Audit dnešní (deep analysis 2026-05-08) odhalil 6 dalších cest, kde stejný credential se používá s odlišným egress IP. Všechny IMAP cesty navíc používají raw `net.Socket` — porušení HARD RULE memory `feedback_no_direct_smtp`.

## Cíl

Po dokončení iniciativy:

1. **Každá mailbox kredenciála = jediný stable egress endpoint** napříč všemi operacemi (SMTP send, SMTP probe, IMAP poll, IMAP inbox fetch, full-check, classifier).
2. Per-mailbox `preferred_country` (Sprint AN) řídí výběr endpointu pro VŠECHNY operace, ne pouze pro send.
3. Žádný raw `net.Socket` na `*.seznam.cz` z žádného produkčního kódu. Vše přes wgpool SOCKS5 nebo přes relay endpoint, který sám wgpool používá.
4. Lokální dev tooling (Python skripty, BFF v `pnpm dev` mode) nepoužívá produkční mailboxy přímo. Samostatné test schránky pro dev nebo `DISABLE_IMAP_CRON=1` v `.env.development`.
5. Recovery plán pro lockované schránky.

## Proč to je naléhavé

Bez tohoto fixu:
- Každý nový mailbox má time-to-fraud-lock měřitelné v desítkách minut (nowak.gorak prokázal)
- Operace, které jsou jindy benign (background IMAP poll), kontaminují reputaci kvůli kombinaci s SMTP send přes Mullvad
- Memory rule `feedback_no_direct_smtp` byl ukázán jako neenforceable — chybí audit ratchet

## Sprint AO1 — BFF IMAP přes SOCKS5 (P0)

Hlavní gap. BFF má 6 IMAP funkcí v `server.js:2016–2270`, všechny `new net.Socket()` + `s.connect()` bez proxy.

**Co uděláme:**

- Refactor `imapCheck`, `imapSearchUnseen`, `imapSearchUnseenUids`, `imapFetchHeaders`, `imapFetchByMessageId` na použití SOCKS5 proxy.
- Volba A: použít existující `socks` npm balíček (importován v server.js:9) → `SocksClient.createConnection({proxy: {host, port}, command: 'connect', destination: {host: 'imap.seznam.cz', port: 993}})`. Proxy adresa = wgpool endpoint pro danou schránku, získaná přes nový BFF helper `getMailboxSocksEndpoint(mailbox_id)` který volá relay pro endpoint label/addr.
- Volba B: přesunout IMAP probe do relay endpoint `/v1/imap-poll` (nový), kde relay sama vybere wgpool endpoint per mailbox a vrátí parsed response do BFF. Cleaner separation, ale větší code change.
- Audit ratchet test: `features/platform/outreach-dashboard/tests/audit/no_raw_imap_socket.test.js` — fail pokud kdokoli v `features/platform/outreach-dashboard/src` nebo `server.js` používá `net.Socket()` + `.connect(*, 'imap.seznam.cz')` bez SOCKS5 wrapper.

**Effort:** 1-2 dny.

## Sprint AO2 — Go orchestrator IMAP přes SOCKS5 (P0)

`features/inbound/orchestrator/imap/poller.go:592` používá `net.Dialer` bez proxy. Stejný problém jako BFF.

**Co uděláme:**

- Refactor `imapConnect()` na použití `golang.org/x/net/proxy` SOCKS5 dialer nebo na použití existujícího `features/outreach/relay/internal/transport/transport.go SOCKS5Transport` (kompatibilní s `net.Conn`).
- Konfigurace přes `IMAP_SOCKS_ADDR` env var nebo via DB lookup mailbox.preferred_country → relay endpoint port.
- Audit ratchet v Go: nový test `features/inbound/orchestrator/imap/no_raw_dial_audit_test.go` — grep AST pokud `imapConnect` používá `net.Dialer` přímo bez SOCKS5 wrapper.

**Effort:** 1 den.

## Sprint AO3 — Relay probe endpoints používají wgpool (P0)

`features/outreach/relay/web/probe.go:170–190` `smtpAuthProbe` konzultuje `s.proxyPool` (free rotating) místo `s.wgPool`. Drain vs probe → jiný egress per stejnou schránku.

**Co uděláme:**

- Přidat `mailbox_id` field do `probeRequest` / `authCheckRequest` types.
- V `smtpAuthProbe` a `imapAuthProbe`: pokud `s.wgPool != nil` a `mailbox_id` přítomný → `wgPool.Pick("", mailboxID, mailbox.preferred_country)` (env+drain sdílejí stejný endpoint).
- Backward compat: pokud `mailbox_id` chybí, fallback na current behavior.
- Update BFF `relaySmtpCheck` v `features/platform/outreach-dashboard/src/lib/relayClient.js` aby předal mailbox_id.

**Effort:** 2 dny.

## Sprint AO4 — Disable BFF dev IMAP cron v localhost mode (P2)

`pnpm dev` spouští `runImapPollCron` každých 15 min z CZ residential IP developera. Přidává tuple navíc.

**Co uděláme:**

- Guard `if (process.env.DISABLE_IMAP_CRON === '1' || process.env.NODE_ENV === 'development') return` v `runImapPollCron` (server.js:4136).
- `features/platform/outreach-dashboard/.env.development` (gitignored) přidá `DISABLE_IMAP_CRON=1`.
- Dokumentace v CLAUDE.md: "Dev mode = no IMAP touch on prod mailboxes; use test fixtures."

**Effort:** 30 minut.

## Sprint AO5 — Audit ratchets pro raw SMTP/IMAP socket (P1)

Bez ratchetů byl `feedback_no_direct_smtp` HARD RULE neenforceable. Čerstvé audit testy:

- Go: `features/outreach/relay/sender/no_bypass_audit_test.go` baseline 0 (existující). Rozšířit pro IMAP raw socket detection v ALL Go services.
- JS: nový `features/platform/outreach-dashboard/tests/audit/no_raw_smtp_imap_socket.test.js` — grep pro `net.Socket()`, `tls.connect()`, `smtp.connect`, `imap.connect` mimo whitelist (relayClient + verifyEmail).

**Effort:** 1 den.

## Sprint AO6 — Recovery + dev hygiene (P1)

- Postup pro lockovanou schránku: 24-48h cooling + verify z Railway BFF (NE z localhost) + implementovat AO1+AO2 před dalšími testy.
- Per-mailbox audit log: nová tabulka `mailbox_egress_audit (mailbox_id, operation, egress_ip, egress_country, observed_at)` zachycující každou outbound connection — Sentry alert pokud (mailbox, operation) → 2+ countries v 1h okně.

**Effort:** 1 den.

## Pořadí + závislosti

| Sprint | Závislost | Effort | P |
|---|---|---|---|
| AO4 disable dev cron | žádná | 30min | P2 (immediate) |
| AO5 audit ratchets | AO1+AO2 (pro green test) | 1d | P1 |
| AO1 BFF IMAP SOCKS5 | žádná | 1-2d | P0 |
| AO2 Go orchestrator IMAP SOCKS5 | žádná | 1d | P0 |
| AO3 probe → wgpool | AO5 ratchet vstup | 2d | P0 |
| AO6 recovery + audit table | AO1-3 | 1d | P1 |

Total: ~8 dní práce, paralelizovatelné po AO1+AO2 (oba na různých repech).

## Otevřené otázky

1. **Fast IMAP polling vs reputation tradeoff** — 15min cron je agresivní pro freshly created mailbox. Snížit na 60min na prvních 7 dní?
2. **Per-mailbox SOCKS5 endpoint discovery** — má BFF query relay přes API, nebo má cached lokální mapping? (cache stale = wrong country.)
3. **Test schránky pro dev** — operator vytvoří 2 testovací mailboxy s jiným pollingem nebo manual-only?
4. **Recovery** — pro nowak.gorak: 24h cooling pasivní, NEBO Seznam support kontakt?

## Co tato iniciativa NEDĚLÁ

- 3rd party SMTP/IMAP API (memory `feedback_no_external_services`)
- Multi-region BFF / orchestrator (per-region egress optimization je out of scope)
- Tor / multi-hop egress (memory `project_egress_canonical` — Mullvad-only)
- Sprint AM (contact verify loop) — orthogonal, jiný lifecycle
