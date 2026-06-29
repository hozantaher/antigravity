# Mail Lab — Operator Quickstart

> **Aktualizováno**: 2026-05-05 (ML1.7 — unbound DNS ML1.2 + Roundcube ML1.3 shipped; port 28080)

**Co to je:** lokální stack co se chová **neodlišitelně od reálného Seznamu / Gmailu / Outlooku**. Postaven na Postfix + Dovecot + Rspamd + OpenDKIM. Vyvíjíme i testujeme proti němu, **nikdy** proti prod.

**Proč existuje:** "funguje lokálně" → fail v prod, protože greenmail/mailpit accept everything. Mullvad IPs jsou rejectovány Seznamem (memory `seznam_proxy_geo_mismatch`); předtím jsme to nikdy lokálně neviděli, protože greenmail nikoho nereject. Mail Lab simuluje real-world acceptance pravidla, takže rate-limit / DKIM / spam-filter selhání chytíme dřív než v prod.

**Initiative:** [`docs/initiatives/2026-04-29-mail-lab.md`](../initiatives/2026-04-29-mail-lab.md)

---

## Prerekvizity

| Nástroj | Minimální verze | Poznámka |
|---------|-----------------|----------|
| Docker Desktop | 4.x | daemon musí běžet (`docker info`) |
| docker compose | plugin v2 | `docker compose version` |
| `swaks` | libovolná | `brew install swaks` (macOS) — pro smoke testy |
| `curl` | libovolná | obvykle přítomen |

Volné porty na hostu: `:25025`, `:25587`, `:25143`, `:28080`, `:8090`.

---

## Quick start

```bash
# Z čisté mašiny (poprvé image pull ~500MB):
bash scripts/mail-lab/up.sh

# → 60-90s startup → 7 schránek seedovaných na seznam.lab
# → admin API běží na :8090
```

Stack po up:

| URL | Čemu slouží |
|---|---|
| `localhost:25025` | SMTP plain (test send přímo z curl/swaks) |
| `localhost:25587` | SMTP submission (auth) |
| `localhost:25143` | IMAP plain |
| `http://localhost:8090/healthz` | mail-lab-api liveness |
| `http://localhost:28080` | Roundcube webmail (ML1.3) |

Demo creds (test-only, **nikdy** v prod):

| Adresa | Heslo | Role |
|---|---|---|
| `postmaster@seznam.lab` | `lab-demo-only` | bootstrap admin |
| `operator@seznam.lab` | `lab-demo-only` | operátor (orchestrator výstupy) |
| `prospect[1-5]@seznam.lab` | `lab-demo-only` | testovací příjemci |

Tear down:

```bash
bash scripts/mail-lab/down.sh           # stop, volumes preserve
bash scripts/mail-lab/down.sh --clean   # full wipe
```

---

## Admin API katalog

`mail-lab-api` (Go REST, port 8090). Auth: `X-Lab-Api-Key: dev-only` (default).

### Health

```bash
curl http://localhost:8090/healthz
# {"status":"ok","uptime_seconds":42}
```

### Vytvořit schránku

```bash
curl -X POST http://localhost:8090/v1/mailbox \
  -H "X-Lab-Api-Key: dev-only" \
  -H "Content-Type: application/json" \
  -d '{"address":"alice@seznam.lab","password":"hunter2"}'
# 201 Created + Location: /v1/mailbox/alice@seznam.lab
# 409 pokud existuje (idempotent skip)
# 400 pro invalid email / unsupported domain
```

### Číst schránku

```bash
curl http://localhost:8090/v1/mailbox/alice@seznam.lab \
  -H "X-Lab-Api-Key: dev-only"
# {"address":"alice@seznam.lab","domain":"seznam.lab"}
# 404 pokud neexistuje
```

### Smazat schránku

```bash
curl -X DELETE http://localhost:8090/v1/mailbox/alice@seznam.lab \
  -H "X-Lab-Api-Key: dev-only"
# 204 No Content
```

### Listing zpráv (ML2 — TODO)

`GET /v1/mailbox/:addr/messages` — zatím neimplementováno. Zatím se musí
inspectnout přes Roundcube webmail nebo `docker exec mail-lab-seznam ...`.

---

## Common workflows

### Pošlat test mail

```bash
swaks --to prospect1@seznam.lab \
      --from operator@seznam.lab \
      --auth LOGIN \
      --auth-user operator@seznam.lab \
      --auth-password lab-demo-only \
      --server localhost:25587 \
      --header 'Subject: Hello from lab'
```

### Stáhnout zprávy přes IMAP

```bash
# Kontejnerově (drill ekvivalent pro IMAP):
docker exec mail-lab-seznam doveadm fetch -u prospect1@seznam.lab \
  'subject body' all
```

### Inspektovat schránku přes Roundcube *(po ML1.3)*

1. Otevři `http://localhost:28080` v prohlížeči.
2. Login: `operator@seznam.lab` / `lab-demo-only` (nebo libovolný prospect).
3. Inbox + Compose UI stejné jako prod webmail klient.

Poznámka: DNS resolver labu (unbound, ML1.2) není namountovaný do hostu. Pro přístup přes `http://webmail.seznam.lab` přidat do `/etc/hosts`:
```
127.0.0.1  webmail.seznam.lab
```

### Reset demo dat

```bash
bash scripts/mail-lab/down.sh --clean
bash scripts/mail-lab/up.sh
# → fresh stack se 7 schránkami za 60-90s
```

---

## Připojení orchestrator/dashboard k labu

*(Wiring landne v ML4. Tento odstavec je dnes manual.)*

```bash
# orchestrator dev profile:
export DATABASE_URL="postgres://outreach:outreach@localhost:5433/outreach?sslmode=disable"
export SMTP_HOST="mx.seznam.lab"          # resolveruje přes lab DNS po wiring
export SMTP_PORT=587
export IMAP_HOST="imap.seznam.lab"
export IMAP_PORT=143
export OUTREACH_API_KEY="..."

cd features/inbound/orchestrator && go run ./cmd/outreach server
```

Dnes (před ML4 DNS wiring) musíš ručně přidat lab IPs do `/etc/hosts`:

```bash
echo "127.0.0.1  mx.seznam.lab imap.seznam.lab webmail.seznam.lab" \
  | sudo tee -a /etc/hosts
```

ML4 přepojí dashboard `.env.lab.example` + orchestrator `--dns-resolver`
flag tak, že se to bude dít automaticky.

---

## Troubleshooting

### `wait-healthy timeout` při up.sh

```
mail-lab-seznam: wait-healthy timeout
```

Důvody:
1. **První pull pomalý** (~500MB image) — vysledek timeout 5 min při slabém netu. Re-run obvykle pomůže (image už cached).
2. **Volume corruption** — někdy po hard reboot `mail-lab-seznam-state` má rozbitý postfix config. Fix: `bash scripts/mail-lab/down.sh --clean && bash scripts/mail-lab/up.sh`.
3. **Postfix nestartne kvůli chybějícímu accountu** — pre-seeded `postmaster@seznam.lab` v `infra/mail-lab/seznam/postfix-accounts.cf` musí být mountnutý jako compose `config:`. Pokud edituješ compose pozor na regression.

### DNS resolution selhává

```bash
docker exec mail-lab-dns drill mx.seznam.lab @127.0.0.1
# → status: NOERROR + 10.20.0.10
```

Pokud SERVFAIL: zkontroluj že `mail-lab-dns` je healthy. Pokud REFUSED: zkontroluj `access-control` ve `infra/mail-lab/dns/unbound.conf`.

### DKIM signing selhává

```bash
docker exec mail-lab-seznam opendkim-testkey -d seznam.lab -s mail \
  -k /tmp/docker-mailserver/opendkim/keys/seznam.lab/mail.private
# Expected: "key OK"
```

ML1.4 generates klíče do `infra/mail-lab/dkim/<domain>/`. Pokud chybí, run `bash scripts/mail-lab/init-dkim.sh seznam.lab gmail.lab outlook.lab`.

### mail-lab-api 401

API key default `dev-only`. Override:

```bash
export LAB_API_KEY="my-custom-key"
bash scripts/mail-lab/up.sh
# následně každý curl: -H "X-Lab-Api-Key: my-custom-key"
```

---

## Known limitations (ne 1:1 s prod)

| Aspekt | Mail Lab | Real Seznam |
|---|---|---|
| DKIM klíče | Test-only, committed v repo | Per-tenant, secret |
| Reputation scoring | Vždy clean (žádný blacklist) | Komplexní reputační databáze |
| Greylisting | ML3.3 toggleable | Vždy aktivní pro neznámé sendery |
| SPF/DMARC | Validated, ale lab DNS only | Real DNS lookup |
| AV scan | Disabled (ne goal) | ClamAV / Sophos |
| TLS | Disabled v ML1 (lab je sealed) | Vyžadováno |

**Co tím získáš:** chování acceptance pravidel (rate limit, quota, bounce kódy, DKIM signing, MIME parsing). To hraje 90 % práce orchestrator/relay layeru. Zbytek (real reputation, anti-spam ML modely) jen synthetic monitoring v prod.

---

## Don't

- **Nikdy** nepřipojuj Mail Lab na real internet (`internal: true` na docker net + iptables OUTPUT DROP). Pokud to obejdeš, hrozí spam ven na real Seznam IPs.
- **Nikdy** nereuse DKIM klíče nebo passwords z `infra/mail-lab/` v prod.
- **Nikdy** necommituj prod credentials do `infra/mail-lab/` (zatemňuje "test-only" guarantee).
- **Nikdy** nedávej `mail-lab-api` veřejně dostupné (běží na localhost only; `0.0.0.0` bind je za hranou).
