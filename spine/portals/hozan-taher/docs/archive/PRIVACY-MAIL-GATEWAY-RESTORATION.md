# Privacy-Mail-Gateway — Restoration Plán + Sprints

Plán pro **zpětnou integraci** `anti-trace-relay` (`:8090`) a `privacy-gateway` (`:8080`) do monorepa. Obě služby byly v commitu `de74c9d` (*chore(S1): extract privacy-gateway + anti-trace-relay → privacy-mail-gateway repo*) přesunuty ven. V repu zůstaly:

- **live reference v kódu:** `modules/outreach/internal/sender/antitrace.go`, `configDrift.js:anti_trace_misconfigured`, `staleGuard.js:anti_trace`, `/api/anti-trace/health`, `AnonymizationBar` UI, DB klíč `outreach_config.anti_trace_url`.
- **prázdné skelety adresářů** se dvěma zkompilovanými binárkami (žádné zdrojáky).

Cílový stav: `outreach-dashboard → BFF → modules/outreach (Go) → anti-trace-relay → privacy-gateway → náš SMTP (smtp.seznam.cz:465)`. **Žádný Fastmail** — máme vlastní ověřené SMTP mailboxy (`mazher.a@email.cz`, `a.mazher@email.cz`). Privacy-gateway routuje přímo přes naše credentials z `outreach_mailboxes`.

## Guiding principles

1. **Žádný rewrite.** Zdrojáky existují v `privacy-mail-gateway` repu; importujeme, neimplementujeme znovu.
2. **Record-only default.** Obě služby startují v `DELIVERY_MODE=record-only` — žádný mail neodchází, dokud operátor neschválí provoz.
3. **Náš SMTP, nikdy Fastmail.** `privacy-gateway` SMTP config se naplňuje z `outreach_mailboxes.smtp_*` sloupců, ne z hardcoded providerů.
4. **Reverzibilita.** 8 sprintů = 8 commitů; každý otočitelný, end-to-end flow neblokuje před R5.
5. **Fail-safe.** Výpadek relay/gateway → BFF fallback na přímý SMTP (existující `smtpSendWithFallback`).
6. **Audit trail.** Všechny relay attempts jdou do `watchdog_events` + `privacy-gateway`-owned `relay_attempts` tabulky.

## Současný stav (2026-04-20)

**Co je připraveno v monorepu (žije bez služeb):**
| Vrstva | Soubor | Stav |
|---|---|---|
| Go send klient | `modules/outreach/internal/sender/antitrace.go` | Funkční, volá `POST /v1/submit` když `AntiTrace.Enabled=true`. |
| Go engine větvení | `engine.go:293-323` | Send path větví anti-trace vs direct SMTP. |
| Go config | `config.go:26-31` | `AntiTraceConfig{Enabled, URL, Token, FromAddr}`. |
| Env surface | `ANTI_TRACE_URL`, `ANTI_TRACE_TOKEN`, `ANTI_TRACE_FROM` | Čte `main.go:2688`. |
| BFF health probe | `pingAntiTrace()` v `server.js:2376` | Hit `/healthz` s 5s timeout. |
| BFF endpoint | `GET /api/anti-trace/health` | Vrací `{ok, status_code, ms, url}`. |
| Drift detektor | `configDrift.js:62-73` | Check `anti_trace_misconfigured`. |
| Stale guard | `staleGuard.js:57-74` | 5 min TTL, auto-recovery re-ping. |
| UI | `AnonymizationBar` v `Mailboxes.jsx:892` | Pill OK/Vypnuto/DOWN. |
| Score bonus | `ScoreBadge` v `Mailboxes.jsx:68` | `antiTraceOk` → +1 skóre. |
| DB config | `outreach_config.anti_trace_url` | Key existuje, value prázdná. |

**Co chybí:**
- Zdrojové soubory obou služeb (62,6K LOC).
- `go.work` deklarace (vráceno jen `./modules/outreach`).
- Docker compose stack (relay + tor sidecar + gateway).
- SMTP bridge mezi `privacy-gateway` a naším pool (`outreach_mailboxes`).
- Integrační test anti-trace → gateway → náš SMTP.

## Architektura cílového stavu

```
┌──────────────────────────────────────────────────────────────────────┐
│  outreach-dashboard (React, :5175)                                   │
│   └─ AnonymizationBar ukazuje status anti-trace + gateway            │
└───────────────────────────┬──────────────────────────────────────────┘
                            │  /api/anti-trace/health, /api/campaigns/*
                            ↓
┌──────────────────────────────────────────────────────────────────────┐
│  BFF Express (:3001)                                                 │
│   └─ pingAntiTrace, configDrift, staleGuard                          │
│   └─ /api/campaigns/run → forward to Go backend                     │
└───────────────────────────┬──────────────────────────────────────────┘
                            │  X-API-Key
                            ↓
┌──────────────────────────────────────────────────────────────────────┐
│  modules/outreach (Go, :8080 — POZOR, kolize portu! viz R2)          │
│   └─ sender.Engine.Send()                                            │
│      if AntiTrace.Enabled → antitrace.Client.Send() (HTTP POST)      │
│      else → direct SMTP via outreach_mailboxes                      │
└───────────────────────────┬──────────────────────────────────────────┘
                            │  POST /v1/submit  (Bearer token)
                            ↓
┌──────────────────────────────────────────────────────────────────────┐
│  anti-trace-relay (Go, :8090)                                        │
│   └─ sanitize → identity-separate → seal (AES-GCM)                   │
│   └─ schedule (random delay min-max) → Tor SOCKS5 dial               │
└───────────────────────────┬──────────────────────────────────────────┘
                            │  POST /v1/intake/submissions (intake token)
                            │  (via Tor sidecar 172.28.0.10:9050)
                            ↓
┌──────────────────────────────────────────────────────────────────────┐
│  privacy-gateway (Go, :8081 — přečíslováno viz R2)                   │
│   └─ unseal → policy check → mail.SMTPGateway                        │
│   └─ SMTP creds pulled from outreach_mailboxes via bridge API        │
└───────────────────────────┬──────────────────────────────────────────┘
                            │  SMTP 465 STARTTLS AUTH PLAIN
                            ↓
                    smtp.seznam.cz (náš provider)
```

**Port konflikt k vyřešení v R2:** `modules/outreach` (Go) i původní `privacy-gateway` chtějí `:8080`. Plán: `privacy-gateway` přesouváme na `:8081`.

## 8 Sprintů

### R1 — Import zdrojáků ze `privacy-mail-gateway`

**Cíl:** Dostat 62K LOC zpět do repa bez přepsání jediného řádku.

**Rozhodovací bod:** submodule vs hard-copy.
- **(A) Submodule** (`git submodule add <url> services/privacy-mail-gateway`): zachovaná historie, ale vyžaduje udržovat 2 repa.
- **(B) Subtree merge** (`git subtree add --prefix services/privacy-mail-gateway <url> main`): historie importnuta, jedno repo, žádný sync.
- **(C) Checkout z historie** (`git checkout de74c9d~1 -- features/outreach/anti-trace-relay features/compliance/privacy-gateway`): žádná externí závislost; starý stav z dubna 2026, bez updates z externího repa.

**Doporučení: (C) checkout**, pokud externí repo nemá žádné novější commity. Ověřit `gh repo view privacy-mail-gateway --json pushedAt` před rozhodnutím.

**Kroky:**
1. `git log --oneline de74c9d~1 -- features/outreach/anti-trace-relay features/compliance/privacy-gateway | head -20` — ověřit co bylo last commit.
2. Rozhodnout A/B/C.
3. Smazat zbytky binárek + .DS_Store v `features/outreach/anti-trace-relay/` a `features/compliance/privacy-gateway/`.
4. Execute zvolenou cestu.
5. Ověřit kompletnost: `go.mod`, `cmd/*/main.go`, `internal/` packages, `Dockerfile`.

**Commit:** `chore(privacy): restore anti-trace-relay + privacy-gateway sources`

**Acceptance:**
- `ls features/outreach/anti-trace-relay/cmd/relay/main.go features/compliance/privacy-gateway/cmd/privacy-gateway/main.go` — oba existují.
- Minimálně 30 + 18 interních packages přítomno.

**Risk:** conflicts s existujícími `.DS_Store` a binárkami. **Mitigation:** `git rm -f features/outreach/anti-trace-relay/anti-trace-relay features/outreach/anti-trace-relay/relay features/outreach/anti-trace-relay/coverage.out` před import.

---

### R2 — go.work + port reassignment + build verification

**Cíl:** Oba Go moduly buildí lokálně, žádné konflikty portů.

**Kroky:**
1. `go.work`: přidat `use ./features/outreach/anti-trace-relay` + `use ./features/compliance/privacy-gateway`.
2. `features/compliance/privacy-gateway/cmd/privacy-gateway/main.go`: změnit default port `8080 → 8081` (vyhnout se kolizi s `modules/outreach`).
3. Update `features/compliance/privacy-gateway/.env.example`, `Dockerfile` healthcheck, `railway.toml`, kde se `8080` hardcoduje.
4. `go build ./...` v root — musí projít oba moduly.
5. `go test ./features/outreach/anti-trace-relay/... ./features/compliance/privacy-gateway/...` — existující test suite musí projít (nebo jen dokumentovat failures pro R8).

**Commit:** `chore(privacy): wire anti-trace-relay + privacy-gateway into go.work`

**Acceptance:**
- `go build ./features/outreach/anti-trace-relay/cmd/relay` produkuje binárku.
- `go build ./features/compliance/privacy-gateway/cmd/privacy-gateway` produkuje binárku.
- Žádný port `:8080` konflikt v `main.go` souborech.

---

### R3 — privacy-gateway minimální run (record-only)

**Cíl:** Gateway startuje, `/healthz` odpovídá 200, žádný skutečný SMTP outbound.

**Kroky:**
1. Vytvořit `features/compliance/privacy-gateway/.env.local` s `DELIVERY_MODE=record-only`, `LISTEN_ADDR=:8081`, `DEV_API_TOKEN`, `DATA_ENCRYPTION_KEY_B64` (generovat `openssl rand -base64 32`).
2. `go run ./features/compliance/privacy-gateway/cmd/privacy-gateway` — lokální spuštění.
3. Smoke: `curl http://localhost:8081/healthz` → 200.
4. Smoke: `curl -XPOST -H "Authorization: Bearer $DEV_API_TOKEN" -d '{...}' /v1/submissions` → `accepted`, status `record_only`.
5. Ověřit že na disku vzniká JSON archív submission (ale žádný SMTP outbound).
6. Přidat spouštěcí skript `features/compliance/privacy-gateway/scripts/dev-up.sh`.

**Commit:** `feat(privacy-gateway): minimal record-only runtime`

**Acceptance:**
- BFF configDrift check `anti_trace_misconfigured` **stále fires warning** (anti-trace ještě neběží — správně).
- Health endpoint `/healthz` stable ≥ 60s.
- Žádný outbound SMTP traffic (tcpdump potvrdí nebo logy `delivery_mode=record_only`).

---

### R4 — anti-trace-relay minimální run (direct transport)

**Cíl:** Relay startuje, přijímá submission, forwarduje do gateway (R3).

**Kroky:**
1. Vytvořit `features/outreach/anti-trace-relay/.env.local`:
   - `LISTEN_ADDR=:8090`
   - `DATA_ENCRYPTION_KEY_B64`, `VAULT_ENCRYPTION_KEY_B64` (`openssl rand -base64 32` × 2)
   - `DEV_API_TOKEN` (sdílený token z BFF)
   - `DELIVERY_MODE=bridge` (forward do gateway)
   - `BRIDGE_GATEWAY_URL=http://localhost:8081`
   - `BRIDGE_INTAKE_TOKEN` (match s `INTAKE_API_TOKEN` v gateway)
   - `SOCKS_PROXY=` (prázdný = direct transport, Tor přidáme v R7)
   - `INSECURE_TLS=true` (dev only)
2. `go run ./features/outreach/anti-trace-relay/cmd/relay` — lokální spuštění.
3. Smoke: `curl http://localhost:8090/healthz` → 200.
4. Smoke: `curl -XPOST -H "Authorization: Bearer $DEV_API_TOKEN" -d '{"recipient":"test@example.com","subject":"smoke","body":"x","fromAddress":"a.mazher@email.cz"}' /v1/submit` → `accepted` + schedule ID.
5. Ověřit že po ~`RELAY_MIN_DELAY_SECONDS` se submission objeví v gateway's `/v1/intake/queue`.

**Commit:** `feat(anti-trace-relay): minimal bridge runtime`

**Acceptance:**
- End-to-end relay → gateway bridge: submission accepted v relay, appears in gateway intake queue do 60s.
- BFF `pingAntiTrace` vrací `{ok: true, status_code: 200}` po nastavení `outreach_config.anti_trace_url=http://localhost:8090`.
- `AnonymizationBar` v UI přepne z "Vypnuto" na "OK · Xms".

---

### R5 — BFF + Go backend wire-up (bez SMTP outboundu)

**Cíl:** Reálný send path přes UI → BFF → Go engine → relay → gateway, **ale stále record-only**, žádný mail nikam nejde.

**Kroky:**
1. `UPDATE outreach_config SET value='http://localhost:8090' WHERE key='anti_trace_url'` v DB.
2. Přidat DB konfigurační klíče (pro relay token):
   ```sql
   INSERT INTO outreach_config (key, value) VALUES
     ('anti_trace_token', '<DEV_API_TOKEN>'),
     ('anti_trace_from',  'a.mazher@email.cz');
   ```
3. Rozšířit `pingAntiTrace` aby vedle `/healthz` četl i `/v1/status` (capacity + backlog).
4. Rozšířit `AntiTraceConfig` v Go o čtení z DB (ne jen env) — fallback pattern `ANTI_TRACE_URL env → outreach_config → disabled`.
5. Spustit testovací kampaň v UI proti mock recipient `test@example.com` s jedním mailboxem a `AntiTrace.Enabled=true` v Go config.
6. Ověřit v gateway logu že submission prošla full pipeline ale `delivery_mode=record_only`.

**Commit:** `feat(bff): wire anti-trace pipeline end-to-end (record-only)`

**Acceptance:**
- Testovací kampaň doběhne do stavu `relayed` bez skutečného SMTP connect.
- `healing_log` obsahuje `relay_attempt` entry s `delivery_boundary=internal_store_and_forward`.
- UI status v `AnonymizationBar` zelený.
- Manuální vypnutí relay (`kill`) → BFF degraded banner do 10s (díky `staleGuard`).

---

### R6 — SMTP bridge z gateway k našemu `outreach_mailboxes`

**Cíl:** Gateway posílá reálný mail přes naše SMTP (`smtp.seznam.cz:465`), credentials tahá dynamicky z Postgres.

**Proč ne Fastmail:** Máme vlastní ověřené mailboxy (`mazher.a@email.cz`, `a.mazher@email.cz`). Žádný externí provider.

**Kroky:**
1. V `privacy-gateway` přidat nový config resolver `PostgresSMTPResolver` (nový package `features/compliance/privacy-gateway/internal/smtpresolver/`).
2. `Resolver.ResolveFor(fromAddress) (SMTPConfig, error)` — query na `outreach_mailboxes WHERE from_address=$1 AND status='active'`.
3. `mail.SMTPGateway` upravit aby při každém sendu zavolal resolver místo statické env konfigurace.
4. Env: `SMTP_CONFIG_SOURCE=postgres` (default) / `env` (legacy/test).
5. `DATABASE_URL` v `privacy-gateway` env (read-only access postačí).
6. Switch `DELIVERY_MODE=smtp` v `.env.local` gateway.
7. Live smoke: pošli reálný mail na `dankrul.krul@gmail.com` přes UI kampaň → čekej doručení.

**Commit:** `feat(privacy-gateway): pull SMTP creds from outreach_mailboxes`

**Acceptance:**
- Single email delivered end-to-end přes relay → gateway → seznam.cz → Gmail, received < 5 min.
- `relay_attempts` row: `status=sent, delivery_boundary=trusted_delivery_boundary, provider=seznam`.
- Žádný hardcoded SMTP config ve zdrojácích privacy-gateway (grep test).
- `outreach_mailboxes.total_sent` inkrementován.

---

### R7 — Anonymous transport via shared proxy pool (Tor skip)

**Cíl:** Produkční anonymizace přes náš existující `proxyCache` (CZ+neighbours), **žádný Tor**.

**Proč ne Tor:** `seznam.cz` blokuje Tor exit nodes (reputation). Náš proxy pool je CZ+sousední, IP-rotační, seznam-friendly.

**Kroky:**
1. BFF nový endpoint `GET /api/proxy-pool/next` → vrátí `{addr, country, latency_ms}` z `proxyCache.working`, round-robin s blacklist respektem.
2. Rozšířit relay `transport/socks5.go`: nový `PooledSOCKS5Transport` který na každý dial zavolá `PROXY_POOL_URL` a použije vrácený SOCKS5 addr.
3. Relay env: `TRANSPORT_MODE=pooled_socks5`, `PROXY_POOL_URL=http://bff:3001/api/proxy-pool/next`.
4. **Fail-closed:** pokud pool vrátí 404/empty → relay pozastaví submissions, nepadne do direct dial.
5. Nový drift check v BFF: `relay_proxy_transport_down` (severity: `critical` if `TRANSPORT_MODE=pooled_socks5` a pool<3).

**Commit:** `feat(privacy): anonymous transport via shared proxy pool`

**Acceptance:**
- Submission dial prochází přes proxy z `proxyCache.working` (ověř přes relay logs).
- Kill proxy pool (pool=0) → relay přestane doručovat, žádný bypass.
- Recipient `Received:` header ukazuje proxy exit IP, ne local IP.

---

### R8 — Testy + CI integrace

**Cíl:** Existující test suite z obou služeb běží v monorepo CI, nové contract testy pro náš send pipeline.

**Kroky:**
1. `.github/workflows/go-services-ci.yml`: přidat matici `matrix.module: [modules/outreach, features/outreach/anti-trace-relay, features/compliance/privacy-gateway]`.
2. Opravit failing testy po portu přejmenování (R2 může nabourat hardcoded `:8080` v tests).
3. Nový contract test `modules/outreach/internal/sender/antitrace_contract_test.go` — spustí dočasnou relay mock + ověří že `AntiTraceClient.Send()` produkuje validní submission.
4. E2E Playwright test `features/platform/outreach-dashboard/test/e2e/anti-trace-pipeline.spec.ts` — UI campaign → čekej `relay_attempts` row.
5. Coverage gate: `features/outreach/anti-trace-relay` ≥ 70%, `features/compliance/privacy-gateway` ≥ 70% (nižší než v jejich původním repu kvůli rychlé restauraci; zpřísníme postupně).

**Commit:** `test(privacy): monorepo CI for anti-trace-relay + privacy-gateway`

**Acceptance:**
- CI green všechny 3 Go moduly.
- E2E test doběhne do `relayed` status.
- Coverage report uploaded.

---

## Priority table

| # | Sprint | Blocker pro | Reverzibilita | LOC | ETA |
|---|---|---|---|---|---|
| R1 | Import zdrojáků | R2-R8 | trivial (git revert) | ~62K import | 30 min |
| R2 | go.work + porty | R3-R8 | trivial | ~50 změn | 1h |
| R3 | gateway record-only | R5 | trivial | ~20 env + script | 1h |
| R4 | relay bridge | R5 | trivial | ~20 env + script | 1h |
| R5 | end-to-end record | R6 | trivial (flip `Enabled=false`) | ~100 Go + JS | 2h |
| R6 | SMTP bridge | R7 | medium (delete smtpresolver pkg) | ~200 Go | 3h |
| R7 | Tor sidecar | R8 | easy (compose down) | ~100 YAML | 2h |
| R8 | Testy + CI | — | trivial | ~400 test | 3h |

**Total:** ~13h intenzivní práce, 8 commitů.

## Red lines / rizika

- **R6 live SMTP test**: první reálný outbound; musí jít přes mailbox s `status='active' AND canary_remaining>0` aby spotřeboval canary slot, ne ostrou warmup kvótu.
- **R7 proxy pool dependency**: pokud pool padne pod 3 working, relay přestane odesílat. To je žádoucí (fail-closed), ale operátor musí vidět drift banner.
- **R1 historical checkout** může přinést zastaralý kód, který nebude kompatibilní s aktuálním go.work / Go verzí. Fallback: subtree merge z externího repa (pokud existuje).
- **Port :8080 kolize**: `modules/outreach` to má jako default. `privacy-gateway` přesouváme na `:8081` — nesmí se zapomenout update Dockerfile healthcheck + jakékoliv k8s/railway probe.
- **DB schema:** `privacy-gateway` používá file-based JSON storage (ne Postgres). Nedávejte ji do stejného Postgres jako outreach — audit/relay_attempts zůstávají file-based dokud nedosáhneme >10K rows (viz ADR-005 privacy-gateway).

## Acceptance pro celý plán

Po R8:
- [ ] `docker-compose -f infra/docker/docker-compose.privacy.yml up` startuje relay + gateway (bez Tor).
- [ ] UI kampaň → reálný mail na `dankrul.krul@gmail.com` přes shared proxy pool → seznam.cz.
- [ ] `/api/anti-trace/health` zelený, `AnonymizationBar` = "OK · <100ms".
- [ ] `configDrift.js` žádné critical po bootu ani za 10 min.
- [ ] CI matrix green (3 moduly).
- [ ] `AntiTrace.Enabled=false` v Go config → fallback na přímý SMTP funguje (backwards compat).
- [ ] `healing_log` + `relay_attempts` obsahují trail pro každý send.
