# Projekt

`garaaage-auction` — **1:1 frontend port** staré aplikace `/home/dkrul/Projects/auction24` (aukce vozidel) do **Nuxt 4 + Tailwind v4**. Konfigurace dle `/home/dkrul/Projects/garaaage-main`, ale **bez `@nuxt/ui`** — UI staví na `@headlessui/vue` + vlastních `Base*` komponentách (vizuální styl: **stargate-inspired** — slate neutrály + značková červená primary, flat/border-first; dříve 1:1 auction24).

## Architektura

| Vrstva   | Technologie                                                                   |
| -------- | ----------------------------------------------------------------------------- |
| Frontend | Nuxt 4 / Vue 3 / Tailwind v4 (`@tailwindcss/vite`, ne `@nuxt/ui`)             |
| UI       | `@headlessui/vue` + `Base*` komponenty                                        |
| i18n     | `@nuxtjs/i18n` v10, 12 locales, YAML soubory                                  |
| Ikony    | `@nuxt/icon` (`heroicons-outline/-solid`, `flag`, `cib`, `mdi`)               |
| Stav     | `useState` + composables (`composables/`, `composables/admin/`)               |
| Backend  | **Nitro** `server/api/*` → **Kysely** + `pg` (Railway Postgres) + repo/mapper |
| Auth     | **Firebase** (klient SDK + Admin SDK), Bearer token (jako garaaage-main)      |

## Moduly (features/)

Frontend je modularizovaný do **vertikálních feature modulů** `features/<domena>/` (plná spec: `plan.md`). Modul = `ui/` (`.vue`, auto-import přes `components.dirs: { path:'~/features', pathPrefix:false }` scan `**/ui/**` → holá jména `<ItemCard>`) · `logic/` (composables, auto-import přes `imports.dirs: features/*/logic`) · `contract.ts` (re-export typů z `models/` barrelu — **modely zůstávají centralizované**, §7.2) · `README.md`. Self-measure: `pnpm module:check` (registry → 100% file coverage + rollup invarianty) · `module:map [--check]` · `module:signal <domena>` · `module:contract <id> [--update]`. Registry = `scripts/modules/registry.json` (zdroj pravdy, 14 domén / 559 cell).

- **10 fyzických modulů:** design-system, reference-data, i18n (locales přes `i18n.restructureDir:'features/i18n'`), vehicle-vin, auction-items, media-upload, recommendation, auth-account, bidding, deposit-billing.
- **4 logické** (záměrně bez fyzického carve — infra/route-bound): `platform` (`nuxt.config`/`app.vue`/`server/utils`…), `api-docs` (`server/openapi`), `admin` (`pages/admin/**` + `composables/admin/`), `newsletter-email` (`server/email`).
- **Za kontraktem zůstává v `server/`:** repos, utils, api handlery (Nitro routy path-adresovatelné), money/auth logika. Necarvované (defer): `components/playground/**` (dev-galerie), server-side reorg `server/utils→server/<domena>`.

> ⚠️ Komponenty/composables se přesunuly do `features/<domena>/{ui,logic}/`. Cesty `components/*` a `composables/*` zmíněné níže v tomto dokumentu mohou být **zastaralé** — aktuální umístění drží registry + `plan.md`.

## Backend (Kysely + Postgres)

Data jdou přes `$fetch('/api/...')` na Nitro endpointy v `server/api/*`, které čtou/zapisují **Railway Postgres** přes **Kysely** (`server/utils/db.ts`, `CamelCasePlugin` → snake_case sloupce). Vrstvy:

- `server/db/schema.ts` — Kysely `Database` (tabulky `users`, `items`, `bids`, `invoices`; ceny jako `*_amount` + `*_currency`, data jako `timestamptz`, JSONB pro `description/highlights/winner/gps/address`).
- `server/migrations/NNN-*.ts` — file migrace (`export const up/down`). CLI: `pnpm db:migrate up|down|status`.
- `server/repos/*.ts` + `server/repos/mappers.ts` — datový přístup. **Mappery drží FE kontrakt**: data jako **epoch‑ms** čísla, `Price`/`Currency`/`Language` jako objekty (rehydratované z kódu), `AuthType` jako číselný enum. Měníš-li model, uprav mapper.
- **Reference data** (categories/countries/currencies/languages) zůstávají statické v `server/data/fixtures.ts` — nemají tabulku, jen se re-exportují přes `server/utils/db.ts`. `fixtures.ts` je zároveň zdroj seedu.

Connection přes `POSTGRES_URL` (+ volitelně `POSTGRES_SSL=disable`) v **gitignored** `.env`. **Skripty (tsx):** `pnpm db:migrate <up|down|status>` · `pnpm seed:dev` (placeholder users `u1`/`admin1`/`b1`–`b4` + 16 items + 2 invoices) · `pnpm grant:admin <email>`. ⚠️ tsx neresolvuje alias `~` — v modulech, které do skriptů tečou (`fixtures.ts`, `mappers.ts`), importuj **hodnoty** z modelů **relativně** (`../../models`), ne přes `~/models` (typy přes `import type` jsou OK, mažou se při kompilaci).

## Auth (Firebase, Bearer token — jako garaaage-main)

Firebase projekt **`garaaage-auction24`**. Klient se přihlásí přes Firebase SDK (`composables/useUser.ts` + `utils/firebaseClient.ts`); `plugins/api.client.ts` přidá `Authorization: Bearer <idToken>` na každý `/api` request. Server ověří v `server/utils/firebase.ts` (`verifyIdToken` + cache) a `server/utils/session.ts` (`getSessionUser`/`requireSession`/`requireAdmin`, revokační gate přes `users.tokens_valid_after`). `/api/auth/login` udělá upsert uživatele, `/api/auth/logout` posune cutoff.

- **SSR je anonymní** (token je jen na klientu) → route guardy (`middleware/auth.ts`, `admin.ts`) běží **client-side** a čekají na `ensureAuthResolved()`; `/admin/**` má `routeRules: { ssr: false }`.
- Konfig: `runtimeConfig.public.firebase` z `FIREBASE_*` env. Lokálně Admin SDK přes `GOOGLE_APPLICATION_CREDENTIALS=./service-account.json` (gitignored), na App Hostingu přes ADC. `apphosting.yaml` je v rootu.
- Bez vyplněného `FIREBASE_API_KEY` je auth vypnutý (klient warnuje), datové endpointy fungují dál. Admina nastavíš po prvním přihlášení přes `pnpm grant:admin <email>`.

## Kauce (Fio + Fakturoid + Stripe)

Jednotná vratná kauce **10 000 Kč / 500 €** (uživatel volí měnu) odemyká přihazování (`isUserEligibleToBid` — gate už v `bid.post.ts` + `ItemBid.vue`). Platí se **bankovním převodem** (SPAYD QR, detekce cron nad **Fio API**) nebo **kartou** (Stripe Checkout); doklady jdou přes **Fakturoid v3** (zálohová faktura).

- **Flow:** wizard `components/deposit/DepositWizard.vue` (vstup `DepositCard` na `/profile/billing`; `ItemBid` redirectuje s `?deposit=1`) → `POST /api/deposit/transfer` založí **lokální** `invoices` řádku (status `unpaid`, `type='deposit'`, VS = `users.deposit_vs` — unikátní 10místný, PG funkce `generate_deposit_vs()`) + **best-effort** Fakturoid proformu (`document_type:'proforma'`, followup `none`, VAT 0; výpadek Fakturoidu flow neblokuje, doklad se dožene) → FE polluje `GET /api/deposit/status` (10 s, `composables/useDeposit.ts`) → success step s konfetami.
- **Cron `POST /api/cron/fio-payments`** (Cloud Scheduler */5, Bearer `CRON_SECRET`): stáhne 7denní okno z obou Fio účtů (`periods` s **pražskými** daty, **ne** `last` pointer — crash-safe). **Claim + settle = jedna transakce** (`depositRepo.settleFioPayment` — pád mezi claim a settle se rollbackne a další běh platbu zopakuje): dedupe PK `(account, fio_id)`, match `(VS zero-insensitive přes ltrim — banky vodicí nuly stripují, měna, částka ≥ cena)` → sdílené settle jádro (`settleInvoiceInTx`, používá ho i Stripe webhook): faktura `paid`, `users.depositBalance*` ← částka, sesterská otevřená kauce `canceled`, fio řádek `matched`. Post-commit `finalizeDepositSettlement`: expirace Stripe sessions zrušených faktur, **storno sesterských proform ve Fakturoidu** (`fire cancel`) a mark-paid (`payments.json`, `send_thank_you_email`; **4xx = terminální** — 403 tiše, jiné s logem). Sweep přes `fakturoid_paid_at IS NULL` pokrývá i faktury **bez** vystavené proformy (late-create). Nespárované platby zůstávají `unmatched` + error log — ruční dohra.
- **Karta (Stripe):** wizard krok **method** (karta/převod; bez `STRIPE_SECRET_KEY` se karta skryje — `public.stripeEnabled`) → `POST /api/deposit/checkout` reuse/založí **stejnou lokální fakturu** jako převod, vytvoří Checkout session (metadata `{type:'deposit', userId, invoiceId, currency}`, `expires_at` +1 h, idempotency klíč `deposit-{invoiceId}-{hourFloor}` — invoiceId v klíči ⇒ přepnutí měny nevyhodí Stripe `idempotency_error`) → redirect. **Webhook `POST /api/webhooks/stripe`** (`server/api/webhooks/stripe.post.ts`): signature verify (fail-closed 401), event claim v `processed_stripe_events` (INSERT = claim, release-on-error), `settleDepositByStripe` (CAS dle `invoiceId+userId`, zapíše `stripe_session_id/payment_intent`) → `settleInFakturoid` + expirace sourozeneckých sessions. Settle null → matice: `stripe_session_id` shoda = replay (`already_settled`) · fallback open faktura dle (userId, měna) · jinak **refund-candidate error log** (peníze bez protějšku). Návrat: `/profile/billing?deposit=success` → verifying stav (poll 2,5 s → konfety), `?deposit=cancelled` → toast + method.
- **Vrstvy:** `server/utils/{deposit,fakturoid,fio,spayd,stripe}.ts` + `server/repos/depositRepo.ts`; částky drží `models/Deposit.ts` (`DEPOSIT_AMOUNTS` = zdroj pravdy), stavy faktur `INVOICE_STATUS` v `models/Invoice.ts`, predikát „kauce splněna" `hasDepositPaid` v `models/User.ts`. Fakturoid vyžaduje User-Agent s kontaktním e-mailem; OAuth client-credentials token se cachuje 2 h (401 → invalidace + re-mint); všechny upstream fetche mají timeout. ⚠️ Proforma se přes `bank_account_id` pinuje na kauční Fio účet podle IBAN — **oba kauční účty musí být založené ve Fakturoid UI** (Nastavení → Bankovní účty), jinak doklad ukazuje default účet a kód jen warnuje.
- **Konfig:** `FAKTUROID_SLUG`/`CLIENT_ID`/`CLIENT_SECRET` (účet `eastwest24`), `FIO_TOKEN_CZK`/`FIO_TOKEN_EUR` (čtecí tokeny; **expirují po 180 dnech** — zapnout auto-prodlužování v IB; min. 30 s mezi voláními na token, 409 → běh se přeskočí), `DEPOSIT_IBAN_*`/`DEPOSIT_ACCOUNT_*`/`DEPOSIT_RECIPIENT` mají defaulty v `nuxt.config.ts` (CZK 2903525501/2010, EUR 2503525502/2010). Bez Fakturoid klíčů se nevystavují doklady, bez Fio tokenu se účet přeskočí — flow jinak běží.
- **Stripe konfig:** karta je za **explicitním flagem `STRIPE_CARD_ENABLED`** (`'1'`/`'true'`; gate ve FE přes `public.stripeEnabled` i na checkout endpointu — webhook běží vždy, aby doběhly starší sessions). Na produkci je flag `'0'` v `apphosting.yaml`, dokud nejsou live klíče. `STRIPE_SECRET_KEY` (zatím **`sk_test_` — TEST režim**, sdílený s garaaage; go-live = live klíč) + `STRIPE_WEBHOOK_SECRET` (**per endpoint** — prod endpoint vytvoří `scripts/setup-stripe-webhook.ts`, lokálně secret ze `stripe listen --forward-to localhost:3000/api/webhooks/stripe`). Webhook se neregistruje do OpenAPI (machine-to-machine, parita s cronem).
- Refund/vracení kaucí zatím neexistuje (vědomě mimo scope; nespárovaná karta = refund-candidate log). i18n skupina `deposit:` ve všech 12 locales.

## Vincario (VIN dekodér)

Admin v editaci položky (záložka **General** → sekce **Vehicle (VIN)**) zadá VIN → `POST /api/admin/items/decode-vin` zavolá **Vincario** a doplní pole vozidla. Vrstvy:

- `server/utils/vincario.ts` — request signing: `controlSum = sha1("VIN|decode|API_KEY|SECRET_KEY")[:10]`, klíče z `VINCARIO_API_KEY`/`VINCARIO_SECRET_KEY` přes `runtimeConfig` (server). URL `…/3.2/{key}/{cs}/decode/{VIN}.json`.
- `server/utils/vincarioNormalize.ts` — Vincario labely → projektové enumy (`models/VehicleSpecs.ts`); `models/Vincario.ts` drží `NormalizedVin`/`DecodeVinResponse`.
- Vozidlová pole jsou **sloupce na `items`** (`vin`, `fuel_type`, `transmission`, `body_type`, `drive_type`, `engine_power_kw`, `engine_displacement_ccm`, `color`, `first_registration_date`) + **`specs` JSONB** (make/model/rok + dlouhý ocas). Mapper `server/repos/mappers.ts` je drží.
- Dekódy se durabilně cachují v tabulce `vin_decode_cache` (`server/repos/vinDecodeRepo.ts`) — opakovaný VIN je zdarma. Endpoint má rate-limit (`enforceRateLimit`) a `requireAdmin`.
- Bez vyplněných klíčů je tlačítko skryté (`public.vincarioEnabled`); admin formulář je anglicky. Veřejně se parametry renderují přes `components/ItemVehicle.vue` (i18n skupina `vehicle:` ve **všech 12** locales).

## Fotky (upload + image-processing)

Admin nahrává běžné i 360° fotky v editaci položky (pravý panel **Item gallery**). Upload jde **server-side přes Admin SDK** — bucket **není veřejný**, čte se přes Firebase download token (port řešení z `garaaage`).

- `composables/useImageUpload.ts` — pošle soubor jako multipart na `POST /api/admin/uploads`; `composables/admin/useAdminItem.ts` (`uploadImages`) plní `images` / `item.images360`.
- `server/api/admin/uploads.post.ts` (`requireAdmin` + `enforceRateLimit` + `readMultipartFormData`) → `server/repos/uploadRepo.ts` uloží přes `getStorageBucket()` (`server/utils/firebase.ts`) do **`public/ads/{itemId}/{uuid}.{ext}`**, nastaví `firebaseStorageDownloadTokens` a vrátí tokenovanou `firebasestorage…?alt=media&token=` URL (stejný formát jako staré inzeráty). Validace v `server/utils/uploadValidation.ts` (jpeg/png/webp/avif/gif, ≤ 20 MiB).
- **Delete v adminu** = odebrání URL z pole (persistuje se při save); objekt ve Storage zůstává (jako garaaage).
- FE **vždy** načítá obrázky přes `composables/useImageProcessing.ts` (extension `invertase/image-processing-api`, endpoint z `runtimeConfig.public.imageProcessingUrl`) — `getCardImage`/`getMediumImage`/`getLargeImage`/`imgUrl`. `prepareStorageUrl` double-encoduje path a zachová token. 360° still přes `components/Pano.vue` (width-only resize kvůli 2:1 panoramatu).
- Bucket je **`garaaage-auction24.firebasestorage.app`** (`FIREBASE_STORAGE_BUCKET`), ne `…appspot.com`. Lokálně Admin SDK přes `service-account.json`.

## Doporučování (recommendations)

Hybridní doporučovací engine (content ⊕ collaborative ⊕ popularita, spojené confidence blendem) pro dvě plochy: **detail "Podobné inzeráty"** a **newsletter**. Plná referenční spec: `docs/recommendation-algorithm.md`. Obě plochy používají **stejné jádro** — `models/Recommendation.ts` (čisté funkce + `RECO_CONFIG` = jediný zdroj pravdy pro všechny váhy/knoby; auto-import přes `imports.dirs:['models']`). Master flag **`RECO_ENABLED`** (`public.recoEnabled`, opt-in jako `stripeEnabled`); vypnuto → serving spadne na popularitu/`defaultSort`, sběr i crony jsou no-op.

- **Sběr (Phase 0):** klient `composables/useTracking.ts` (in-memory buffer, `enqueue()` neawaituje, flush na intervalu/`visibilitychange`/`pagehide` přes `navigator.sendBeacon`, fallback `$fetch keepalive` — ten nese Bearer ⇒ merge-on-login). Owner = `plugins/tracking.client.ts`, **gated souhlasem** (`useCookieConsent`, nic se nesbírá před accept) + `RECO_ENABLED`. Identita = first-party cookie **`a24_vid`** (klient mintuje po souhlasu, jede i přes SSR). Instrumentace: `components/ItemCard.vue` (hover/viewport/impression — vytaženo z `ItemsGrid`), `ItemGallery`/`ItemLightbox`/`Pano`/`ItemSharing`, `useCompare`, `composables/useDetailTracking.ts` (detail_view/dwell aktivní-čas/scroll/bounce). Ingest `POST /api/track` (consent/vid gate → tiše 204, rate-limited, idempotent na `id`, žádný výpočet).
- **Datový model (migrace 021):** `recommendation_events` (append-only, TTL prune, vč. `position`/`propensity`), `visitor_profiles`, `item_features`, `attribute_affinity`, `popularity_segments`. Migrace 022 přidá `users.newsletter_last_sent_at` (**server-only**, nemapuje se do `User`). Kysely interfaces v `server/db/schema.ts`. ⚠ numeric sloupce drž jako `Numeric` (ne `Generated<Numeric>` — Insert type by jinak nebyl `number|string`); JS **pole** do `jsonb` musí přes `JSON.stringify` (pg jinak serializuje pole jako PG array literal) — helper `jsonbArray` v repu.
- **Batch `POST /api/cron/build-recommendations`** (`server/utils/recommendation/build.ts`, zrcadlí `processFioPayments` — idempotentní, crash-safe oknem, per-krok `try/catch` + `captureServerError`): vždy přepočítá `item_features` (popularita §9 Bayes shrink + trend + quality + vector) a `popularity_segments`; **hodinově self-gated** těžký pass přepočítá `visitor_profiles` + `attribute_affinity` z eventů **∪ existujících** favorites/bids/offers (klíč `vid='u:'+userId` ⇒ bootstrap profilu i bez trackingu, §3.5); prune. Cloud Scheduler ~*/10.
- **Serving `GET /api/recommendations/item/:id`** (`server/utils/recommendation/serve.ts` — **nikdy nehodí výjimku k uživateli**): cached aktivní pool (`pool.ts`, modulová TTL cache jako `rateLimit`), skórování proti kotvě (β blend) + profilu + popularitě, tvrdá brána validity (`itemStatus`), MMR + ε-explorace, deterministický fallback řetězec (personalized→segment→global→newest→`defaultSort`). Vrací card-projection `Item[]` přes `itemRepo.loadCardsByIds` (+ `bodyType`/`specs.manufacturer` pro klientský re-rank). FE `components/SimilarItems.vue` (klientský fetch `server:false`+`lazy` ⇒ nezdržuje stránku, cookie jede nativně + auth z `api.client`), **within-session re-rank** (§14, `withinSessionReRank`, mounted-gated). Insert v `pages/item/[itemId].vue` za `</main>`. i18n skupina **`reco:`** v 12 YAML locales. **Třetí plocha = homepage rail** "Vybráno pro vás" (`GET /api/recommendations/home`, anchor=null) přes `components/RecommendedItems.vue` v `pages/index.vue`. Obě railové plochy sdílí prezentační `components/ItemsRail.vue` (re-rank + `ItemCard` s `h-full` pro stejnou výšku; `.rail-track` má `pt/pl-2`, jinak `overflow-x-auto` ⇒ `overflow-y:auto` usekne přečuhující kulatý `FlagBadge`).
- **Newsletter (§12):** `server/utils/newsletterBuilder.ts` (`sendDueNewsletters`, zrcadlí `auctionCloser`): cron **každý 2. den** (`POST /api/cron/newsletter`, `?dryRun=1`) emailuje jen **due** uživatele (`newsletter_last_sent_at` ≥ 7 dní ⇒ weekly-per-user, staggered), **claim-CAS** (`claimNewsletterSend`) proti double-send, `recommendForNewsletter` (anchor=null + horizont 48 h), skip bez položek. Šablona je **aditivní** rozšíření `server/email/{layout,templates}.ts` (`items`/`unsubscribe` v `EmailContent` — stávající 4 šablony beze změny), obrázky přes `server/email/itemImage.ts` (jpeg). i18n je **server-side TS** (`server/email/translations/*.ts`, klíč `newsletter` ve 12 locales) — **oddělené** od Vue YAML. One-click `GET /api/newsletter/unsubscribe?token=hmac(userId, INTERNAL_API_SECRET)`.
- **Konfig/crony:** `RECO_ENABLED` v `nuxt.config` + `apphosting.yaml` (BUILD+RUNTIME), `CRON_SECRET`/`SENDGRID_*`/`REDIS_URL`/`INTERNAL_API_SECRET` sdílené. Dva Cloud Scheduler joby (build-recommendations ~*/10, newsletter každý 2. den) se zakládají ručně (parita s close-auctions).
- **Defer (vědomě mimo scope, zdokumentováno):** Phase 5 learning-to-rank/IPS **trénink** (logujeme `position`/`propensity`, takže zůstává možný).

## API dokumentace (OpenAPI / Scalar)

Veřejná dokumentace celého API (port řešení z `garaaage`): **`/api/_docs`** (Scalar UI z CDN) + spec na **`/api/_openapi.json`**.

- `server/openapi/registry.ts` — `OpenAPIRegistry` + `bearerAuth` (Firebase ID token) + `API_TAGS` (auth/items/reference/account/admin/recommendations).
- `server/openapi/spec.ts` — `generateOpenAPIDocument()` přes `@asteasolutions/zod-to-openapi` (`OpenApiGeneratorV31`); `servers` = localhost + `BASE_URL`.
- `server/openapi/schemas/*.ts` — **zod** schémata (zrcadla `models/*.ts`), registrovaná jako components. Projekt jinak zod nepoužívá — je tu **jen pro docs**, není zapojený do runtime validace.
- `server/openapi/paths/*.ts` — `registry.registerPath(...)` pro každý endpoint; `index.ts` agregátory volají registrace **explicitně** (bare side-effect import by se tree-shakeoval pryč → prázdný spec).
- `server/api/_docs.get.ts` + `_openapi.json.get.ts` — gate přes **`DISABLE_API_DOCS=1`** (default zapnuto = veřejné).
- **Přidáváš endpoint?** Přidej cestu do příslušného `paths/*.ts` (a schéma do `schemas/*.ts`, pokud nový tvar). Const enumy ber z `~/models` (`ITEM_TYPES` je lokálně v `schemas/items.ts`).

## Testy

- `pnpm test:unit` — pure (mappery, session gate, soft-close, model helpery), bez DB.
- `pnpm test:integration` — repo testy proti **docker** Postgresu (`docker-compose.test.yml`, port **5434**), nikdy proti Railway.

# Code style

- Arrow functions místo function declarations.
- `const` místo `let` kde to jde.
- Nepoužívej `any`, pokud to není nezbytně nutné.
- Toasty přes `import { useToast } from 'vue-toastification'` (ne Nuxt UI toast — ten tu není).
- TypeScript modely/interfaces v `models/`.

## Commit messages

- **Krátké a stručné.** Subject ≤ 50 znaků, bez tečky, Conventional Commits (`fix:`, `feat:`, `chore:`…).
- Body jen když "proč" není zřejmé z diffu — max 2–3 řádky. Žádné bullet-listy souborů.

## Komentáře

- **Default: žádný komentář.** Piš jen když vysvětluje **WHY** (skrytý constraint, workaround, netriviální invariant).
- Stručně (1–3 řádky), anglicky. Nereferencuj kontext, který komentář přežije ("added for X flow", issue čísla → patří do commitu).
- U self-explanatory kódu (gettery, mapovací funkce, zřejmá validace) nepiš nic.

# Tailwind / CSS

**Žádné inline Tailwind třídy v šablonách** (`class="flex items-center …"`) — vynuceno ESLintem `garaaage/no-inline-tailwind` (error). Element dostane jedno sémantické jméno třídy (`class="status"`) nebo projektovou `@utility` (`app-btn`, `app-panel`), styl se definuje v `<style scoped>` přes `@apply` + CSS nesting. Dynamiku piš jako state modifiery v `:class` (`:class="{ 'is-active': active }"`), ne jako inline utility (`:class="{ 'flex gap-2': x }"`). Stylelint hlídá `<style>` bloky a `.css` soubory; `assets/css/main.css` a `reset.css` (token / base / `@utility` layer) jsou z něj vyloučené — vlastní raw hodnoty design tokenů a sdílené `@utility` s arbitrary px hodnotami patří sem.

## Barvy & povrchy (stargate-inspired redesign)

Vizuální systém je **slate neutrály + značková červená jako primary**, flat / border-first, **bez dark mode**. Komponenty referencují **sémantické tokeny** z `main.css @theme` (ne hex):

- **Neutrály:** `app-bg` (pozadí stránky), `app-surface` (karty/panely), `app-surface-muted` (thead/inset/hover), `app-border` / `app-border-strong` (hairline/outline), `app-text` / `app-text-muted` / `app-text-strong` (text). Tailwind `gray-*` je přemapovaný na slate.
- **Akcenty:** `app-primary` (= značková červená `#db302f`) pro **veškerý chrome + aukce/příhozy + destruktivní akce**; `app-green` (buy-now / success / výhra); `app-amber` (pending / „brzy" / oblíbené). **Modrá se nepoužívá.**
- **Flat:** karty/panely = `border border-app-border` (žádný `shadow`/`ring`); stín jen na plovoucích vrstvách (modaly, dropdowny, sticky lišty). Radius/type/line-height škály níže platí beze změny.
- **Tlačítka:** `app-btn` (primary červená), `app-btn-alt` (neutral outline), `app-btn-danger` / `app-btn-auction` (červená), `app-btn-admin`.
- **Admin** používá stargate-style shell (`layouts/admin.vue`): sbalitelný levý slate sidebar + top navbar, sjednocený se stejnými tokeny (dříve samostatný gray-800 svět).

```vue
<template>
  <div class="card">
    <span class="card-title">…</span>
  </div>
</template>

<style scoped>
.card {
  @apply flex items-center gap-4 rounded-lg bg-white p-6;

  .card-title {
    @apply text-lg font-bold;
  }
}
</style>
```

Pro **scoped/`<style>` CSS** platí (vynuceno stylelintem):

- **Žádné arbitrary values v `@apply`** (`text-[13px]`, `rounded-[10px]`) — plugin `garaaage/no-tailwind-arbitrary`. Použij preset utility (`text-sm`, `rounded-lg`) nebo `@theme` token z `main.css`.
- **Border-radius jen z povolené škály** — používej **pouze** `rounded-sm`, `rounded-lg`, `rounded-xl` a `rounded-full`. **`rounded-md` se nepoužívá vůbec** (místo něj `rounded-lg`); stejně tak `rounded` / `rounded-xs` / `rounded-2xl`+ nepatří do kódu.
- **Font-size jen z 6stupňové škály: 12 / 14 / 16 / 18 / 24 / 32 px.** Povolené třídy: `text-xs` (12), `text-14`, `text-16`, `text-18`, `text-24`, `text-32` (Tailwind aliasy `text-sm` / `text-base` / `text-lg` / `text-2xl` pro 14/16/18/24 jsou ekvivalentní a OK). **Mimo škálu = chyba: `text-xl`/`text-20` (20), `text-3xl` (30), `text-4xl`/`text-36` (36), `text-5xl`/`text-48` (48)** i libovolné arbitrary `text-[Npx]`. Role: 12 = popisky/chipy · 14 = výchozí UI text · 16 = čtený obsah · 18 = podnadpisy · 24 = nadpisy · 32 = display/velká čísla. `--text-*` tokeny (14/16/18/24/32) v `main.css` jsou zdroj pravdy a nesou **font-size i párový line-height** (viz pravidlo o line-height níže).
- **Line-height jen z párované škály: 16 / 20 / 24 / 28 / 32 / 36 / 40 px.** Nenastavuj `line-height` ani `leading-*` ručně pro běžný text — každý font-size (Tailwind preset i `--text-NN` token) nese **párový** line-height (`--text-NN--line-height` v `main.css`), takže `@apply text-16` rovnou dá 24px. Párování tokenů: 14→20, 16→24, 18→28, 24→32, 32→40. `leading-*` použij **jen jako override u nadpisů/displaye** (`@apply text-32 leading-tight`), nikdy ne k vynucení off-scale hodnoty. Bez párování token dědí ratio předka → rozbité hodnoty (22.86, 25.71 px) — proto párujeme.
- **Žádné raw `px`/`rem`** u `width/height/min-*/max-*/inset` — utility přes `@apply` nebo CSS proměnná.
- **Žádné raw hodnoty** u spousty properties (`margin`, `gap`, `padding`, `font-*`, `display`, `flex*`, `position`, `color`, `background-color`, `border*`, `cursor`, `opacity`, `aspect-ratio`, `z-index`, …) — vždy přes `@apply` (`@apply font-bold cursor-pointer opacity-50`). Hex barvy → `@theme` tokeny (`bg-app-primary`, `text-app-text`).
- **Žádné `min-width`/`max-width` media queries** — Tailwind responsive utility (`sm:`, `md:`, `max-md:`).
- **Žádný BEM** (`__`, `--`) v názvech tříd — jednoduchý kebab-case + CSS nesting + `.is-*` state modifiery.
- **Sémantické názvy tříd nesmí kolidovat s Tailwind utility** — `no-inline-tailwind` je shape-based, takže `grid`, `table`, `row`, `list`, `content`, `scroll`, `flex`, `block`, `container`, `border` (a `min-*`/`max-*` prefixy) jako jméno třídy flaguje. Prefixuj je (`card-grid`, `data-row`, `data-table`). Markery `group`/`peer` (pro `group-hover:`/`peer-*`) v template **zůstávají** — nejsou styl.
- **Nepoužívej `stylelint-disable*` komentáře** — fixni surgically (`@apply`, token), ne disablem.

# i18n

- 12 locales v `features/i18n/locales/<code>.yml` (ar, cz, de, en, fr, hr, me, nl, pl, rs, ru, ua), default `cz`, strategy `no_prefix`.
- V komponentě `const { t } = useI18n()`, v template `{{ t('key') }}`.
- **Všechny jazyky držíme kompletní** — žádné padání zpět na `cz`. Nový klíč přidej do **všech** locale souborů.
- ESLint `@intlify/vue-i18n/no-raw-text` (warn) flaguje hardcoded texty v `.vue` (text uzly + `placeholder`/`title`/`alt`/`aria-label`). Vyloučeno: `pages/admin/**` (admin je interní/anglicky), `error.vue`.

# Auto-import

- `composables/*.ts`, `utils/*.ts`, `components/*.vue` jsou auto-imported. **Vnořené** composables potřebují konfiguraci — `composables/admin` je v `nuxt.config` `imports.dirs`.
- Enumy a helpery z `models/*.ts` jsou auto-imported přes `imports.dirs: ['models']` (`ItemType`, `defaultSort`, `itemStatus`…). Typy importuj explicitně (`import type { Item } from '~/models'`).

# VueUse-first

Pro utility chování (interval, storage, share, clipboard, breakpoint, debounce…) importuj přímo z `@vueuse/core` (auto-imported přes `@vueuse/nuxt`) — nevytvářej 1:1 wrapper.

# Ikony

- Vždy `<Icon name="collection:name" />` z `@nuxt/icon` (`heroicons-outline:star`, `flag:cz-4x3`, `cib:facebook`, `mdi:loading`). Dynamicky `:name="\`flag:${code}-4x3\`"`.

# Naming conventions

- Composables: `use[Name].ts` · Komponenty: PascalCase · Utils: camelCase · Modely: PascalCase v `models/`.

# Lint

- `pnpm lint` / `pnpm lint:fix` — ESLint (+ Prettier jako warn).
- `pnpm lint:css` / `pnpm lint:css:fix` — Stylelint nad `<style>` bloky a `.css`.
- `pnpm format` — Prettier write.

# Mimo scope (placeholder)

Stále placeholder/mock: Algolia (→ `/api/search`), Google Maps (→ OpenStreetMap iframe), Lightgallery (→ vlastní lightbox). **Auth, databáze, upload fotek, Stripe i DeepL už NEJSOU mock** — běží reálný Firebase (Auth + Storage) + Postgres + image-processing extension + Stripe Checkout (viz výše). **DeepL** je zapojený přes `server/utils/deepl.ts` + `POST /api/translate` (admin-only, `requireAdmin` + rate-limit), pohání admin akci „translate to other languages" v editaci položky (`LocaleTabs.vue` → `useAdminItem.translateOtherLanguages`); klíč `DEEPL_API_KEY` (server-only) gatuje `public.deeplEnabled` (Free klíč s příponou `:fx` → `api-free.deepl.com`). Firestore se nepoužívá (data jsou v Postgresu). Neflaguj placeholdery jako chybu.
