# Vylepšení outreach-dashboardu — plán

**Status:** Aktivní (Sprint A + B z větší části hotové, viz #1241)
**Datum:** 2026-05-12
**Trigger:** Po sprintu mail-clienta a první spam-diagnostice ukázal session log
opakující se vzory bolesti — pady BFF procesu, mismatch mezi UI a backend
modelem (negativní IDs pro orphan replies), tři vrstvy ovládání kampaní,
„dead code" v podobě nevyužitých stránek a mrtvých cronů. Tahle iniciativa
shrnuje, co dál postavit, co konsolidovat a co rovnou smazat.

## Kontext

Dashboard se rozrostl na **26 React stránek (13.5k řádků)** a **46 BFF route
modulů (12.3k řádků)** s **19 cron joby**. Růst byl spontánní — každý sprint
přidal kus surface, ale málokdo se vracel mazat. Testy nemají rovnoměrné
pokrytí: contract (mocked pool) má 125 testů na 60 % endpointů, integration
tier má jen 8 testů na 46 routes. Dev loop neměl BFF hot-reload (vyřešeno
Sprintem A2), takže každý merge dotýkající `server.js` znamenal manuální
restart.

Současné bolesti v session logu byly opakující se:

- BFF Node proces padal na pool race conditions (5 fix commitů poslední 3 týdny)
- Orphan inbound (`unmatched_inbound` s negativním ID v `/api/replies` UNION)
  nebyl systémově podporovaný — 4 endpointy musely dostat větev pro záporné ID
- Operátor přepíná kampaně přes tři vrstvy (BFF API, Go orchestrátor, přímé
  SQL) bez jednotného audit trailu
- Email odeslání trénovaným Gmail spam filtrem — vyřešeno přepnutím egress
  z Mullvad na Railway direct, ale to byl provizorní hardcode bez UI ovládání

Plán je rozdělen do **šesti sprintů** (A–F). Sprinty A a B z větší části
hotové. Sprint C je tah na fragmentaci kampaní jednou vrstvou. D je test
coverage rebalanc. E je kód-organizace (rozsekání megastránek, konsolidace
helperů). F je polishing operátorského workflow.

Sedmý sprint (G — decommission) běží průběžně.

## Sprint A — BFF stabilita a dev workflow ✅ převážně hotovo

- ✅ **A1** (#1242, PR #1246): scheduleCronSafe wrapper + audit ratchet pro
  bare-async timer callbacks. Eliminoval pattern, který položil BFF v PR #1239.
- ✅ **A2** (#1243, PR #1245): BFF hot-reload přes `node --watch` v `pnpm dev`.
  Edit src/server-routes/*.js → restart do 2s.
- 📋 **A3** (#1244): IMAP cross-container fix. Parkováno — vyžaduje
  architecture decision (relay HTTP proxy vs polling přesun do orchestrátoru).

## Sprint B — Orphan replies first-class ✅ převážně hotovo

- ✅ **B1** (#1247, PR #1250): `src/lib/repliesRepository.js` s findById /
  setHandled / setClassification — eliminace 4× duplikované `if (rawId < 0)`
  větve. 19 nových unit testů.
- ✅ **B2** (#1248, PR #1252): unmatched_inbound_attachments tabulka +
  body_html sloupec (migrace 103), orchestrator parkUnattributed extrahuje
  MIME attachments + body_html, BFF endpoints `/api/replies/:id/attachments`
  (list) + `/api/messages/:id/attachments/:idx` (stream), ThreadDetail UI
  strip „Přílohy odesílatele".
- ✅ **B3** (#1249, PR #1251): ThreadDetail HTML render přes
  isomorphic-dompurify s ALLOWED_TAGS + afterSanitizeAttributes hook.
  20 nových XSS testů.
- 📋 **B4** (#202): Replies.jsx subject-as-body mapping cleanup.

## Sprint C — Sjednocené ovládání kampaní

Aktuálně pause/resume/throttle žije na třech místech (BFF API, Go API,
přímý SQL UPDATE jako fallback). Operátor neví, který je „pravý",
audit log se rozpadá, a fallback path na BFF přepíše DB bez záznamu v
`operator_audit_log`. K tomu chybí UI ovládání rychlosti — operátor si
musel teď spacing nastavit přes env var na Railway službě.

Sprint zavede **single source of truth na Go orchestrátoru**: BFF API se
stane dumb pass-through (žádný DB fallback, jen proxy se sjednoceným audit
záznamem). `CampaignDetail.jsx` dostane inline ovládací panel:
play/pause toggle, slider pro `daily_cap_override` (s validací proti
`lifecycle_phase` capu, který teď půjde i nahoru per migration 102), input
pro `MAILBOX_MIN_SPACING_SECONDS` na úrovni kampaně (ne env), historie
stavu z `operator_audit_log` (kdo, kdy, z čeho na co).

## Sprint D — Test coverage rebalanc

Integration tier (real pg-mem DB) má 8 testů na 46 route modulů. Většina
spoléhá na contract tier s `vi.mock` poolem, který nezachytí SQL syntax
chyby ani schema drift. Sprint nevykonává „dohnat 80%" — ale **klíčové
operátorské flowy musí mít integration test**: reply triage (negativní +
kladné ID), pause/resume kampaně, contact import, mailbox health cycling,
suppression UNION. Cíl je +25 integration testů, plus audit ratchet,
který blokne nový BFF route bez integration testu (podobně jako AR6
blokne nový cron bez `scheduleCron`).

## Sprint E — Kód organizace

Tři megastránky překračují rozumnou hranici: **Companies.jsx (1835),
Mailboxes.jsx (1322), ThreadDetail.jsx (1264)**. Mailboxes obsahuje
nested MailboxDrawer 3 úrovně hluboko, Companies má 200+ řádků
normalizace + Score Breakdown. Ne kvůli „velký soubor = špatný", ale
protože tyhle stránky operátor používá denně a dnes je pro ně každá
změna riziková.

Sprint je split do tří PR jeden na stránku. Mailboxes → vytáhnout
`MailboxDrawer`, `MailboxList`, `MailboxHealthCard`, `MailboxFiltersBar`
jako samostatné soubory. Companies → vytáhnout `ScoreBreakdown`,
`CompanyFacetsBar`, `CompanyTimeline`. ThreadDetail → vytáhnout
`MessageBubble`, `ReplyComposer`, `OrphanBodyPanel`. Zároveň
**konsolidovat čtyři kopie `api()` helperu** (Replies, ThreadDetail, Inbox,
CampaignDetail) do `src/lib/api.js` — jediný importovatelný klient.

## Sprint F — Operátorský polish

Issue list ukazuje, co operátor reálně chce a co dnes chybí: real-time
SSE pro `/replies` (#1019), date range filtry Dnes/Týden/Měsíc (#911),
per-mailbox IMAP/SMTP diagnostic button (#910), per-contact reply history
v draweru (#862). Žádná z těchto věcí není blocker, ale dohromady udělají
hodinu operátorské práce výrazně příjemnější.

## Sprint G — Decommission (průběžně)

Část kódu nikdo neuvidí, ale udržujeme ji. Kandidáti na smazání jsou
v master tracking issue #1241.

## Co tahle iniciativa nepokrývá

- **Deliverability a content** — to je samostatná osa řešená teď
  paralelně (egress přepnutý na Railway direct, kampaň 457 paused, čeká
  na operátorské rozhodnutí o vlastní doméně / cold-outreach platformě).
- **Anti-trace anonymity** — operátor explicitně zvolil trade-off ve
  prospěch deliverability. Pokud se rozhodnutí otočí, je to nový plán.
- **AI/LLM klasifikace replies** — Sprint S19 + KT-B série, samostatný
  track. Tento dashboard plán s ním nesouvisí, jen ho používá.
