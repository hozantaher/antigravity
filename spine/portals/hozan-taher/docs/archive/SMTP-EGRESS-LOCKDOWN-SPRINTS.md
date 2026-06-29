# SMTP Egress Lockdown — Plán + Sprints (v2, code-accurate)

**Verze 2** — přepis po code-auditu 2026-04-21. V1 předpokládal greenfield nový service; audit ukázal že `anti-trace-relay` + `privacy-gateway` jsou už plně scaffolded v monorepu a pokrývají 80 % architektury. Tento plán **nebuduje nic znovu**, jen aktivuje + utěsňuje co existuje.

> **Kořenový incident (2026-04-21):** AI agent udělal `net.connect(smtp.seznam.cz:587)` z lokálního hosta jako debug probe. Seznam eviduje auth pokusy per-IP. 1× fail auth + 3× OK auth = flagging signál → nutnost výměny IP. Risk je strukturální: hlavní app má víc cest co mohou omylem otevřít direct TCP na mail server.

---

## Co už existuje (audit 2026-04-21)

### ✅ Gateway infrastruktura — **hotová**

| Service | Lokace | Stav |
|---|---|---|
| `anti-trace-relay` (:8090) | `features/outreach/anti-trace-relay/` | Full Go source, 116 tests, Dockerfile, railway.toml, stdlib-only |
| `privacy-gateway` (:8080) | `features/compliance/privacy-gateway/` | Full Go source, Dockerfile, railway.toml, `DELIVERY_MODE=record-only` default |
| `go.work` | root | Oba moduly deklarované |
| `infra/docker/docker-compose.yml` | `infra/docker/` | Full stack s mailpit + greenmail |

**`anti-trace-relay` už má:**
- `internal/transport/proxy_pool.go` — `RotatingProxyTransport` s `DialContext`, geonode fetch, `probeAll` (50 paralelních prob), round-robin `pick()`, auto-remove dead proxies
- `internal/delivery/smtp.go` — `SMTPDeliverer` který volá `transport.DialContext()` (= SOCKS5 wrapped)
- `internal/transport/chain.go` — transport chain s `probeTarget = "smtp.seznam.cz:465"`

**Go engine už větví:**
- `modules/outreach/internal/sender/engine.go:305-335` → `if e.antiTrace != nil` → `e.antiTrace.Send(ctx, req)` HTTP POST na relay `/v1/submit`
- `engine.go:336-362` → direct SMTP fallback (aktivní jen když `antiTrace == nil`)

**BFF už má anti-trace health probe:**
- `/api/anti-trace/health` (`server.js`)
- `AnonymizationBar` UI komponenta v `Mailboxes.jsx`

### ⚠️ Duplikátní / bypass cesty — **k odstranění**

| Location | Problém |
|---|---|
| `features/platform/outreach-dashboard/server.js:2824` `smtpCheck()` | Direct TCP na SMTP host když `useProxy=false`. Mb 631/632 full-check prošel touto cestou z naší IP. |
| `features/platform/outreach-dashboard/server.js:2691` `smtpAuthProbe()` | Přes SOCKS5 OK, ale duplikátní s `anti-trace-relay/internal/transport`. |
| `features/platform/outreach-dashboard/server.js:4118` full-check větví proxy/direct | Fallback path na direct je **bypass**. |
| `features/platform/outreach-dashboard/server.js:2058-2072` `socks5Probe()` | Hardcoded target `smtp.seznam.cz:465`. Probe-only ale měla by jít přes relay. |
| `features/platform/outreach-dashboard/src/lib/emailProbe.js:63-128` | SMTP RCPT probe přímo na MX host, port 25. Email verification path. |
| `modules/outreach/internal/validation/smtp_probe.go:49-65` | Go SMTP probe na MX, port 25/587. Email verification. |
| `modules/outreach/internal/sender/engine.go:408-421` | Direct SMTP fallback když `antiTrace==nil` — tento else branch musí zmizet. |
| BFF `proxyCache`, `refreshProxyPool`, `rankProxies`, `isBlacklisted` | Duplikátní s relay `RotatingProxyTransport`. |

### ❌ Nic neexistuje — **k vybudování**

- Runtime `AssertSocks5` guard v `anti-trace-relay/internal/transport`
- Pre-commit hook blokující SMTP host/port diff mimo gateway services
- DNS blackhole `smtp.*` / `imap.*` v BFF + Go main app kontejnerech
- Railway network-level egress rules (nebo iptables fallback)
- Migrace `outreach_mailboxes.{password}` do gateway-local schemy s restriktivním GRANT

---

## Guiding principles

1. **Reuse, don't rebuild.** `anti-trace-relay` JE ten gateway. Všechen nový SMTP/IMAP egress zchází přes jeho `/v1/*` endpointy.
2. **Remove direct paths.** Každá direct-SMTP větev co existuje (BFF `smtpCheck`, engine else branch, emailProbe.js, smtp_probe.go) se buď přesměruje na relay, nebo smaže.
3. **Anti-trace mandatory.** `engine.go` nadále nepodporuje `antiTrace==nil` — service se nestartne bez něj.
4. **Layer defense.** Runtime guard (panic) + pre-commit (block diff) + síťová vrstva (deny egress) + DNS blackhole (no resolve).
5. **Reverzibilita.** 8 sprintů = 8 commitů. Žádný big bang.
6. **Paralelní s prior plány.** Kompatibilní s `PRIVACY-MAIL-GATEWAY-RESTORATION.md` (ten řeší privacy-gateway funkcionalitu) a `MAILBOXES-SELF-HEALING-SPRINTS.md` (self-heal rules zůstávají v BFF, jen proxy pool queries jdou přes relay).

---

## Cílová architektura (code-accurate)

```
┌────────────────────────────────────────────────────────────────────┐
│ outreach-dashboard (Vite :5175 + Express BFF :3001)                │
│  ─ knows: mailbox_id, from_address (metadata)                      │
│  ─ calls: http://anti-trace-relay:8090/v1/*                        │
│  ─ REMOVED: smtpCheck, smtpAuthProbe, proxyCache,                  │
│             refreshProxyPool, socks5Probe                          │
│  ─ emailProbe.js: reroute to /v1/verify                            │
└───────────────────────┬────────────────────────────────────────────┘
                        │ Railway Private Network
┌───────────────────────▼────────────────────────────────────────────┐
│ modules/outreach (Go :8080)                                        │
│  ─ engine.go: antiTrace REQUIRED (panic if nil)                    │
│  ─ REMOVED: direct SMTP else branch (engine.go:336-362)            │
│  ─ smtp_probe.go: reroute to relay or disable in prod              │
└───────────────────────┬────────────────────────────────────────────┘
                        │
┌───────────────────────▼────────────────────────────────────────────┐
│ anti-trace-relay (Go :8090) — EXISTING                             │
│  ─ /v1/submit (send mail)                                          │
│  ─ /v1/probe (NEW — full-check mailbox)                            │
│  ─ /v1/auth-check (NEW — SMTP AUTH probe via proxy)                │
│  ─ /v1/proxy-pool (NEW — expose RotatingProxyTransport state)      │
│  ─ /v1/verify (NEW — RCPT-TO probe for email validation)           │
│  ─ /healthz (EXISTS)                                               │
│  ─ RotatingProxyTransport + AssertSocks5 guard (NEW)               │
└───────────────────────┬────────────────────────────────────────────┘
                        │ SOCKS5 only
┌───────────────────────▼────────────────────────────────────────────┐
│ privacy-gateway (Go :8080 internal — EXISTS)                       │
│  ─ bridge do outreach_mailboxes creds                              │
│  ─ /v1/intake/submissions                                          │
└───────────────────────┬────────────────────────────────────────────┘
                        │ SMTP AUTH + DATA
                        ▼
               smtp.seznam.cz / imap.seznam.cz
```

---

## Sprinty (8 místo 10 — kratší díky reuse)

### R1 — Audit & Document (½ den)

**Cíl:** Převést výstup code-auditu na `docs/playbooks/SMTP-EGRESS-LOCKDOWN-AUDIT.md` jako číslovaný seznam call-sites + refactor cíl.

**Kroky:**
1. Dokument s tabulkou: file:line, funkce, direct-egress? sprint-target
2. Zahrnout:
   - 4 direct TCP/TLS výstupy (engine.go:408, smtp_probe.go:49, emailProbe.js:63, server.js:2824)
   - 3 SOCKS5-wrapped (server.js:2691, server.js:2058, relay pool.go:82)
   - proxyCache duplicity (BFF vs relay)
   - hardcoded `smtp.seznam.cz:465` na 2 místech (server.js:2057, pool.go:24)
3. Commit `docs(egress): audit inventory (R1)`

**Rollback:** N/A (read-only)

**Acceptance:**
- [ ] Audit dokument existuje
- [ ] Každý call-site má přiřazený sprint (R2-R9)

---

### R2 — Pre-commit Egress Guard (½ den)

**Cíl:** Git hook blokuje diff s SMTP hosty / mail porty **mimo** `features/outreach/anti-trace-relay/` a `features/compliance/privacy-gateway/`.

**Kroky:**
1. Rozšířit `.githooks/pre-commit` (existuje):
   ```sh
   BANNED='(smtp|imap)\.(seznam|gmail|post|email|chci|spoluzaci)\.(cz|com)|(:465|:587|:25|:993|:143)'
   ALLOW='^services/(anti-trace-relay|privacy-gateway)/|^docs/|^\.githooks/|_test\.(go|js|ts|jsx|tsx)$'
   ```
2. Logika: git diff --cached; pro každý added line mimo ALLOW → exit 1
3. Override pro dokumentaci legitimních výjimek: `SKIP_EGRESS_GUARD=1 git commit` + log do `.egress-guard-overrides.log`
4. Test fixture: pokus `net.connect('smtp.seznam.cz',587)` v `features/platform/outreach-dashboard/server.js` → block
5. Commit `feat(.githooks): pre-commit egress guard (R2)`

**Rollback:** revert hook změny.

**Acceptance:**
- [ ] Hook blokuje `+smtp.seznam.cz:465` v `apps/`
- [ ] Hook povoluje identický diff v `features/outreach/anti-trace-relay/`
- [ ] Test fixtures excluded (`_test.*`)
- [ ] `docs/DEV-SETUP.md` sekce "Egress guard"

---

### R3 — Relay API Extension (1 den)

**Cíl:** Přidat do `anti-trace-relay` endpointy které BFF potřebuje: `/v1/probe`, `/v1/auth-check`, `/v1/proxy-pool`, `/v1/verify`.

**Kroky:**
1. `features/outreach/anti-trace-relay/internal/api/handlers.go`:
   - `POST /v1/probe` body `{mailbox_id}` — full-check (smtp, imap, proxy subchecks). Zrcadlí současný BFF `/api/mailboxes/:id/full-check` response schema pro drop-in kompat.
   - `POST /v1/auth-check` body `{mailbox_id, proxy_addr?}` — SMTP AUTH probe
   - `GET /v1/proxy-pool` — expose `RotatingProxyTransport` state (working count, candidates, last_probe_at)
   - `POST /v1/verify` body `{email, domain}` — RCPT-TO probe pro email validation (replace `emailProbe.js` + `smtp_probe.go`)
2. Sdílet `RotatingProxyTransport` instance mezi submit + probe + auth-check (stejný pool)
3. Auth: extend `X-Gateway-Key` header check
4. Contract test: JSON schema parity s BFF `full-check` response
5. Commit `feat(anti-trace-relay): probe + auth-check + proxy-pool + verify endpoints (R3)`

**Rollback:** revert commit, endpointy přestanou existovat (BFF ještě stále má vlastní logiku → no break).

**Acceptance:**
- [ ] `go test ./features/outreach/anti-trace-relay/...` zelené
- [ ] Contract test zaručuje BFF-kompat schema
- [ ] `POST /v1/probe` vrací shodné `{score, ok, checks{smtp,imap,proxy,...}, critical, warnings}` jako BFF
- [ ] `GET /v1/proxy-pool` vrací shodné pole `working[]` jako BFF `/api/proxy-pool`

---

### R4 — Remove Engine Direct Fallback (½ den)

**Cíl:** Go engine smaže `antiTrace==nil` větev. Service se bez relay URL nestartne.

**Kroky:**
1. `modules/outreach/internal/sender/engine.go`:
   - Smazat `engine.go:336-362` (direct SMTP fallback)
   - `NewEngine(...)` panic když `antiTrace == nil`
   - Smazat `WithAntiTrace(nil)` pattern v testech, nahradit za stub relay s httptest
2. `modules/outreach/internal/config/config.go`:
   - `AntiTrace.Enabled` default `true`
   - Validation: startup fail pokud `ANTI_TRACE_URL` prázdné
3. Unit test: `TestEngine_PanicsWithoutAntiTrace`
4. Main: `cmd/outreach/main.go` ověř env před `NewEngine`
5. Commit `refactor(outreach): mandatory anti-trace, remove direct fallback (R4)`

**Rollback:** revert commit → fallback path se vrací.

**Acceptance:**
- [ ] `grep -nE 'smtp\.Dial|smtp\.SendMail' modules/outreach/internal/sender/engine.go` → prázdné
- [ ] Service panic při chybějícím `ANTI_TRACE_URL`
- [ ] `go test ./modules/outreach/...` zelené
- [ ] E2E smoke: kampaň pošle e-mail úspěšně přes relay

---

### R5 — BFF Consolidation (1-2 dny)

**Cíl:** BFF smaže vlastní SMTP/IMAP/proxy logiku; všechno forwarduje na `anti-trace-relay`.

**Kroky:**
1. `features/platform/outreach-dashboard/server.js` smazat:
   - `smtpCheck`, `smtpAuthProbe`, `makeReader`, `classifySmtpError` (pokud není reusable jinde)
   - `proxyCache`, `refreshProxyPool`, `rankProxies`, `isBlacklisted`, `assignBestProxy`
   - `socks5Probe`
   - Cron `runFullCheckCron`: stále běží v BFF, ale volá relay `/v1/probe`
2. BFF endpointy refactor na forward:
   - `GET /api/mailboxes/:id/full-check` → `POST relay/v1/probe`
   - `POST /api/mailboxes/:id/assign-proxy` → `POST relay/v1/auth-check` + update `outreach_mailboxes.proxy_url` na základě odpovědi
   - `GET /api/proxy-pool` → `GET relay/v1/proxy-pool`
3. `emailProbe.js` odstranit nebo nahradit volání relay `/v1/verify`
4. Self-healing rules (`applyAutomationRules`) zůstávají v BFF (decision logic), ale probes získávají data z relay
5. `socks` package removed z `features/platform/outreach-dashboard/package.json`
6. Tests: `features/platform/outreach-dashboard/test/contract/bff-mailboxes.contract.test.ts` update — mocking relay místo DB přímo
7. `pnpm test` + `pnpm e2e` zelené
8. Commit `refactor(bff): delegate SMTP to anti-trace-relay (R5)`

**Rollback:** revert → BFF znovu má vlastní logiku. Relay endpointy zůstanou (unused).

**Acceptance:**
- [ ] `grep -nE '(net|tls)\.(connect|createConnection)' features/platform/outreach-dashboard/server.js` → prázdné
- [ ] `grep -nE 'smtp\.|SocksClient' features/platform/outreach-dashboard/server.js` → prázdné
- [ ] `features/platform/outreach-dashboard/package.json` neobsahuje `socks` dep
- [ ] `pnpm report` beze změny UX
- [ ] Všechny testy zelené

---

### R6 — Validation Probe Migration (½ den)

**Cíl:** `smtp_probe.go` + `emailProbe.js` — email verification RCPT probe — jde přes relay `/v1/verify` nebo se v production vypne.

**Kroky:**
1. Rozhodnout: je email verification nutná v production?
   - Pokud ano: relay endpoint `/v1/verify` (implementováno v R3); Go `smtp_probe.go` volá relay HTTP, ne direct
   - Pokud ne: `VERIFY_EMAIL_ENABLED=false` env, zkratuje probe a vrátí `unknown` status
2. `modules/outreach/internal/validation/smtp_probe.go`:
   - Nahradit `net.Dialer.DialContext` za HTTP call na relay
   - Nebo: feature flag `if !cfg.Verify.Enabled { return Unknown }`
3. `features/platform/outreach-dashboard/src/lib/emailProbe.js`:
   - Smazat `net.createConnection` path
   - Nebo: forward na BFF → relay
4. Commit `refactor(validation): route email probe through relay (R6)`

**Rollback:** revert.

**Acceptance:**
- [ ] `grep -nE '(net|tls)\.(Dial|connect)' modules/outreach/internal/validation/ features/platform/outreach-dashboard/src/lib/emailProbe.js` → prázdné
- [ ] Email import flow stále funkční

---

### R7 — Runtime AssertSocks5 Guard (½ den)

**Cíl:** `anti-trace-relay` před každým `net.Dial`/`socks.DialContext` ověří že `dest ∈ proxyPool` nebo povolené privacy-gateway address. Jinak error + alert.

**Kroky:**
1. `features/outreach/anti-trace-relay/internal/transport/guard.go` (new):
   ```go
   type DialGuard struct {
     proxyPool *RotatingProxyTransport
     allowedBridges []string  // privacy-gateway addrs
     alerts chan<- Alert
   }
   func (g *DialGuard) Assert(dest string) error {
     if g.proxyPool.IsWorkingAddr(dest) { return nil }
     if slices.Contains(g.allowedBridges, dest) { return nil }
     g.alerts <- Alert{Type: "DIRECT_EGRESS_ATTEMPT", Dest: dest}
     return fmt.Errorf("refused direct egress to %s", dest)
   }
   ```
2. Wire do `SMTPDeliverer` a `proxy_pool.DialContext` — každý Dial musí projít `Assert`
3. Audit log: `relay_audit` log line per Dial (dest, success, ms)
4. Unit test: `TestDialGuard_RefusesDirect`
5. Commit `feat(anti-trace-relay): runtime socks5 assertion (R7)`

**Rollback:** revert.

**Acceptance:**
- [ ] Unit test `TestDialGuard_RefusesDirect_ToSmtpSeznamCz`
- [ ] Audit log populated
- [ ] Regression: existing 116 testů zelených

---

### R8 — Network Lockdown + IP Rotation (1 den + warmup)

**Cíl:** Síťová vrstva zakáže direct egress i kdyby kód obešel guard. Paralelně rotace IP + warmup.

**Kroky:**

**Fáze 8a — DNS blackhole (½ den):**
1. BFF + Go main app Dockerfile: vlastní `/etc/resolv.conf` + `/etc/hosts`:
   ```
   127.0.0.1 smtp.seznam.cz smtp.gmail.com smtp.post.cz smtp.email.cz
   127.0.0.1 imap.seznam.cz imap.gmail.com imap.post.cz imap.email.cz
   ```
2. Relay + privacy-gateway kontejnery **bez** této blackhole (potřebují resolvovat)
3. Test: `docker exec bff nslookup smtp.seznam.cz` → 127.0.0.1

**Fáze 8b — Railway egress firewall (½ den):**
1. Ověřit Railway capabilities:
   - Pokud podporuje egress rules: allowlist `anti-trace-relay` → ven, ostatní services → deny porty 25/465/587/993/143
   - Pokud ne: iptables OUTPUT v Dockerfile (vyžaduje `NET_ADMIN` cap) nebo Railway support ticket
2. Runbook `docs/playbooks/EGRESS-FIREWALL-OPS.md`
3. Commit `infra: DNS blackhole + egress firewall (R8a+b)`

**Fáze 8c — IP rotation + warmup (1 den + 7 dní):**
1. Deploy nového Railway projectu (nebo service) s forced fresh IP
2. Ověřit nová IP přes externí mxtoolbox — žádné blacklist záznamy
3. Warmup schedule v BFF nebo relay:
   - Den 1: 10 mailů / mailbox / den
   - Den 2-3: 25
   - Den 4-7: 50
   - Den 8+: normál cap
4. Fail-safe: `auth_fail_count ≥ 3` během warmup → auto-pause + alert
5. Commit `ops: IP rotation + warmup schedule (R8c)`

**Rollback 8a:** revert Dockerfile změn. 8b: revert rules. 8c: N/A.

**Acceptance:**
- [ ] BFF kontejner: `nc -zv smtp.seznam.cz 465` → timeout (blackhole) nebo refused
- [ ] Relay kontejner: `nc -zv 91.107.239.221 10390` → ok (proxy addr)
- [ ] `pnpm report` 24/24 probes green po 72h na nové IP
- [ ] 4 mailboxy (mb 1, 3, 631, 632) active + `auth_fail_count=0` po warmup

---

## Sprint Grouping

| Fáze | Sprinty | Délka | Kritické |
|---|---|---|---|
| **Sprint 1 — Containment** | R1, R2 | 1 den | Ano — stop future bleeding |
| **Sprint 2 — Relay Activation** | R3, R4 | 1,5 dne | Ano — main app už bez direct |
| **Sprint 3 — BFF Consolidation** | R5, R6 | 2 dny | Ano — BFF bez duplicit |
| **Sprint 4 — Hard Lockdown** | R7, R8a, R8b | 1,5 dne | Ano — síťová + runtime defense |
| **Sprint 5 — Recovery** | R8c | 1 den + 7 dní | Paralelně |

**Celkem:** ~6 dní active dev + 7 dní warmup = 13 kalendářních dní. **(V1 měl 16.)**

**Kritická cesta:** R2 → R4 → R5 → R8b. R3 musí před R5. R7 paralelně s R5/R6.

---

## Co tento plán **není**

- **Není** rewrite proxy pool — `RotatingProxyTransport` v `anti-trace-relay` zůstává as-is
- **Není** rewrite privacy-gateway SMTP deliveru — privacy-gateway zůstává as-is (řeší to `PRIVACY-MAIL-GATEWAY-RESTORATION.md`)
- **Není** nový `smtp-egress-gateway` service — anti-trace-relay už tuto roli plní
- **Není** změna DB schemy pro `password` + `proxy_url` — v2 nechává kde jsou; když BFF tam nebude sahat přímo (R5) je to dostačující. DB-role split necháváme jako follow-up.

---

## Závislosti

- `PRIVACY-MAIL-GATEWAY-RESTORATION.md` — R1-R8 restoration plán pro privacy-gateway. Pokud ještě není dokončen, přidat jako prereq pro R5/R8c kde reálně posíláme přes chain.
- `MAILBOXES-SELF-HEALING-SPRINTS.md` — self-heal rules zůstávají v BFF (R5 kompat — BFF má data, jen zdroj probe přesměruje)
- `MAILBOXES-PROTECTION-VERIFICATION-SPRINTS.md` — L3 protection probes (12 layers × 2 levels). Po R5 `proxy_pool` L2/L3 probe volá `/v1/proxy-pool` relay.

---

## Rizika & mitigace (revised)

| Riziko | P | Dopad | Mitigace |
|---|---|---|---|
| Relay `/v1/probe` schema drift od BFF | Vysoké | Střední | Contract test v R3 před deletion v R5 |
| Privacy-gateway `DELIVERY_MODE=record-only` default znamená nic se neodešle | Střední | Vysoký | Ověřit v R4 že prod startup nastaví `DELIVERY_MODE=live` |
| Anti-trace-relay latence | Nízké | Střední | HTTP keep-alive + connection pool; benchmark v R5 |
| DNS blackhole rozbije lokalní dev | Střední | Nízký | Docker-compose override pro dev má full DNS; blackhole jen v production Dockerfile |
| Railway egress rules neexistují na current tier | Střední | Vysoký | R8b fallback iptables; pokud ani to ne, migrate to Fly.io / Hetzner |
| Warmup pomalý → kampaň delay | Vysoké | Střední | Akceptovat |
| Existing 116 relay testů fail po R7 guard | Nízké | Nízký | Test setup: guard allowlist všech test-proxy addr |

---

## Success criteria (Definition of Done)

1. ✅ `grep -rE '(net|tls)\.(connect|createConnection|Dial|DialContext|SendMail)' features/platform/outreach-dashboard/server.js features/platform/outreach-dashboard/src/lib/emailProbe.js modules/outreach/internal/sender/engine.go modules/outreach/internal/validation/smtp_probe.go | grep -iE '(smtp|imap|:465|:587|:993|:25|:143)'` → prázdné
2. ✅ `engine.go` panic při `antiTrace==nil`
3. ✅ BFF `server.js` **neobsahuje** `smtpCheck`, `smtpAuthProbe`, `proxyCache`, `refreshProxyPool`, `socks5Probe`, `SocksClient`
4. ✅ `features/platform/outreach-dashboard/package.json` bez `socks` dependency
5. ✅ Pre-commit hook blokuje reintroduction (fixture test)
6. ✅ Relay runtime guard panic + alert při direct bypass attempt
7. ✅ DNS blackhole v BFF + Go main app kontejnerech (`dig smtp.seznam.cz` → 127.0.0.1)
8. ✅ `pnpm report` RTH 100 % (24/24 probes green) po R8c warmup
9. ✅ `go test ./... && pnpm test` zelené
10. ✅ `auth_fail_count=0` na všech active mailboxech po 72h na nové IP

---

## Commit convention

- Branch: `wm/egress-lockdown`
- Formát: `<type>(<scope>): <popis> (R<N>)` kde scope = `anti-trace-relay|bff|outreach|infra|.githooks`
- Jedna PR per sprint na `main`

---

## Otevřené otázky

1. **Email verification v production:** opravdu potřebujeme `smtp_probe.go` RCPT-TO živou? Alternativa: rely on bounce signal (post-send). → rozhodnout v R6.
2. **Privacy-gateway `DELIVERY_MODE`:** kdo spouští prod na `live`? → ověřit current railway env před R4.
3. **Railway egress rules tier:** podporuje aktuální plán? → research před R8b.
4. **Gateway DB-role split:** chceme `password` oddělit od BFF view už teď, nebo follow-up plan? → follow-up po R5.

---

## Reference

- Incident: konverzace 2026-04-21 (direct probe z lokální IP)
- `docs/playbooks/PRIVACY-MAIL-GATEWAY-RESTORATION.md` (sesterský plán)
- `docs/playbooks/MAILBOXES-SELF-HEALING-SPRINTS.md`
- `docs/playbooks/MAILBOXES-PROTECTION-VERIFICATION-SPRINTS.md`
- Audit výstupy: code search 2026-04-21 (v `SMTP-EGRESS-LOCKDOWN-AUDIT.md` po R1)
