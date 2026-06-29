# garaaage-auction

Aukce a prodej vozidel — **Nuxt 4 + Vue 3 + Tailwind v4**, 1:1 frontend port staré aplikace `auction24`. Backend běží na **Postgresu** (Kysely + `pg`) s **Firebase** autentizací (Bearer token). UI staví na `@headlessui/vue` + vlastních `Base*` komponentách (bez `@nuxt/ui`).

> Konvence, code style a architektura jsou v [`CLAUDE.md`](./CLAUDE.md).

## Požadavky

- **Node ≥ 22**, **pnpm 10**
- **PostgreSQL** (dev/prod běží na Railway; lokálně stačí jakákoliv PG instance)
- **Firebase projekt** `garaaage-auction24` (Authentication zapnuté, povolený Email/Password provider) — pro přihlašování
- **Docker** (jen pro integrační testy)

## Setup

```bash
pnpm install
cp .env.example .env          # a vyplň hodnoty (viz níže)
# Firebase Admin SDK service account (lokálně):
cp /cesta/k/service-account-garaaage-auction.json ./service-account.json
```

`.env` i `service-account.json` jsou **gitignored** — necommituj je.

### Env proměnné

| Proměnná                         | Popis                                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `POSTGRES_URL`                   | Connection string Postgresu (Railway/lokální).                                                                     |
| `POSTGRES_SSL`                   | `disable` pro lokální non‑SSL PG. Default = SSL zap. (Railway proxy).                                              |
| `GOOGLE_APPLICATION_CREDENTIALS` | Cesta k service account JSON (lokálně `./service-account.json`). Na App Hostingu nech nevyplněné — použije se ADC. |
| `FIREBASE_API_KEY`               | Web config (Console → Project settings → Your apps → Web → SDK setup).                                             |
| `FIREBASE_AUTH_DOMAIN`           | `garaaage-auction24.firebaseapp.com`                                                                               |
| `FIREBASE_PROJECT_ID`            | `garaaage-auction24`                                                                                               |
| `FIREBASE_STORAGE_BUCKET`        | `garaaage-auction24.appspot.com`                                                                                   |
| `FIREBASE_MESSAGING_SENDER_ID`   | Web config                                                                                                         |
| `FIREBASE_APP_ID`                | Web config                                                                                                         |
| `FIREBASE_AUTH_EMULATOR_HOST`    | (volitelné) `127.0.0.1:9099` pro lokální emulátor.                                                                 |
| `CRON_SECRET`                    | Sdílený secret pro crony (`/api/cron/*`); Cloud Scheduler ho posílá v `Authorization`.                            |
| `RECO_ENABLED`                   | `1`/`true` zapne doporučovací engine (detail rail + tracking + build/newsletter crony). Default vyp.               |
| `SENDGRID_API_KEY`               | Odesílání e-mailů (auth, výherce aukce, kauce, newsletter). Bez něj se reálně neodesílá (dryRun/inline fallback).  |
| `REDIS_URL`                      | (volitelné) BullMQ fronta e-mailů. Bez něj inline send (fire-and-forget).                                         |
| `INTERNAL_API_SECRET`            | HMAC pepper pro API tokeny **a** one-click unsubscribe link v newsletteru.                                         |

> Bez `FIREBASE_API_KEY` se přihlašování vypne (klient warnuje), ale datové endpointy fungují dál.

## Databáze

```bash
pnpm db:migrate up        # vytvoří/aktualizuje schéma (users, items, bids, invoices)
pnpm db:migrate status    # přehled migrací
pnpm db:migrate down      # rollback poslední migrace
pnpm seed:dev             # naseeduje fixtures (6 users, 16 items, 2 invoices)
pnpm grant:admin <email>  # přidá roli admin (po prvním přihlášení uživatele)
```

Migrace jsou v `server/migrations/NNN-*.ts`. Seed je idempotentní (maže jen `i*`/`u1`/`admin1`/`b*`/`inv-*` ID — reálné řádky nechá být).

## Vývoj

```bash
pnpm dev          # http://localhost:3000
```

Přihlášení: zaregistruj/přihlas se přes UI (Firebase Email/Password). Admin sekce (`/admin/**`) vyžaduje roli `admin` → po prvním loginu spusť `pnpm grant:admin <email>` a znovu se přihlas.

## Testy

```bash
pnpm test:unit          # rychlé, bez DB (mappery, auth gate, soft-close, model helpery)
pnpm test:integration   # repo testy proti docker Postgresu (port 5434); nikdy proti produkci
pnpm test               # vše
```

## Lint / typecheck / formát

```bash
pnpm lint            # ESLint (+ Prettier jako warn)
pnpm lint:css        # Stylelint nad <style> bloky a .css
pnpm typecheck       # nuxt typecheck
pnpm format          # Prettier write
```

## Deploy (Firebase App Hosting)

Konfigurace v [`apphosting.yaml`](./apphosting.yaml). Secrets vytvoř přes:

```bash
firebase apphosting:secrets:set POSTGRES_URL
firebase apphosting:secrets:set FIREBASE_API_KEY     # a zbylé FIREBASE_*
```

`FIREBASE_*` mají `availability: [BUILD, RUNTIME]` (web config se zapéká do bundlu při buildu). Admin SDK na App Hostingu používá **ADC** — runtime service accountu udel roli **Firebase Authentication Admin** nad projektem. Migrace (`pnpm db:migrate up`) spusť proti produkční DB ručně před prvním deployem.

### Close-auctions cron (Google Cloud Scheduler)

Skončené aukce zavírá (určí výherce + pošle e-mail) endpoint `POST /api/cron/close-auctions`, který každých ~5 min volá **Google Cloud Scheduler**. Auth = sdílený `CRON_SECRET` v `Authorization` hlavičce.

```bash
firebase apphosting:secrets:set CRON_SECRET          # openssl rand -hex 32
gcloud scheduler jobs create http close-auctions \
  --schedule="*/5 * * * *" \
  --uri="https://<app-hosting-domain>/api/cron/close-auctions" \
  --http-method=POST --location=europe-west1 \
  --headers="Authorization=Bearer <CRON_SECRET>" --attempt-deadline=120s
```

Endpoint je idempotentní (zavírání i e-maily jsou guardované přes `closed` / `winner_emailed_at`), takže překryv běhů ani retry nevadí. Bez `CRON_SECRET` vrací 503.

### Doporučování + newsletter (Google Cloud Scheduler)

Doporučovací engine (detail "Podobné inzeráty" + newsletter) běží za flagem **`RECO_ENABLED=1`**. Spec v [`docs/recommendation-algorithm.md`](./docs/recommendation-algorithm.md), přehled v `CLAUDE.md` (sekce _Doporučování_). Dva crony (idempotentní, sdílený `CRON_SECRET`):

```bash
# Přepočet precompute (~každých 10 min; těžký pass profilů/afinity se self-gateuje hodinově):
gcloud scheduler jobs create http build-recommendations \
  --schedule="*/10 * * * *" \
  --uri="https://<app-hosting-domain>/api/cron/build-recommendations" \
  --http-method=POST --location=europe-west1 \
  --headers="Authorization=Bearer <CRON_SECRET>" --attempt-deadline=300s
# Newsletter (každý 2. den; per-user weekly gate ≥7 dní je v kódu → běhy se přirozeně staggerují):
gcloud scheduler jobs create http newsletter \
  --schedule="0 9 */2 * *" \
  --uri="https://<app-hosting-domain>/api/cron/newsletter" \
  --http-method=POST --location=europe-west1 \
  --headers="Authorization=Bearer <CRON_SECRET>" --attempt-deadline=300s
```

Lokální ověření (s `RECO_ENABLED=1` a `CRON_SECRET` v `.env`):

```bash
pnpm db:migrate up && pnpm seed:dev
curl -XPOST -H "Authorization: Bearer $CRON_SECRET" localhost:3000/api/cron/build-recommendations
curl localhost:3000/api/recommendations/item/<itemId>          # seřazené card[] (nikdy nespadne)
curl -XPOST -H "Authorization: Bearer $CRON_SECRET" "localhost:3000/api/cron/newsletter?dryRun=1"  # výběr bez odeslání
pnpm preview:newsletter                                        # vyrenderuje newsletter do .preview/ pro náhled
```

Reálné odeslání newsletteru potřebuje `SENDGRID_API_KEY` (jinak `?dryRun=1`); `REDIS_URL` zapne frontu. Bez `RECO_ENABLED` serving spadne na popularitu, sběr i crony jsou no-op. Sběr je navíc gated **souhlasem s cookies** (cookie `a24_vid` se nastaví až po accept).

## Struktura

```
server/
  api/            Nitro endpointy (data + auth)
  db/schema.ts    Kysely Database typy
  migrations/     file migrace (up/down)
  repos/          datový přístup + mappers.ts (row ↔ model)
  utils/          db.ts, firebase.ts, session.ts, migrate.ts
  data/fixtures.ts  reference data (statická) + zdroj seedu
composables/      data + auth (useUser, useItems, …); admin/ vnořené
plugins/          api.client.ts (Bearer), firebase.client.ts
scripts/          db-migrate.ts, seed-dev.ts, grant-admin.ts, load-env.ts
models/           TS modely + enumy (auto-imported)
```
