# KT-A3 — Railway deploy BFF + UNSUBSCRIBE_BASE_URL

> **Sprint:** KT-A3 (GH issue #297)
> **Status:** připraveno k execution. Operátor (Tomáš) deployne BFF + nastaví env vars.
> **Doba:** 30 min (15 min deploy + 15 min smoke test)
> **Předpoklad:** Railway projekt existuje + Tomáš má přístup do Railway dashboardu / `railway` CLI nainstalovaný.

Tento playbook pokrývá produkční deploy `features/platform/outreach-dashboard` BFF na Railway tak, aby `{{.UnsubURL}}` v patičce každého emailu trefil reálnou veřejně dostupnou URL (ne `localhost`). Bez toho je každý email v kampani nelegální (Art. 21 GDPR — funkční opt-out gate).

---

## 1. Co BFF dělá v produkci

| Funkce | Endpoint | Důvod proč musí být public |
|---|---|---|
| Unsubscribe link | `GET /unsubscribe?c=&id=&t=` | Recipient klikne na link v patičce; potřebuje veřejnou URL |
| DSR endpoints | `GET /api/dsr/access`, `POST /api/dsr/erasure` | GDPR Art. 15 + 17 — operátor obsluhuje requesty |
| Sentry tunnel | `POST /sentry-tunnel` | Browser Sentry events když ad-blocker zachytí přímý sentry.io |
| Health | `GET /api/health` | Railway healthcheck, externí monitoring |
| Operátorský dashboard | `GET /` (Vite build) | Tomáš obsluhuje kampaň |

Sender engine (`features/outreach/campaigns`) volá `buildUnsubURL()` v `runner.go:806`, který produkuje URL ve formátu `{UNSUBSCRIBE_BASE_URL}/unsubscribe?c=...&id=...&t=...`. Pokud env var chybí, default je `https://garaaage.cz` — to ale neukazuje na živý BFF.

---

## 2. Předpoklady (před deployem)

- [ ] Railway projekt existuje a má service `outreach-dashboard` (railway.toml v `features/platform/outreach-dashboard/` ho odkazuje)
- [ ] Railway PostgreSQL plugin attached → `DATABASE_URL` available
- [ ] Custom domain je buď vlastní (`outreach.garaaage.cz`) nebo Railway-vygenerovaný (`outreach-dashboard-production-XXXX.up.railway.app`)
- [ ] DNS A/CNAME zaznamenán u registrátora doménového jména (jen pokud custom domain)
- [ ] Anti-trace-relay je už nasazený a healthy (`railway status --service anti-trace-relay`)
- [ ] Go orchestrator je nasazený (`features/inbound/orchestrator/`) — BFF na něj proxuje přes `GO_SERVER_URL`

---

## 3. Required env vars (production boot)

Tabulka pochází z `features/platform/outreach-dashboard/server.js` (greptem `process.env.*`) + service-local `features/platform/outreach-dashboard/CLAUDE.md`. Hodnoty jsou indikativní — operátor doplní reálné.

| # | Env var | Mandatory | Příklad / source | Účel |
|---|---|---|---|---|
| 1 | `DATABASE_URL` | **MUST** | injectován Railway PG plugin | hlavní DB pool |
| 2 | `OUTREACH_API_KEY` | **MUST** | shodné s Go service env | autentikace BFF↔Go + interní X-API-Key gate |
| 3 | `GO_SERVER_URL` | **MUST** | `http://orchestrator.railway.internal:8080` | Railway internal DNS, BFF proxuje na Go |
| 4 | `UNSUBSCRIBE_BASE_URL` | **MUST** | `https://outreach.garaaage.cz` (nebo Railway public URL bez trailing slash) | base URL pro `{{.UnsubURL}}` v patičkách emailů |
| 5 | `UNSUBSCRIBE_SECRET` | optional | 64+ char random (`openssl rand -hex 32`) | HMAC token secret; fallback `OUTREACH_API_KEY` pokud chybí |
| 6 | `MAILBOX_SECRET_KEY` | optional (S5) | 64 char hex (`openssl rand -hex 32`) | dešifrování `outreach_mailboxes.password_encrypted` (uloženo v 1Password) |
| 7 | `ANTI_TRACE_RELAY_URL` | **MUST** pro send | `https://anti-trace-relay-production.up.railway.app` | URL anti-trace relaye (HARD RULE: bez něj se nesmí posílat) |
| 8 | `ANTI_TRACE_RELAY_TOKEN` | **MUST** pro send | shodné s relay env | autentikace BFF↔relay |
| 9 | `CORS_ORIGIN` | recommended | `https://outreach.garaaage.cz` | omezení CORS na produkční origin |
| 10 | `SENTRY_DSN_BFF` | recommended | DSN z Sentry projektu | error reporting; bez něj boot OK ale crashe se ztrácí |
| 11 | `NODE_ENV` | recommended | `production` | aktivuje `safeError()` redaction |
| 12 | `PORT` | injectován Railway | (default 18001 v devu) | Railway healthcheck cílí přes přidělený PORT |
| 13 | `BFF_AUTH_DISABLED` | **NESMÍ** být `1` | — | rate-limit bypass; produkce vždy s auth on |
| 14 | `FAULT_INJECT_ALLOWED` | **NESMÍ** být `1` | — | umožní X-Fault headerem injektovat 500/503; jen test |

**Bez 1–4 + 7–8 BFF nabootuje, ale send pipeline selže nebo unsubscribe linky budou dead.**

---

## 4. Set env vars (Railway CLI)

```bash
# Login pokud ještě:
railway login

# Vyber správný projekt:
railway link

# Pre-flight: jaký už je env stav?
railway variables --service outreach-dashboard | sort

# Mandatory:
railway variables --service outreach-dashboard --set 'OUTREACH_API_KEY=<paste>'
railway variables --service outreach-dashboard --set 'GO_SERVER_URL=http://orchestrator.railway.internal:8080'
railway variables --service outreach-dashboard --set 'UNSUBSCRIBE_BASE_URL=https://outreach.garaaage.cz'  # bez trailing slash
railway variables --service outreach-dashboard --set 'ANTI_TRACE_RELAY_URL=https://anti-trace-relay-production.up.railway.app'
railway variables --service outreach-dashboard --set 'ANTI_TRACE_RELAY_TOKEN=<paste>'

# Recommended:
railway variables --service outreach-dashboard --set 'CORS_ORIGIN=https://outreach.garaaage.cz'
railway variables --service outreach-dashboard --set 'NODE_ENV=production'
railway variables --service outreach-dashboard --set 'UNSUBSCRIBE_SECRET='"$(openssl rand -hex 32)"
railway variables --service outreach-dashboard --set 'SENTRY_DSN_BFF=<DSN>'
```

> **Před každým `--set` zkontroluj, že do shellu/historie nejde citlivá hodnota.** Můžeš použít `read -s` interakci, nebo Railway dashboard UI místo CLI.

---

## 5. Volba `UNSUBSCRIBE_BASE_URL`

Tři varianty, vyber jednu:

### A. Custom doména `outreach.garaaage.cz` (doporučeno)
```
UNSUBSCRIBE_BASE_URL=https://outreach.garaaage.cz
```
- Plus: stabilní, branded, nezávislá na Railway redeploys
- Minus: vyžaduje DNS CNAME → Railway public URL + Railway domain attach

### B. Railway public URL
```
UNSUBSCRIBE_BASE_URL=https://outreach-dashboard-production-XXXX.up.railway.app
```
- Plus: hned funguje, nepotřebuje DNS
- Minus: ošklivá URL v patičce, recipienti se mohou polekat (vypadá jako spam)

### C. Apex `garaaage.cz` se zip-routou
```
UNSUBSCRIBE_BASE_URL=https://garaaage.cz
```
- Plus: shodné s Privacy URL
- Minus: vyžaduje, aby reverse-proxy (Cloudflare? Vercel?) routoval `/unsubscribe`, `/api/*` na BFF — vícekomponentový setup

**Doporučení:** A pokud máš čas pár hodin počkat na DNS propagaci. Jinak B jako bridge a A později.

---

## 6. Deploy command

```bash
# Z root repa, na branch chore/kt-a2-a4-operator-prep nebo main:
railway up --service outreach-dashboard

# Sleduj log:
railway logs --service outreach-dashboard --tail 200
```

Očekávaný boot:
```
[boot] BFF listening on :PORT
[boot] DB pool initialized
[cron] schemaCheck duration_ms=...
[cron] endpointHitsFlush duration_ms=...
```

Pokud boot loop / restart:
- `Error: connect ECONNREFUSED ...:5432` → DATABASE_URL nesprávné nebo PG plugin nepřipojený
- `Cannot find module 'pg'` → npm install se nepustil; rebuild
- Healthcheck timeout → `/api/health` v 120s neodpoví; pravděpodobně DB pool wait

---

## 7. Smoke test (povinný před aktivací kampaně)

### 7.1 Health
```bash
export BFF_URL='https://outreach.garaaage.cz'   # nebo .up.railway.app URL

curl -sf "${BFF_URL}/api/health" | jq .
# očekávaný shape: {"status":"ok", "version":"...", ...}
```

Pokud non-200 nebo prázdný JSON → boot ještě nedokončil nebo DB pool nedostupný.

### 7.2 Unsubscribe URL forma
Vyrenderuj URL z release templatu (bez sendu):

```bash
# Build URL ručně podle runner.go:806 logiky:
CAMPAIGN=999
CONTACT=12345
EMAIL='test@example.cz'
SECRET="$UNSUBSCRIBE_SECRET"     # totéž co na Railway
TOKEN=$(printf '%s|%s|%s' "$CAMPAIGN" "$CONTACT" "$EMAIL" | \
        openssl dgst -sha256 -hmac "$SECRET" -binary | xxd -p -c 256 | cut -c1-16)

echo "${BFF_URL}/unsubscribe?c=${CAMPAIGN}&id=${CONTACT}&t=${TOKEN}"
```

Tato URL by neměla najít `contact_id=12345` a měla by vrátit 404 stránku "Kontakt nenalezen" — to je správně, znamená to, že route je live + BFF se pokusil dotázat DB.

### 7.3 Real unsubscribe (skutečný recipient ID, dry-run mode)
```bash
# Najdi reálný contact_id v DB:
psql "$DATABASE_URL" -c "SELECT id, email FROM contacts LIMIT 1;"
# uloz hodnoty
CONTACT=<id>
EMAIL=<email>
TOKEN=$(printf '%s|%s|%s' "$CAMPAIGN" "$CONTACT" "$EMAIL" | \
        openssl dgst -sha256 -hmac "$SECRET" -binary | xxd -p -c 256 | cut -c1-16)

# Otevři v prohlížeči:
echo "${BFF_URL}/unsubscribe?c=${CAMPAIGN}&id=${CONTACT}&t=${TOKEN}"
```

Očekávané:
- HTTP 200 + HTML stránka "Odhlášení proběhlo úspěšně" (jeden email v lifecycle — dále už recipient nedostane další emaily)
- Po refresh stránky stále HTTP 200 (idempotent)
- `SELECT * FROM suppression_list WHERE email='<recipient>'` vrátí 1 řádek
- `SELECT * FROM operator_audit_log WHERE action='unsubscribe_link' ORDER BY created_at DESC LIMIT 1` zachytí akci

> **POZOR:** test nemá probíhat na real recipientovi z eligible kampaně — vyber test contact, který už má suppression nebo není v žádné běžící kampani. Po testu DELETE z `suppression_list` pokud nechceš permanentně odhlásit.

### 7.4 Anti-trace relay reachable
```bash
curl -sf "${BFF_URL}/api/anti-trace/health" \
  -H "x-api-key: $OUTREACH_API_KEY" | jq .
# očekávaný: {"ok":true,"status":"healthy",...}
```

Pokud `error: "relay timeout"` → ANTI_TRACE_RELAY_URL je špatně, nebo relay sám neběží.

### 7.5 Go orchestrator reachable
```bash
curl -sf "${BFF_URL}/api/daemons" \
  -H "x-api-key: $OUTREACH_API_KEY" | jq '.dashboard'
# očekávaný: data daemon-counterů, ne {"error":"..."}
```

Pokud `error: "fetch failed"` → GO_SERVER_URL nesprávné nebo orchestrator down.

---

## 8. Rollback (kdykoli)

### A. Železný rollback (Railway UI)
Railway dashboard → service `outreach-dashboard` → Deployments → najdi předchozí stable deploy → **Redeploy**.

### B. CLI rollback
```bash
# Najdi předchozí deployment:
railway deployments list --service outreach-dashboard

# Redeploy:
railway redeploy <DEPLOYMENT_ID> --service outreach-dashboard
```

### C. Stop service (extreme)
Pokud BFF aktivně škodí (např. send tooling rozmlátí nějakou tabulku):
```bash
railway service pause outreach-dashboard
```
Sender engine bude bez BFF stejně dále číst přímo z DB; UI bude offline.

---

## 9. Done gate (uzavři issue #297)

- [ ] BFF nasazený, `${BFF_URL}/api/health` vrací 200
- [ ] `UNSUBSCRIBE_BASE_URL` env nastaveno (a shodné s `${BFF_URL}` host)
- [ ] Anti-trace relay reachable z BFF (`/api/anti-trace/health` ok)
- [ ] Smoke test 7.3 — unsubscribe link s real contact_id zápise do `suppression_list`
- [ ] `operator_audit_log` zachytil `unsubscribe_link` event
- [ ] Privacy URL (z KT-A2) je live a v patičce odpovídá realitě
- [ ] Žádný runtime error v Sentry během 30min po deployi

```
gh issue close 297 --comment "BFF deployed to ${BFF_URL}.
UNSUBSCRIBE_BASE_URL set to ${UNSUBSCRIBE_BASE_URL}.
Smoke test passed: /api/health ok, anti-trace reachable, unsubscribe DSR write OK.
Audit log entry: <link>"
```

---

## 10. Známé pasti

| Past | Symptom | Fix |
|---|---|---|
| `UNSUBSCRIBE_BASE_URL` má trailing slash | URL v emailu má `//unsubscribe` | env hodnota bez koncového `/` |
| `OUTREACH_API_KEY` jiný než Go service | `401 invalid api key` | sjednotit hodnotu mezi BFF a Go orchestrator |
| `GO_SERVER_URL` na public URL | Railway egress charge | použij `*.railway.internal` (private DNS) |
| BFF deployed, relay ne | Send pipeline nepustí, AUTH probe fails | nejprve relay, pak BFF |
| `DATABASE_URL` IPv6-only host | `connect ETIMEDOUT` | Railway PG plugin musí být v stejném regionu |
| Duplicate Sentry env (`SENTRY_DSN` vs `SENTRY_DSN_BFF`) | dvojí Sentry capture | použij jen `SENTRY_DSN_BFF` |

---

## 11. Reference

- `features/platform/outreach-dashboard/CLAUDE.md` — service-local stack + env doc
- `features/platform/outreach-dashboard/railway.toml` — Railway service config (healthcheck, start cmd)
- `features/platform/outreach-dashboard/server.js:300-358` — `/unsubscribe` route (HMAC validate + suppression cascade)
- `features/outreach/campaigns/campaign/runner.go:806` — `buildUnsubURL` HMAC formát
- `docs/playbooks/secret-rotation.md` — rotace `UNSUBSCRIBE_SECRET`, `OUTREACH_API_KEY`
- GH issue #297 — sprint definition
