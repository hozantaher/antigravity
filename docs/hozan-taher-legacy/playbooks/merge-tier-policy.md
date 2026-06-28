# Merge Tier Policy — formální klasifikace PR pro auto-merge

> **Status:** living dokument. Kodifikuje praxi, kterou orchestrator (AI) a operátor
> používají od okamžiku, kdy GitHub Actions billing začal padat systémově a
> `gh pr merge --admin` se stal každodenním nástrojem.
> **Související playbooky:** [`ci-bypass.md`](./ci-bypass.md) (kdy obejít červené
> checky) a [`audit-merges` JSONL](../audits/admin-merges.jsonl) (auditní stopa).

---

## Proč tato politika existuje

Za poslední měsíc se ukázalo, že GitHub Actions na tomhle repu padají častěji
kvůli infra šumu (vyčerpaný billing, runner-image regrese, Railway PG timeouty)
než kvůli reálným chybám v kódu. To znamená, že kdybychom čekali na zelené CI
před každým mergem, deploy by stál týdny. Zároveň ale nemůžeme dovolit, aby se
`--admin` bypass používal libovolně — některé PR mění auth, šifrování, schéma
databáze nebo anti-trace-relay vrstvu, a tam je riziko reálné. Proto klasifikujeme
každý PR do jedné ze tří tříd a pro každou třídu máme jiný proces. Cíl: rychlost
tam, kde riziko není, péče tam, kde riziko je.

Tahle politika nezavádí nové pravidlo — pouze sepisuje, co už od PR #325 a #326
de-facto děláme. Nově je to formální dokument, na který se dá odkazovat při
review nebo retro.

---

## Tier A — Auto-merge eligible (orchestrator může admin-mergnout)

**Co sem patří:**

- Změny pouze v dokumentaci (`docs/`, jakýkoli `**/*.md` mimo CLAUDE.md root).
- Změny pouze v testech (`**/*_test.go`, `**/*.test.{js,ts,jsx,tsx}`,
  `**/*.spec.{js,ts,jsx,tsx}`).
- Drobné PR pod 50 řádků diff, kde součástí změny jsou testy pro nové chování.
- Dependabot patch updates s prošlými testy.
- Chore/lint/format-only commits (gofmt, prettier, eslint --fix bez sémantických
  změn).
- Komentáře, JSDoc, godoc, type aliases bez změny runtime chování.

**Proces:**

1. Orchestrator (AI) přečte diff a ověří, že změna patří do A.
2. Lokálně (pokud testy jsou) spustí `go test ./...` nebo `pnpm test` v dotčeném
   modulu.
3. Pokud červené checky na PR jsou všechny systémové podle `ci-bypass.md`,
   může orchestrator `gh pr merge --admin --squash`.
4. Hned po mergi append řádek do `docs/audits/admin-merges.jsonl` s
   `tier: "A"`, classifikací důvodu a citací operátorova souhlasu (může být
   dlouhodobý: "tier A blanket approval per merge-tier-policy.md").
5. Operátor revizí auditu může kdykoli zpětně vidět všechny tier-A merge.

**Riziko:** minimální. Tier A se dotýká buď jen textu, nebo jen testů — pokud
test sám obsahuje bug, nemůže tím rozbít produkci, jen sebe sama.

---

## Tier B — Lab, scaffolding, UI features (orchestrator může admin-mergnout, ale s explicitním souhlasem)

**Co sem patří:**

- Mail Lab a operator-practice sandbox kód (`services/mail-lab/**`,
  `features/platform/operator-practice/**` — striktně izolované od produkce LAB_ONLY
  gate).
- Frontend UI features v `features/platform/outreach-dashboard` bez dotyku auth nebo billing
  flow (nové stránky, komponenty, design system, drobné refactory).
- Performance optimalizace s testy (cache, indexy bez DDL, batch query
  refactor).
- Bug fixy v cestách mimo auth / payment / migration / anti-trace-relay /
  suppression list.
- Feature flag toggles, kde flag je už deployed a fix je jen přepnutí stavu.
- Refactor s plně zelenou test suite a beze změn ve veřejných API kontraktech.

**Proces:**

1. Orchestrator přečte diff a klasifikuje. Když si není jistý, volá tier C.
2. Spustí lokálně relevantní subset testů (`pnpm test` v dotčeném modulu nebo
   `go test ./...` v dotčených balících) a ověří race-clean.
3. Citaci operátorova souhlasu uloží do `operator_approved` pole auditu —
   buď z aktuální session ("Tomáš direct: 'Pracuj.' YYYY-MM-DD"), nebo pokud
   operátor delegoval ("blanket B per delegated authority YYYY-MM-DD").
4. `gh pr merge --admin --squash` plus audit log řádek.
5. Pokud post-merge vyjde najevo regrese, orchestrator otevře revert PR a
   označí ho v auditu zpětně (`reverted_in: PR #N`).

**Riziko:** mírné. Tier B se dotýká kódu, ale ne kritické cesty. Sandbox kód
je z definice izolovaný (LAB_ONLY environment gate), UI změny mohou rozbít
zobrazení, ale ne data. Bug fixy mimo critical path mají úzký blast radius.

---

## Tier C — Operátor-only (orchestrator NIKDY nemerguje)

**Co sem patří:**

- Auth a authorization kód (`**/auth*`, `**/login*`, `**/session*`,
  cokoli pracující s X-API-Key, JWT, OIDC, password hashing).
- Unsubscribe a HMAC token generace (`**/unsubscribe*`, `**/hmac*`,
  HMAC secret management).
- Sentry konfigurace, CSP headers, rate-limiting middleware
  (`**/sentry*`, `**/csp*`, `**/ratelimit*`).
- Anti-trace-relay vrstva (`features/outreach/campaigns/sender/antitrace*`,
  proxy chain logic, SOCKS5 routing, Mullvad wireproxy konfigurace).
- Schéma migrace (`scripts/migrations/*.sql`, jakákoli DDL).
- Suppression list logic (`**/suppression*`, dual-table sync triggers).
- Payment / billing endpointy (pokud se v projektu objeví).
- Změny v `CLAUDE.md` root, `.githooks/`, `.github/workflows/` definicích.
- Cokoli, co rotuje secrets nebo mění SMTP transport mode (TRANSPORT_MODE
  banned values).

**Proces:**

1. Orchestrator otevře PR s plnou popisem, draftuje review notes, ale **netiskne
   merge**.
2. Operátor přečte diff per řádek, spustí relevantní extreme-testing battery
   (10+ test cases, boundary, error, integration, property/race kde má smysl).
3. Operátor sám provede merge — buď `--admin` s explicitním záznamem v auditu
   `tier: "C"` a citací důvodu, nebo (pokud CI je zelené) standardní `--squash`.
4. Pokud orchestrator narazí v rozhodování na tier C a operátor není dostupný,
   PR čeká. Žádné spěchové rozhodnutí.

**Riziko:** vysoké. Bug v tier C kódu se projeví v produkci jako rozbité
přihlášení, dead unsubscribe link (porušení Art. 13/2/b GDPR), poškozený
schéma, leak suppression list, nebo SMTP egress mimo proxy (HARD RULE
violation — viz `feedback_no_direct_transport`). Operátorská kontrola je
poslední bezpečnostní pojistka.

---

## Jak klasifikovat PR

Postup je deterministický a má jasné pořadí:

1. **Path-based test první.** Pokud diff obsahuje jakýkoli soubor matching
   tier C path patterns výše → tier C, konec rozhodování. Path-match je
   silnější než scope-match, protože i drobná změna v auth souboru může mít
   nepoměrný dopad.

2. **Scope-based test druhý.** Pokud path-test neselektoval tier C, podívej
   se na velikost a charakter změny:
   - Diff < 50 LOC + obsahuje testy + není v critical path → tier A.
   - Diff v lab/UI/scaffolding cestě, lokálně zelené testy → tier B.
   - Cokoli jiného → operátor rozhodne (default tier B s explicitním
     souhlasem, nebo eskalace na tier C, pokud orchestrator vidí byť
     drobnou možnost dotyku auth/migration/anti-trace).

3. **Pochybnost = vyšší tier.** Když si orchestrator není jistý, klasifikuje
   nahoru. Lépe nechat operátora se podívat na PR, který šel prejít, než
   admin-mergnout PR, který měl jít přes operátora.

---

## Audit log

Každý `--admin` merge zapisuje jeden JSON řádek do
[`docs/audits/admin-merges.jsonl`](../audits/admin-merges.jsonl). Formát je
dán existujícím baseline (PR #325 a #326) a nezmění se bez ADR. Povinná pole:

- `ts` — ISO timestamp UTC
- `pr` — číslo PR
- `title` — PR title
- `tier` — `"A"`, `"B"`, nebo `"C"`
- `reason` — proč tahle klasifikace + tail logu systémových selhání
- `failed_checks` — pole názvů červených checků, všechny musí být
  klasifikovány jako systémové podle `ci-bypass.md`
- `reviewer` — `"orchestrator (AI)"` nebo `"Tomáš"` nebo kombinace
- `local_tests` — co se lokálně spustilo a kolik testů prošlo
- `operator_approved` — citace souhlasu nebo odkaz na blanket approval

JSONL je append-only a strojově čitelný. Retro analýza:

```bash
jq -s 'group_by(.tier) | map({tier: .[0].tier, count: length})' \
   docs/audits/admin-merges.jsonl

jq -r 'select(.tier == "C") | "\(.ts) PR#\(.pr) \(.title)"' \
   docs/audits/admin-merges.jsonl
```

---

## Operátorův sign-off této politiky

Operátor (Tomáš) potvrzuje tuto politiku jedním z:

- PR komentář se slovem "approved" nebo "souhlasím" na PR, který tento
  dokument zavádí.
- Commit author = Tomáš na commitu, který tento dokument přidává.
- Explicitní citace v session ("Souhlasím s merge-tier-policy"), kterou
  orchestrator zapíše do `operator_approved` pole prvního auditu, který se
  na tuto politiku odkazuje.

Bez sign-off zůstává tahle politika draft — orchestrator se chová tak, že
**všechny PR jsou tier C**, dokud operátor nepotvrdí.

---

## Revize a memory rules

Tahle politika není vytesaná do kamene. Mění se, když praxe ukáže, že
hranice tříd jsou špatně. Změna je jako u ADR — nový PR, operátor reviewuje,
nový sign-off. Verze se neuvádí; git history je historie verzí.

Související memory rules, které tuto politiku podpírají:

- `feedback_critical_pushback` — když orchestrator zkusí admin-mergnout PR,
  který má tier C path match, má pushnout zpět: "tohle je tier C, čekám
  na operátora".
- `feedback_stack_merge_delete_branch` — i pro tier A/B merge se odstraňuje
  branch po squash, aby se stack PR ceremonie nehromadila.
- `feedback_no_speculation` — klasifikace stojí na měřitelných path patterns
  a velikosti diffu, ne na intuici.
- `feedback_human_readable_tasks` — důvod v auditním řádku je v lidské
  češtině, ne v engineer fragmentech (špatně: "ci-bypass tier B local
  green"; dobře: "feature s lokálně zelenými testy v UI cestě, mimo
  auth/billing").

---

## Co tato politika **není**

- Není pojistka proti chybě v kódu. Code review (orchestrator + operátor)
  se dělá vždy, bez ohledu na tier.
- Není povolení k bypassu reálných selhání. Reálné test failures, lint
  errors, type errors, security findings — to nikdy. Tier rozhoduje pouze o
  tom, **kdo** stiskne merge, a pouze pokud červené checky jsou systémové.
- Není seznam "rychlých výjimek". Tier A není zkratka, je to klasifikace
  rizikové třídy. Když diff přesáhne 50 LOC nebo přidá závislost, už není
  tier A, i kdyby šlo o "jen drobnost".
- Není trvalá; reviduje se, když praxe ukáže, že path patterns vynechávají
  reálnou rizikovou kategorii.
