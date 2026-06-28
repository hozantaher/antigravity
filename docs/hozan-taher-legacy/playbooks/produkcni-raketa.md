# Playbook: Produkční raketa (autonomní BIG-WIN loop)

> **Účel:** plná metodika autonomního dashboard-quality + data-linking loopu.
> Cron prompt je jen tenký pointer sem — metodiku edituj TADY, ne v cron stringu.
> **Kompas:** `pnpm scorecard` (features/platform/outreach-dashboard). **Fakty:** CLAUDE.md + memory.

## Proč tenhle dokument existuje

Loop prompt narostl na ~2.5KB scar-tissue (každý incident → další odstavec) a
míchal tři druhy znalostí. Rozdělili jsme je:

| Druh znalosti | Kam patří |
|---|---|
| Trvalé projekt fakty (leady=vozidla, Schema-A, PII, egress) | `CLAUDE.md` + memory (T0) |
| Kde je práce (slack) | `pnpm scorecard` — jediný zdroj |
| Incident-lekce co JDE vynutit strojově | audit testy (`tests/audit/*`) |
| Incident-lekce co je judgment call | tento playbook (checklist níže) |
| Metodika (KROK 0/1/2) | tento playbook |
| Stav napříč ticky | lokální tick-log (`pnpm scorecard:log` → `reports/scorecard-log.jsonl`, gitignored — loop je local-only, soubor přežívá sessions na stroji) |

Princip: **jizvy → guardraily v kódu, ne připomínky v próze.** Když lekce JDE
převést na test, převeď ji a smaž z playbooku. Když nejde (viz "empty catch"
níže), zůstává jako checklist — ale to je výjimka, ne default.

## Severní hvězda

Maximálně automaticky propojit všechna data (≈426k firem, ≈405k kontaktů,
odpovědi, schránky, vozidla, CRM). Hodnota = správné automatizované propojení,
ne další data. **"leady JSOU vozidla"** — samostatný leads funnel je mrtvý
(/leads redirected 2026-05-15); reálný pipeline = Vozidla inventory (hot reply →
vozidlo, status offered→…→picked_up). Propojení DETERMINISTICKY (regex/IČO/email);
LLM (Ollama) nikdy auto-neaplikuje zápis. Žádné PII inline.

UX směr = aplikace Claude: klid, fokus, whitespace, jasná hierarchie, minimální
chrome, žádná falešná "0".

## KROK 0 — Self-regression (vždy první)

`git log -1` → ověř výstup minulého ticku na ŽIVÝCH datech (DB spot-check +
re-screenshot dotčeného surface). Vlastní čerstvá feature = nejpravděpodobnější
regrese. Rozbité oprav dřív než cokoliv nového.

Spusť `pnpm scorecard:diff` jako rychlý regression-radar: **↑ na quality řádku
(nebo na linkage co měl klesat) = regrese z minulého ticku — oprav HNED**, dřív
než nový Big Win. Quality řádky na 0 jsou regression-guardy; diff ukáže když
zčervenají.

## KROK 1 — Scorecard + breadth audit

1. `pnpm scorecard` → NULL-FK linkage slack + **data-quality smells** (sekce
   `quality:` — misclassified-positive, unclassified replies; lower=better,
   regression-guardy pro dřívější quality winy). `pnpm scorecard:log` zapíše
   snapshot do tick-logu (trend napříč sessions). `pnpm scorecard:diff` ukáže Δ
   vs poslední snapshot (↓ lepší / ↑ horší / =) — "co se změnilo od minula" na
   jeden pohled, ne ruční porovnávání JSONL. Scorecard = linkage I kvalita.
2. **SCORECARD-SMELL:** řádek co se N ticků nehne = SMELL. NEreportuj slepě.
   Ověř join proti kódu co píše ten FK (grep Go+BFF writer). Možnosti: měří
   špatný klíč/populaci / cílová entita je MRTVÁ / práce je jinde.
   - **AGGREGATE LŽE, EYEBALL NE:** SMELL check NESMÍ skončit u SQL breakdownu
     (count per classification apod.) — MUSÍ přečíst ~5 skutečných řádků
     (body_text). Dnešní incident: reply→vehicle=52, count řekl "40 positive =
     reálné hot leady", ale přečtení bodies odhalilo že (a) classification je
     nespolehlivá (jasné NE "nehodláme prodávat" taggnuté jako positive), (b)
     keyword match chytá signatury / citovaný původní mail / negace. Metrika
     overstatuje stejně jako reply→lead 106. Heuristický keyword/aggregate gap
     = vždy podezřelý dokud nepřečteš řádky.
3. Breadth: proscreenshotuj VŠECHNY hlavní surfacy (Odpovědi, Kampaně, Schránky,
   Firmy, Vozidla, Kontakty, CRM) authnutým Playwrightem (cookie
   `operator_id=operator`, Vite :18175), dark i light.
   - **MUSÍ čekat na reálná data** (content assertion / networkidle), NE fixní
     timeout — těžké listy + store loadAll 3-6s; fixní wait fabrikuje phantom
     "prázdno/0".
4. **Ověř před akcí:** curl API + DB count + advertised param FUNGUJE. Data i
   screenshot jsou rovnocenné bug-findery.

## KROK 2 — Vyber JEDEN Big Win (max 1/tick, čistý reviewable commit)

Typ: (a) nové automatické propojení/sync, (b) regression-fix z Kroku 0,
(c) contract/UX-polish.

**Gates PŘED stavbou (z reálných incidentů):**

- **VERIFY-ENTITY-LIVE:** než "opravíš" linkage gap, ověř že cílová entita je
  ŽIVÁ — má UI surface, čte ji aktivní kód, NENÍ redirected-away (grep route
  redirecty + komentáře `never used`/`deprecated`/`dead`). Gap u mrtvé entity =
  resurrection dead weight, ne win. *(incident: reply→lead 39→0 gamoval mrtvou
  leads tabulku — commit 2cb55b78 revert.)*
- **ESCALATE-BEFORE-BUILD:** strategický fork / pochybná premisa → zeptej se
  operátora PŘED prvním commitem, ne až po druhém.
- **NO METRIC-GAMING:** nevytvářej řádky jen aby klesla metrika. Metrika co
  spadne na 0 NENÍ automaticky win.
- **SEARCH-BEFORE-WRITE:** než postavíš nový writer/cron, grep zda už existuje
  (Go i BFF). Duplikát writeru je bug. *(reply→lead duplikoval Go upsertLead.)*
- **FORCED ROTATION:** po 2 po sobě jdoucích ticích ve STEJNÉM subsystému příští
  MUSÍ ven — i kdyby tam byl největší gap.
- **NO META-SPIRAL:** "tooling/playbook/scorecard" SE POČÍTÁ jako subsystém pro
  rotaci. Po 2 po sobě jdoucích meta-ticích (vylepšování vlastních nástrojů)
  příští MUSÍ být reálná data/UX práce, ne další tooling. Nástroje slouží práci,
  ne naopak. *(scorecard suite je hotová: run/json/log/diff/quality — nepřidávej
  další leštění bez jasné potřeby.)*
- **DIMINISHING RETURNS:** po ~3 contract/polish ticích bez critical/linking
  winu eskaluj operátorovi se strategickými možnostmi. ALE: "nic actionable"
  smíš prohlásit JEN po ČERSTVÉM breadth screenshotu se console-error sweepem,
  ne jen po scorecardu. Scorecard (SQL) je SLEPÝ na runtime 500/UX bugy.
  *(incident 2026-05-31: eskaloval jsem "nic actionable" ze samotného scorecardu
  — příští tick breadth screenshot hned našel 4× HTTP 500 z chybějícího importu.
  Scorecard čistý ≠ aplikace zdravá.)*

Pro netriviální tick: krátký Plan → Sprints/Phases → TaskCreate/TaskUpdate (jen
co aktivně dělám; multi-session/cross-service backlog → `gh issue`). Smíš pustit
~3 paralelní agenty na DATOVÝ/code audit; vizuální inspekci dělej sám.

**Expand-then-contract:** expand = oprav rozbité propojení + postav automatický
linking/sync (cron/lib, dedup, audit_log, named thresholds) NEBO přegeneruj
nejhodnotnější surface k Claude-app jednoduchosti (loading/empty/error stavy
klidné, nikdy falešná "0"). contract = zahoď dead-code/unused, sjednoť duplicity,
optimalizuj, oprav rozbité nástroje (i scorecard sám).

## Audit-lens checklist (judgment + co je vynuceno testem)

| Lekce | Enforcement |
|---|---|
| Prázdný `catch {}` co polyká business-logic chybu (ztráta dat) | **JUDGMENT** — nelze čistě ratchetnout (14 legit teardown/DNS-miss výskytů). Každý catch v pipeline kolem zápisu/loopu MUSÍ logovat (op+entity_id+error). |
| Tichý NOT NULL / constraint crash v automatice = ztracená data | JUDGMENT |
| Chybějící loading skeleton na těžkém listu = falešná "0" | JUDGMENT (sdílený `<ListSkeleton>` existuje — použij ho) |
| Pattern-generalizace: 2.+ výskyt → grep audit všech výskytů | JUDGMENT |
| Advertised API param/filtr ≠ funkční — curl před stavbou UI | JUDGMENT |
| JOIN ambiguity: kvalifikuj sloupce aliasem když where sdílený joined+bare | JUDGMENT |
| Cron používá `scheduleCron` (jitter) | **TEST**: `tests/audit/ar6-cron-jitter.test.js` |
| Žádný raw SMTP/IMAP socket mimo relay | **TEST**: `tests/audit/no_raw_{smtp,imap}_socket.test.js` |
| Cron bez bare setInterval-async | **TEST**: `tests/audit/cron-safe-no-bare-setinterval-async.test.js` |

> Když objevíš lekci co JDE převést na test → přidej do `tests/audit/`, přesuň
> řádek do TEST sekce, a smaž ji z judgment checklistu. Playbook se zkracuje jak
> roste test suite.

## Kvalita (vždy)

Testuj proporčně risku (unit + Playwright smoke + monkey). Po server-route/
server.js změně `node --check` + restart BFF (`pkill -f 'node server.js'`). Po
migraci verify SELECT + okamžitá aplikace. Build green, žádné NOVÉ faily
(pre-existující ověř stashem). Dlouhá session → `/compact` >150k.

## Uzávěr ticku

Jeden commit s důkazem: živé screenshoty + čísla testů + Δ scorecard (a jestli
Δ je korekce měření vs reálné snížení — buď upřímný). `pnpm scorecard:log`.
Pokud nic kritického, dělej contract.

**APLIKUJ, NEPTEJ SE (operátor 2026-05-31):** na konci každého ticku navrhni
jednu konkrétní úpravu playbooku/loopu A ROVNOU JI PROVEĎ (v tomtéž commitu nebo
příštím ticku) — neptej se "chceš ať to přidám?". Loop se zlepšuje sám každý
tick. Výjimka: strategický fork / pochybná premisa → ESCALATE-BEFORE-BUILD
(ptej se PŘED stavbou, ne po). Drobné tooling/playbook vylepšení = prostě udělej.
