# Rework administrace → automatizace (návrh)

> Stav: návrh k diskusi. Evidence-based — každý bod kotvený na `file:line` (ověřeno greppem)
> nebo na externí zdroj (URL ve scratchpad `deep-research.md`). Verified vs inference je
> rozlišeno. Voze prózy = CZ, identifikátory/cesty/tabulky = EN (parita s `CLAUDE.md`).

## 0. TL;DR

auction24 má **vynikající automatizační páteř na transakčních cestách** (platby, aukce, reco,
e-maily) — cron + claim-CAS + settle-in-tx + best-effort side-effects + email queue +
notifikace + observability shim. **Admin plocha je naproti tomu tenká a děravá** a
**obohacování inzerátů je 100% manuální**. Rework proto nemá zavádět nové těžké nástroje
(Temporal/Retool/event-bus) — má **rozšířit bespoke Nuxt admin o tytéž primitivy, které už v
platebních cestách fungují**, a navíc přidat tenkou AI-enrichment vrstvu s pravidlem
**„draft, neodesílej"** u všeho, co nese peníze/smlouvu/reputaci.

Pořadí: **(1) zavři nebezpečné díry** (disputes bez UI, user-management jako stub, žádná
viditelnost jobů, žádný audit log) → **(2) automatizuj dominantní dřinu** (tvorba inzerátu:
VIN auto-enrich, LLM popisy/highlights, auto-překlad při zveřejnění) → **(3) HITL fronty**
(moderace Q&A/ratings, reconciliation) → **(4) risk/fraud**.

---

## 1. Diagnóza současného stavu (ověřeno)

### 1.1 Co už je silné — automatizační primitivy k REUSE

Tohle je „toolkit", na kterém rework staví. Nic z toho nevymýšlet znovu.

| Primitiv | Kód (file:line) | Použij když… |
|---|---|---|
| Cron auth | `server/utils/session.ts:125` `requireCronSecret` | endpoint smí volat jen scheduler |
| Sliding-window idempotence | `server/utils/deposit.ts` (7denní okno, bez pointeru) | externí zdroj nemá kurzor, re-scan je levný |
| Claim+work v jedné tx | `server/repos/depositRepo.ts:211` `settleFioPayment` | claim a práce musí být atomické |
| Webhook event-claim | `server/repos/depositRepo.ts:285` `processStripeDeposit` | exactly-once webhook, replay-safe |
| Settle CAS kernel | `server/repos/settleCore.ts:62` (`WHERE status='unpaid'`) | „nabít jednou" napříč zdroji |
| Two-pass sweep | `server/utils/auctionCloser.ts:24` | akce + side-effect lze oddělit, crash-safe |
| Claim-CAS na timestampu | `server/repos/newsletterRepo.ts:29` `claimNewsletterSend` | „nejvýš jednou za období na příjemce" |
| Notifikace dedup | `server/repos/notificationRepo.ts:29` (`ON CONFLICT (dedupeKey)`) | stejný event se nesmí 2× notifikovat |
| Best-effort wrapper | `server/utils/notify.ts:9` | side-effect nesmí shodit hlavní flow |
| Email queue + inline fallback | `server/utils/emailQueue.ts:126` `enqueueEmail` | poslat e-mail bez blokace + retry |
| Module-level TTL cache | `server/utils/recommendation/pool.ts:67` | drahý read, snese mírné zastarání |
| Feature flag (env-baked) | `server/utils/reco.ts:6` `isRecoEnabled` | celá fíčura on/off bez kódu |
| Observability shim | `server/utils/observability.ts:9` `captureServerError` | jednotné logování chyb (swap za Sentry) |
| Rate limit (fixed-window) | `server/utils/rateLimit.ts:56` `enforceRateLimit` | anti-abuse na endpointu |

**Scheduled jobs dnes:** close-auctions (~5 min), fio-payments (~5 min), build-recommendations
(~10 min), newsletter (2 dny), saved-search-alerts (denně). Všechny: `requireCronSecret` +
`enforceRateLimit`.

### 1.2 Co je slabé — díry v admin ploše (ověřené greppem)

| # | Díra | Důkaz | Dopad |
|---|---|---|---|
| D1 | **Disputes nemají žádné admin UI** — řeší se raw API/curl | `pages/admin/` = jen `items`/`item`/`users`/`api-tokens`; `disputeRepo` má jen `listForUser` (`:103`), žádné `listAll`; endpointy `server/api/admin/disputes/[id]/{review,resolve}.post.ts` | **nejnebezpečnější** — ops netuší, že case existuje |
| D2 | **User management = stuby** | `useUserDetail.ts:28,32` — `deleteUser`/`resetPassword` jen `toast`, žádné API; přitom `userRepo.softDeleteUser` existuje | „smazáno" lže; grant-admin jen přes CLI |
| D3 | **Žádná viditelnost cronů** | v schématu chybí `cron_runs`/`job_runs` (ověřeno absent) | tichý výpadek Fio/aukcí nikdo nevidí |
| D4 | **Žádný audit log** | chybí `audit_log`/`admin_actions` tabulka (jen doménový `fio_payments`) | kdo co kdy změnil = neznámo |
| D5 | **Q&A nemá globální frontu (UI)** | backend ji UMÍ (`questions.get.ts` — `itemId` volitelné), chybí jen stránka | dřina: otázka po otázce přes editor itemu |
| D6 | **Ratings bez moderace** | `ratingRepo` má jen `createRating`/`sellerReputation`, žádné delete/flag | falešný rating jde pryč jen DB DELETE |
| D7 | **Reconciliation jen log** | Fio `unmatched` = jen `captureServerError`, žádná fronta/UI | ruční dohledávání v DB |
| D8 | **Fio token expiruje (180 d) bez alertu** | `CLAUDE.md` + `fio-payments.post.ts`, žádný health check | tichý výpadek párování plateb |

### 1.3 Co je 100% manuální — dominantní dřina

Tvorba a údržba inzerátu je **objemově největší práce adminu** a dnes nemá žádnou serverovou
asistenci v zápisové cestě (`grep` v `item/[id].put.ts` + `itemRepo.ts` = **0** auto VIN/translate):

1. **Tvorba inzerátu** — 20+ polí (General + Vehicle), `ItemDetailGeneral.vue`,
   `ItemDetailVehicle.vue`. VIN decode je asistovaný, ale ruční klik + review.
2. **Popisy + highlights × 12 locale** — `ItemDetailDescription.vue`,
   `ItemDetailHighlights.vue`. DeepL je ruční trigger per item a pokrývá jen 8/12 (ar/hr/me/rs
   ručně vždy). Highlights vyplňované ručně per locale.
3. **Foto upload/řazení** — `ItemDetailImages.vue`, 1 soubor / 1 POST (`uploads.post.ts`).

---

## 2. Návrhové principy (z deep research, kotvené)

Zkráceno; plné citace v `scratchpad/deep-research.md`.

1. **Confidence-banded, nikdy binárně** — auto-akce jen na extrémech skóre, „střed" do
   lidské fronty. Skóre je signál, ne verdikt. (moderationapi, OpenAI moderation)
2. **„Draft, neodesílej"** u peněz/smluv/reputace; „AI-first, human-always-available" >
   „AI-only" (Klarna a její revert). (Anthropic, Intercom Fin)
3. **HITL = explicitní work-queue** se stavy, SLA timerem a auto-eskalací — ne CRUD tabulka
   ani Slack vlákno. (maviklabs, Stream)
4. **Dlouhé ops = event/webhook-driven state machine s deadline timery** (disputes,
   settlement). (Stripe disputes)
5. **Transactional outbox + immutable audit log = jeden zápis**; consumeři idempotentní.
   (microservices.io, gaevoy)
6. **Maker-checker** u nevratných akcí, vynucené v kódu (`maker_id ≠ checker_id`). (opcito)
7. **Quality gate dělá auto-publish bezpečným** — kalibrovaný, per language-pair, re-tuned
   (MT i moderace). (cApStAn COMET ≥0.81)
8. **Enrich, ale needůvěřuj naslepo** — admin confirm krok; enrichment cachuj durably
   (VIN/překlad zaplať jednou). (Vincario + `vin_decode_cache`)
9. **Default workflow, ne autonomní agent**; složitost přidávej jen když měřitelně pomáhá.
   (Anthropic „Building Effective Agents")
10. **Cost discipline jako constraint** — prompt cache (~0.1× input), Batch API (−50%),
    model routing (Haiku na bulk klasifikaci), evals povinné. (Claude pricing)
11. **Bulk import = desired-state replacement, crash-safe** (nevalidní/prázdný feed = no-op).
    (ECG/iCAS)
12. **Fraud v aukci = doménové graph signály** (shill: frekvence/timing/increment/affinity).
    (debexpert, arXiv 1812.10868)

---

## 3. Architektura reworku — 4 vrstvy

### Vrstva 0 — Foundations (connective tissue)

Tenké, generické, postavené na existujících primitivech. Bez nich je „automatizace" slepá.

**0.1 `job_runs` tabulka + „Operations" admin stránka** (řeší D3, D8)
Každý cron na konci zapíše `job_runs(job, started_at, finished_at, ok, counts_json, error_text)`.
Nová stránka `/admin/ops` čte poslední běhy + zvýrazní stáří (Fio > 10 min = červená; Fio
token < 30 dní = warning). Reuse: zápis v témž duchu jako `notify` best-effort; stránka přes
`useAdminPagedResource`. *Levné, vysoká hodnota — okamžitá viditelnost tichých výpadků.*

**0.2 `audit_log` (transactional)** (řeší D4)
Append-only `audit_log(actor_id, action, entity, entity_id, before_json, after_json, at, ip)`,
zapisovaný **ve stejné tx** jako admin mutace (outbox/audit pattern). Začni u nevratných:
item delete, dispute resolve, grant-admin, ban, settle override. *Nezavádět hned plný event-bus
— jen audit jako projekce zápisu.*

**0.3 Generická review-queue (HITL)**
Jedna tabulka `review_tasks(kind, ref_id, state, assignee_id, sla_due_at, payload_json,
created_at)` se stavy `pending → in_review → resolved/rejected`. Pohání disputes, Q&A moderaci,
ratings moderaci, reconciliation. Cron `escalate-review-tasks` přes **claim-CAS na `sla_due_at`**
(stejný pattern jako `claimNewsletterSend`) auto-eskaluje propadlé. *Jedna abstrakce, 4
konzumenti — nestaví se 4× to samé.*

**0.4 LLM wrapper `server/utils/ai.ts`**
Jeden vstupní bod pro Claude: structured outputs (schema-enforced), prompt caching, Batch API
pro ne-urgentní (bulk klasifikace/překlad/VIN backfill), `captureServerError`, feature flag
`public.aiEnabled` (parita s `recoEnabled`/`deeplEnabled`). Model routing: Haiku na klasifikaci,
Opus na generování popisu. *Žádné volání Claude mimo tento wrapper.*

### Vrstva 1 — Listing automation (dominantní dřina)

> **Implementační invariant:** enrichment (VIN decode, překlad, LLM popis) **nikdy neběží
> synchronně v zápisové cestě** `PUT /api/admin/item/:id` — výpadek Vincaria/DeepL/Claude by
> jinak shodil/zpomalil uložení nebo zablokoval publikaci. Spouštěj přes job/queue
> (reuse `enqueueEmail`-style + best-effort `notify` pattern), výsledek dopiš a chybu zviditelni
> v `/admin/ops`. Princip #8 (enrich-then-confirm) + best-effort z Vrstvy 0.

**1.1 Auto VIN-enrich v zápisové cestě**
V `createItem`/`updateItem`: je-li `vin` vyplněný a vehicle sloupce prázdné → server-side decode
(durable cache ⇒ zdarma pro známý VIN). Reuse `vinDecodeRepo` + `vincarioNormalize`. Admin pak
jen **potvrzuje** (princip #8), ne opisuje. Pozn.: dávkový import potřebuje vlastní rate-limit
bucket (dnes `admin-vin-decode` 30/min per admin).

**1.2 LLM-draft popisu + highlights ze structured specs** (`ai.ts`, structured output)
Z VIN/specs vygeneruj **návrh** CZ popisu a highlight řádků → admin edituje a uloží
(draft-neodesílej). Highlight labely lze předvyplnit z `CategoryParam` presetů + VIN. *Cílí na
toil #1/#2 z 1.3.*

**1.3 Auto-překlad při `hidden → visible`**
Při flipu viditelnosti (`updateItem`) přelož prázdné locale: DeepL pro 8 podporovaných (reuse
`/api/translate`), **Claude pro ar/hr/me/rs** (DeepL je neumí). **Glossary/termbase** pro
model/trim/brand (konzistence napříč 12 locale, princip #6/#7). Quality gate: u kritických
locale nech draft k revizi, u zbytku auto. Fallback sweep: existující CLI
`scripts/translate-descriptions.ts` jako cron.

**1.4 Bulk/feed import** přes existující `grg_` API token + `POST /api/admin/item`
(už dnes možné). Přidej desired-state importer (princip #11): nevalidní feed = no-op,
chybějící inzeráty → auto-hide, ne smazat.

**1.5 Foto**: min-photo gate na Save; bulk upload endpoint (dnes 1 soubor/POST); volitelně
quality/damage flag **jen jako review signál**, ne verdikt (research Area 1 #3).

### Vrstva 2 — Ops & moderation (HITL fronty nad Vrstvou 0.3)

**2.1 Disputes UI** (řeší D1 — priorita #1)
Stránka `/admin/disputes`: `listAll` (doplnit do `disputeRepo`) + detail s „Move to review" /
„Resolve" (existující endpointy) + textarea resoluce. Napoj na `review_tasks` se **SLA
auto-eskalací** `open → review` po N dnech (cron, claim-CAS). LLM **návrh** resoluce
(draft-neodesílej). Modeluj jako state machine řízenou událostmi (research Area 5).

**2.2 Q&A globální moderace** (řeší D5 — cheap win)
Stránka nad **už existujícím** `GET /api/admin/questions` (bez `itemId`). Confidence-band:
auto-publish „bezpečných" (bez odkazů/profanity), auto-hide spamu, zbytek do fronty; LLM-draft
odpovědí k revizi (research Area 3+4).

**2.3 Ratings moderace** (řeší D6)
Doplnit `deleteRating`/`flagRating` + fronta. Fake-review signály grafové/heuristické
(ne jen text jednoho ratingu, research Area 3 #6).

**2.4 Reconciliation fronta** (řeší D7)
Formalizuj Fio `unmatched` do `review_tasks(kind='reconciliation')` + UI: auto-clear přesné
shody, výjimky do fronty s audit trailem (research Area 6 #4).

### Vrstva 3 — User & risk

**3.1 User management** (řeší D2): napoj `deleteUser` na existující `softDeleteUser`;
`resetPassword` přes Firebase Admin; **grant-admin z UI** přes `requireInteractiveAdmin`
(už používá `api-tokens`); maker-checker u ban/delete (princip #6).

**3.2 Risk/fraud**: shill-bidding heuristiky (doménové graph signály), KYC flag nad prahem
(vysoká hodnota), dunning/smart-retry na failed settlement (research Area 6 #6) — vše jako
signály do fronty, ne auto-block.

---

## 4. Roadmap (impact × safety × effort)

| Fáze | Obsah | Proč teď | Riziko |
|---|---|---|---|
| **F1 — Zavři díry** (UI nad existujícím BE) | Disputes UI (D1), Q&A globální fronta (D5), user-mgmt stuby (D2), `/admin/ops` + `job_runs` (D3/D8) | nejvíc bezpečnosti/hodnoty za nejmíň práce; backend většinou hotový | nízké |
| **F2 — Listing AI enrichment** | `ai.ts` wrapper, auto VIN-enrich (1.1), LLM draft popis/highlights (1.2), auto-překlad na publish (1.3) | dominantní dřina; draft-neodesílej drží riziko nízko | střední (LLM kvalita → quality gate + review) |
| **F3 — Fronty + audit** | `review_tasks` (0.3) + `audit_log` (0.2), ratings moderace (2.3), reconciliation fronta (2.4) | jakmile je víc auto-akcí, je potřeba HITL + auditovatelnost | střední |
| **F4 — Risk/fraud + bulk** | shill/KYC/dunning (3.2), feed import (1.4) | navazuje na fronty a audit | vyšší (doménové ladění) |

---

## 5. Co NEDĚLAT (anti-patterns z research)

- **Nezaváděj Temporal/event-bus/Retool teď** — bespoke Nuxt admin + cron + status sloupce
  stačí; durable execution až když to začne skřípat (research Area 7 #4, #6).
- **Negeneruj „rules engine" tabulku, dokud nemáš 3 konkrétní pravidla** (YAGNI; gap #8 z
  automation inventory je reálný, ale řešit ho generikou předčasně = over-engineering).
- **Neauto-odesílej** peníze/smlouvu/resoluci disputu; **neauto-publikuj** přeložené specs/popisy
  bez confirm nebo quality gate.
- **Neřeš dispute jako jeden bucket**; neoptimalizuj win-rate přes dispute *ratio*.
- **Nepřekládej vším jedním globálním MT**; jeden QE práh přes všechny páry; MT bez termbase.
- **Neškáluj fronty na accuracy target, ale na lidskou kapacitu** (~2–3 % flagged; eskalace
  10–15 % zdravá, > 25 % = „routuju všechno").

---

## 6. Začni tady (top 5, konkrétně)

1. **`/admin/disputes`** — `disputeRepo.listAll` + stránka nad `review/resolve` endpointy.
   Soubory: `server/repos/disputeRepo.ts`, nová `pages/admin/disputes.vue` +
   `features/.../logic/useDisputeList.ts`. *Největší bezpečnostní díra, backend skoro hotový.*
2. **Q&A globální fronta** — stránka nad existujícím `GET /api/admin/questions`.
   Soubory: nová `pages/admin/questions.vue`, reuse `useAdminQuestions`. *Cheap win.*
3. **`/admin/ops` + `job_runs`** — migrace tabulky + zápis na konci každého cronu + stránka.
   Soubory: `server/migrations/NNN-job-runs.ts`, patch 5 cron utilů, `pages/admin/ops.vue`.
4. **User-mgmt stuby → realita** — `deleteUser`→`softDeleteUser`, grant-admin endpoint +
   tlačítko. Soubory: `useUserDetail.ts`, nový `server/api/admin/user/[id]/role.post.ts`.
5. **`server/utils/ai.ts`** — wrapper (structured output + cache + batch + flag) jako základ
   pro F2. *Bez něj se LLM práce rozsype po kódu.*

---

## Appendix — evidence & zdroje

- Plné discovery reporty: `scratchpad/admin-frontend.md`, `admin-backend.md`,
  `automation-inventory.md`, `deep-research.md` (32+ fetchnutých URL, 4 re-ověřené).
- Klíčové ověřené absence: `audit_log`, `cron_runs`, `automation_rules`, `outbox` —
  negrepnuto ve `server/db/schema.ts` (existující tabulky vyjmenovány tamtéž).
- Klíčové ověřené „už existuje": `questions.get.ts` globální fronta, `userRepo.softDeleteUser`,
  `settleCore.ts` CAS, `emailQueue.ts`, `requireInteractiveAdmin`.
