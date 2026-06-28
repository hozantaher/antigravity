# Autonomous Self-Improvement — jak se Claude orchestrátor učí

**Účel:** popsat mechanismus, kterým orchestrátor (hlavní Claude session) postupně zlepšuje své chování bez ručního zásahu uživatele. Dokument je psaný plynulou prózou v češtině per memory pravidlo `feedback_human_readable_tasks` a má sloužit jako referenční materiál pro budoucí sessions, které budou ladit nebo rozšiřovat tento mechanismus.

---

## Proč to vůbec chceme

Tomáš pracuje na hozan-taher v režimu, kdy chce, aby Claude pracoval co nejvíc autonomně — ideálně 24/7 — a uživatel zasahoval jen u destruktivních operací nebo jasných red-line situací (mailbox hesla, transport mode, campaign send). To je explicitně zaznamenáno v memory pravidlech `feedback_autonomous_work`, `feedback_iteration_workflow`, `feedback_no_premature_iteration`.

Problém autonomie je, že každá nová Claude session začíná s prázdnou hlavou — co se v minulé session naučilo, je zapomenuto, pokud se to někam nezapíše. Když se naučí špatně (například opakovaně spekuluje místo toho, aby citoval RFC), je třeba mít mechanismus, kterým se ta chyba zafixuje a dál se neopakuje. Když se naopak naučí správně (například pattern „SSE push + stale-cache cron" pro realtime UIs nebo třívrstvý egress `direct/mullvad/free-pool`), je třeba ten pattern uložit, aby ho příští session mohla rovnou použít místo aby si ho musela znovu vymyslet.

Tomu se říká „autonomous self-improvement" — nejde o nic metafyzického, jen o disciplinovanou kombinaci tří součástek: **memory rules**, **prompt library** a **retrospective agent**.

---

## Tři součástky systému

### 1. Memory rules

Memory rules jsou krátké markdown soubory v adresáři `~/.claude/projects/-Users-messingtomas-Documents-Projekty-hozan-taher/memory/`. Každý popisuje jedno specifické pravidlo, korekci nebo zjištění. Mají dva typy:

- **`feedback_*.md`** — pravidla z reakce uživatele („nedělej X", „vždycky pamatuj na Y"). Příklady: `feedback_no_speculation`, `feedback_no_direct_transport`, `feedback_human_readable_tasks`, `feedback_initiative_status_required`.
- **`project_*.md`** — projektové fakty / patterny, které Claude zjistil prozkoumáním kódu nebo měřením. Příklady: `project_first_campaign_launch`, `project_egress_layered_pattern`, `project_handoff_trailer_protocol`, `project_seznam_proxy_geo_mismatch`.

Klíčový soubor je `MEMORY.md` — index všech pravidel s jednovětným popisem každého. Tenhle index si Claude session načte při startu a může z něj rozhodnout, který detailní soubor potřebuje otevřít.

K 2026-04-30 obsahuje memory adresář 39 pravidel + index. To je už dost na to, aby měla hodnotu, ale ne tolik, aby orchestrátor nestihl index načíst — `MEMORY.md` má aktuálně cca 5 KB.

### 2. Prompt library

Prompt library je adresář `~/.claude/projects/-Users-messingtomas-Documents-Projekty-hozan-taher/prompts/` s parametrizovanými šablonami pro opakující se úkoly. Aktuálně obsahuje:

- `cherry-pick-batch.md` — pro rebase stale PR stacku.
- `sprint-implementation.md` — pro KT-Ax / Sx.y sprint task.
- `design-research.md` — pro initiative / ADR / architecture proposal.

Šablona má placeholdery (`{{PR_NUMBERS}}`, `{{SPRINT_ID}}`, atd.) a sekci „Hard rules", která odkazuje na konkrétní memory pravidla. Když uživatel řekne „udělej rebase stacku PR 103,105,107", Claude otevře `cherry-pick-batch.md`, vyplní `{{PR_NUMBERS}}=103,105,107`, přečte všechna odkazovaná memory pravidla, a pak teprve začne pracovat. Šetří se tím čas a zaručuje se, že se neporuší žádné dříve etablované pravidlo.

### 3. Retrospective agent

Retrospective agent je sub-agent, kterého orchestrátor pouští buď periodicky (cron, například jednou týdně), nebo na žádost uživatele, nebo automaticky při detekci „session-end / work-area boundary" (když dokončí větší celek práce). Jeho specifikace je v zadání, které právě teď čteš jako prompt této session.

Co dělá:

1. Stáhne si poslední 7 dní git aktivity, mergnuté PRs, otevřené PRs, selhané CI běhy.
2. Přečte všechna existující memory pravidla.
3. Přečte 3 nejnovější initiative dokumenty.
4. Hledá patterny:
   - Korekce uživatele v commit messages.
   - Patterny opakované přes 3+ PRs, které ještě nejsou zachycené.
   - Rozhodnutí udělaná v PR komentářích bez ADR.
   - Drift mezi predikovaným a skutečným v initiative dokumentech.
5. Pro každý pattern vyrobí buď nové memory pravidlo, nebo update existujícího, nebo audit záznam v `docs/audits/`.
6. Aktualizuje `MEMORY.md` index.

Retrospective agent **nikdy neupravuje kód**, pouze docs / memory / prompts. To zaručuje, že nemůže omylem rozbít deploy — jeho výstup je čistě dokumentační.

---

## Trigger módy

### Cron (plánovaný)

Doporučená kadence: jednou týdně, v pátek večer. Není zatím technicky implementovaný (vyžadovalo by GitHub Action nebo pravidelný launchd job na uživatelově Macu) — zatím se spouští manuálně.

### On-demand (uživatel)

Tomáš může kdykoli říct „spusť retrospective" nebo „udělej audit posledních 7 dní" a orchestrátor pustí tohoto agenta. To je aktuálně hlavní použití.

### Session-end / work-area boundary

Když orchestrátor dokončí velký work-area (například mergnul 4-PR stack nebo zavřel multi-sprint initiative), může před koncem session preventivně pustit retrospective agenta, aby zachytil čerstvé patterny dřív, než se zapomenou. Aktuálně to dělá ad-hoc — explicitní trigger condition zatím nemáme.

---

## Workflow příklad — end-to-end

Představme si situaci: Tomáš si stěžuje, že Claude opakovaně navrhuje nastavit AWS S3 bucket pro něco, co by se dalo vyřešit lokálním souborovým systémem. Tomáš to korektně okřikne: „Nenavrhuj setup S3, nechci žádné externí služby."

Co se stane (ideální flow):

1. Orchestrátor (běžná session) zaznamená korekci. V dalším kroku této session už S3 nenavrhuje.
2. Při příští session by zase mohl spadnout do stejné chyby — proto na konci session, nebo při příštím spuštění retrospective agenta, se zachytí pattern.
3. Retrospective agent (nebo orchestrátor sám) vytvoří `feedback_no_external_services.md` (už existuje, viz `MEMORY.md`).
4. `MEMORY.md` se aktualizuje pointerem na to nové pravidlo.
5. Příští session při startu načte `MEMORY.md` index a vidí, že pro „externí služby" je tu pravidlo — automaticky ho zohlední bez toho, aby Tomáš musel cokoliv opakovat.

Tenhle workflow funguje pouze tehdy, když jsou všechny tři součástky disciplinovaně udržované. Když se memory rules duplikují, plní hlukem nebo obsahují stale entries, hodnota celého systému klesá. Proto retrospective agent při každém běhu kontroluje:

- **Duplicity:** dvě pravidla říkající totéž → sloučit.
- **Stale entries:** pravidla referující na uzavřené initiative nebo zrušené patterny → archivovat do `_archived-YYYY-MM-DD/`.
- **Missing entries:** patterny opakované 3+ krát bez memory rule → vytvořit.

---

## Limity a kompromisy

Tenhle systém **není** umělá inteligence v silném smyslu. Je to jen dobře navržená paměť plus dobře navržené šablony plus pravidelná revize. Nezaručuje, že Claude přestane chybovat — zaručuje, že když chyba je jednou zachycená a popsaná, **bude méně pravděpodobná** v budoucnu.

Co tenhle systém **neřeší**:

- Real-time učení v rámci jedné session (to dělá orchestrátor sám z kontextu konverzace).
- Cross-projektové učení (memory pravidla jsou per-projekt; pravidla z hozan-taher nepřechází automaticky do jiných projektů).
- Konflikty mezi pravidly (když dvě pravidla si protiřečí, lidský zásah je potřeba — agent na to upozorní v drift reportu).

---

## Co dělat, když to nefunguje

Pokud má Tomáš dojem, že Claude opakovaně dělá stejnou chybu i přes existující memory rule:

1. Otevřít `~/.claude/projects/-Users-messingtomas-Documents-Projekty-hozan-taher/memory/MEMORY.md` a zkontrolovat, jestli je tam pravidlo, které by chybu mělo zachytit.
2. Pokud ano, ale orchestrátor ho neposlechl — zkontrolovat detailní soubor (`feedback_*.md`), jestli je tam jasná formulace „HARD RULE" / „NIKDY".
3. Pokud pravidlo chybí, vytvořit ho ručně nebo pustit retrospective agenta s konkrétní žádostí: „zachyť pravidlo X jako memory".
4. Pokud pravidlo má, ale orchestrátor ho ignoruje — to je signál, že memory loading flow je rozbitý. Tehdy je potřeba zkontrolovat, jestli se `MEMORY.md` vůbec načítá při startu session (auto-memory mechanismus Claude Code).

---

## Reference

- `~/.claude/projects/-Users-messingtomas-Documents-Projekty-hozan-taher/memory/MEMORY.md` — index všech pravidel.
- `~/.claude/projects/-Users-messingtomas-Documents-Projekty-hozan-taher/prompts/` — prompt library.
- `docs/audits/2026-04-30-self-improvement-retrospective.md` — výstup retrospective agenta z 2026-04-30.
- `docs/playbooks/ci-bypass.md` — sister playbook pro CI rozhodování.
- `CLAUDE.md` (project root) — primární vstupní bod pro každou session.
