# Anti-Trace Pipeline — Incremental Verification

**Status:** active
**Vlastník:** Chat A (engineering) + operátor pro per-step go/no-go
**Datum založení:** 2026-05-04
**Datum uzavření:** —
**Trigger:** Po dnešní extrémně dlouhé infrastructure-debugging session bylo nakonec odhaleno, že Engine path nedoručoval 0/N kvůli **třem nekorrelovaným bugem v relay** (drain panic v PR #706, inline-creds field-mismatch v PR #720, duplicate `From:` header v PR #721). Po jejich opravě dorazilo 1/4 SMTP-accepted Engine envelope do INBOX. Operátor zastavil chaotické per-bug honbu a explicitně požaduje **deset až sto malých přírůstkových kroků**, kde každý krok znamená "pošli, ověř doručení, ověř anonymitu, implementuj další anonymizační prvek, pokud spadne víš kde". Tato iniciativa nahrazuje [`2026-05-04-anti-trace-rebuild-incremental`](2026-05-04-anti-trace-rebuild-incremental.md), který se zaměřoval na bisekci přes diagnostický endpoint místo na přírůstkovou výstavbu Engine.

## Kontext

Dnešní stav po stabilizaci infrastruktury:

- Drain goroutine poprvé od existence kódu reálně volá SMTPDeliverer.Deliver pro Engine envelope — předchozí 302 production sendů + dnešních 60+ Engine cross-sendů šlo přes RecordDeliverer no-op. Toto je vysvětlení dříve rozporných pozorování (`outbound_smtp_delivered` log u 0% delivery, missing canary breadcrumbs, identical TLS-handshake-impossible same-second timing).
- Raw plain MIME přes `/v1/raw-smtp-test` doručuje s Mullvad CZ + DE endpointy konzistentně (potvrzeno na vzorku 60+ envelope v sprintech L4 + M4 — 100% INBOX rate u SMTP-accepted envelope). NL Mullvad endpoint blokuje AUTH 535, SE endpoint port 1083 je dead, takže ~50% sendů selže na úrovni transportu bez ohledu na content.
- Engine path post-fix doručuje 1/4 SMTP-accepted envelope do INBOX. Mezera mezi raw 100% a Engine 25% pravděpodobně nepramení z MIME struktury (sprinty L4/M4 odzkoušely 13 Engine-mirroring flagů a všechny dodaly 100%) ale z kombinace **content reputace u Seznam** (dnes přes 600 failed sendů z těchto čtyř adres je flaglovaných v ML detektorech) plus **zbývajících drobností v Engine wire formátu** které diag harnessing zatím nereplikuje.
- Mailboxy `mb1@`, `mb2@`, `mb3@`, `mb4@` jsou po dnešním burnu reputačně poškozené — testy musí předpokládat že mb1-3 mohou mít sníženou recipient reputaci u Seznam, což zkresluje výsledky individuálních kroků.

## Cíle

Primární cíl je **dorazit do bodu kdy Engine SAFE profile doručuje aspoň 80% envelopů které dosáhnou Seznam SMTP** s měřitelnou anonymizační hodnotou na úrovni L1+L2 anonymity skoreru (žádný IP leak, žádný X-Mailer leak, anonymizovaný Message-ID). Sekundární cíl je dokumentovat "kill nebo allow" matici pro každý anonymizační prvek v Engine pipeline tak, aby budoucí změny mohly tuto matici jen rozšiřovat, ne přepisovat.

Cílem **není** dosáhnout 100% delivery — Mullvad reputace u Seznam má architektonický strop (memory `seznam_proxy_geo_mismatch`), který tato iniciativa řeší per-flag testem, ne nahrazením egressu. Pokud strop nelze prorazit content optimalizací, výstupem bude ADR doporučující buď A) akceptovat strop, nebo B) přidat non-Mullvad CZ egress vrstvu, nebo C) přepnout na transactional email service pro produkci.

## Předpoklady

Než začne přírůstková sekvence, musí platit šest podmínek. Většinu jsme dnes splnili; zbývající doplníme v Sprintu Q.

První je **stabilní drain pipeline**. Tedy že envelope odeslaný přes `/v1/submit` reálně projde SMTPDeliverer.Deliver, dosáhne Seznam SMTP a získá kód odpovědi. Splněno PR #706 + #720 + #721. Verifikační canary `SMTPDELIV_CANARY_M5` zatím v kódu zůstává — odstraní ho Sprint Q po dokončení Q1.

Druhá je **deterministicky reprodukovatelný raw baseline**. Tedy že existuje konfigurace `/v1/raw-smtp-test` která doručí 1/1 do recipient INBOX nezávisle na content. Splněno opakovaně v dnešních sprintech.

Třetí je **fresh recipient**. Mailbox který nedostal žádný flagovaný send dnes, takže jeho Seznam reputace není zkreslena. Toto budeme řešit v Sprintu Q1 — buď vytvořením nového Seznam účtu, nebo použitím externího Gmail účtu jako recipient pro kontrolní vzorek (Gmail má nezávislé anti-spam ML, takže rozliší jestli problém je content (failuje napříč providery) nebo Seznam-specific reputace (failuje jen u Seznam).

Čtvrtá je **`cmd/anonymity-score` runnable na arbitrary IMAP message**. Existuje a funguje — dnes ho nepoužíváme protože nedoručujeme. V Sprintu Q2 ho přepojíme na ruční IMAP fetch (po raw-test sendu) místo na harvest pipeline (která vyžaduje DB run-id propojení).

Pátá je **canary instrumentace zachycující actual wire MIME**. Splněno PR #717 (DELIVER_DEBUG_MIME breadcrumb). Po dokončení této iniciativy odstraníme.

Šestá je **monitorovací vrstva delivery rate per recipient endpoint** (CZ vs DE Mullvad). Aktuálně je v `/v1/proxy-pool` jako `ok_count`/`fail_count` per endpoint, ale nepropojuje se na Seznam-side outcome (delivered vs silently dropped). Sprint Q3 přidá per-envelope routing log, abychom mohli odlišit "selhalo na Mullvad NL AUTH" od "doručeno přes CZ ale Seznam silently dropnul".

## Plán (sprinty)

Plán se rozdělí na sedm tematických sprintů. **Q-sprint** (přípravná stabilizace), **B-sprint** (referenční baseline measurement), čtyři dimenze přírůstkového testování — **E-sprint** (egress), **H-sprint** (headers), **C-sprint** (content/body), **M-sprint** (MIME struktura) — a finální **V-sprint** (validation cumulative cross-send) plus **P-sprint** (production cutover). Mezi sprinty Q a B je tvrdá závislost; mezi B a čtyřmi dimenzionálními sprinty je závislost měkčí — všechny čtyři dimenze sdílejí baseline ze sprintu B, ale mohou běžet paralelně mezi sebou. V-sprint závisí na všech čtyřech dimenzionálních. P-sprint je operator-gated cutover po V-sprintu.

Každý jednotlivý krok dimenzionálního sprintu má stejný tvar. Pošleme jeden envelope s konfigurací předchozího kroku plus jeden nový anonymizační prvek. Počkáme na drain. Probneme IMAP cílového recipientu. Pokud zpráva dorazila, spustíme `cmd/anonymity-score` na ní a zaznamenáme tři hodnoty: jestli dorazila do INBOX vs spam, jaký byl anonymity score, a jaké konkrétní headers byly leakované. Pokud nedorazila, krok je označen jako **kill** a anonymizační prvek je vyřazen z Engine SAFE profilu pro tento provider. Pokud dorazila, krok je **allow** a Engine SAFE profile prvek si ponechá.

### Sprint Q — Předpoklady stabilizace (1 sezení) {#sprint-q}

Q1 — vytvořit fresh Seznam recipient nebo přidat externí Gmail recipient. Kontrolní vzorek pro odlišení "content kill" vs "recipient reputation kill". Pokud operátor preferuje další Seznam mailbox, vytvoříme jej manuálně přes web a přidáme do `outreach_mailboxes` tabulky. Pokud operátor preferuje Gmail, použijeme jakoukoliv osobní Gmail adresu jako test recipient (testy nikdy nesendují skutečný spam, jen jeden control envelope per krok).

Q2 — refactor `cmd/anonymity-score` aby přijal IMAP credentials + Message-ID jako vstup a vypsal score JSON na stdout. Aktuálně vyžaduje run-id propojení s databází. Odpojíme od DB pro arbitrary single-message scoring.

Q3 — přidat do relay `outbound_smtp_delivered` logu pole `endpoint_label` (cz/de/nl/se) ať operátor v IMAP-fail rozeznáme "selhalo transportem" vs "transportem prošlo, Seznam zahodil". Aktuálně je endpoint visible pouze v `/v1/proxy-pool` aggregate, ne per-envelope.

Q4 — extrahovat všech ~24 toggle-able anonymizačních elementů ze sprintů L1+M1 + dnešních objevů do JSON catalogu `docs/audits/anti-trace-elements.json`. Každý element má jméno, soubor:linka v Engine, popis, mirror flag v `/v1/raw-smtp-test`, J3 audit rank, a pole `status: pending`. Tento catalog bude single source of truth pro pořadí kroků v dimenzionálních sprintech.

DoD Q: fresh recipient existuje, anonymity-score běží na arbitrary IMAP message, relay logy obsahují endpoint label, JSON catalog 24 elementů committed.

### Sprint B — Baseline measurement (1 sezení) {#sprint-b}

B1 — bare raw email z mb1@ na mb2@ (Mullvad CZ exit, žádné anti-trace elementy). Pošli 5 envelope (různé subjects pro routing diverzity). IMAP probe. Zaznamenej delivery rate, anonymity score per zpráva, výpis leakovaných headers. Toto je **dolní hranice anonymity** = co máme bez Engine.

B2 — opakuj B1 s recipient = fresh Seznam recipient ze Sprintu Q1 nebo Gmail. Zaznamenej rozdíl v delivery rate vs reputation-burned mb2@. Tento rozdíl je **recipient reputation tax** — odečteme ho z výsledků dimenzionálních sprintů.

B3 — opakuj B1 s recipient = vlastní externí mailbox (Gmail/Outlook) přes externí domain. Slouží jako kontrolní bod pro non-Seznam delivery. Pokud raw plain z Mullvad CZ doručí 5/5 do Gmail INBOX ale 0/5 do Seznam INBOX, **architektonický strop u Seznam je potvrzen reputací IP** a žádné content optimalizace ho neprorazí.

DoD B: tabulka tří baseline measurements (mb2@ Seznam, fresh Seznam, externí Gmail) s delivery rate + anonymity score. Tato tabulka definuje kontext pro všechny dimenzionální sprinty.

### Sprint E — Egress dimension (1 sezení) {#sprint-e}

E1 — Mullvad CZ Prague endpoint exclusively. Pinning routing key tak, aby všech 5 testovacích envelope šlo přes CZ. Pošli, IMAP, score. Měření: jak Seznam reaguje na CZ Mullvad konkrétně.

E2 — Mullvad DE Frankfurt endpoint exclusively. Stejný měření. Komparační rozdíl mezi E1 a E2 ukáže jestli CZ exit má lepší reputaci než DE.

E3 — Mullvad NL endpoint. Očekáváme AUTH 535 (memory `project_seznam_proxy_geo_mismatch`). Potvrdíme.

E4 — vícenásobná rotace přes wgpool (default chování). Pošli 20 envelope, sleduj per-envelope endpoint label. Vyhodnoť jestli rotace ovlivňuje delivery rate (může mít — frequent IP změna může být sama o sobě signál pro Seznam).

E5 — Tor exit endpoint. Aktuálně blokovaný v relay (TOR_ENABLED=false z provozního důvodu, ne content důvodu). Test: jestli odblokujeme jen pro tento sprint, projde Seznam? Očekáváme drop kvůli Tor exit reputation. Pokud projde, je to silný anonymizační prvek za nulovou cenu.

DoD E: matice CZ/DE/NL/Tor × delivery rate × anonymity gain. Output rozhodne ohledně Mullvad endpoint pinning v produkci.

### Sprint H — Headers dimension (1 sezení) {#sprint-h}

H1 — `Message-ID` anonymizace (D5 sanitizeHeaders). Aktuálně relay přepíše Message-ID na `<16hex@senderFQDN>`. Test: vyšle se envelope s anonymizovaným Message-ID? Doručí Seznam? Mírně zvyšuje anonymitu (eliminuje `email.seznam.cz` autodetekci) za prakticky nulovou cenu.

H2 — `X-Mailer: Seznam.cz` přidání. Engine humanize/fingerprint emituje, relay D5 stripuje. Test ze sprintů L4 už ukázal allow. Ověříme přímo přes `/v1/raw-smtp-test xmailer_header=true`.

H3 — `Content-Language: cs`. Engine + template emituje. Sprint L4 už allow.

H4 — `From:` display-name (Engine BuildFromHeader titleCase). Sprint L4 už allow. Anonymita: žádná. Cena: jeden zbytečný header. Vyhodnotí se jestli má smysl ho udržovat.

H5 — `Date:` v Europe/Prague TZ vs UTC. Engine emituje Prague. Test: jaký rozdíl jestli Date je UTC vs CET? Anonymita zde je o tom kdy byla zpráva odeslána (UTC by podpisoval automatizovaný stroj, Prague by sedělo k human sender).

H6 — odstranění `Received:` chain z relay D5. Aktuálně se přidává přes Mullvad gateway. Anonymita: vysoká (Received chain leakuje routing). Cena: některé MTA zahazují zprávy bez Received header jako podezřelé.

H7 — `User-Agent` strip. Test: pokud relay přidává User-Agent (např. `Go-http-client`), Seznam to může detekovat. Anonymita: vysoká.

H8 — RFC 2047 base64 subject encoding (relay BuildMessage encodeSubject). Pro non-ASCII je to požadavek RFC, ne anonymita. Zde je kontrolní krok jestli base64 vs raw UTF-8 v subjectu mění Seznam reakci.

DoD H: matice 8 header transformací × allow/kill × anonymity score change. Output mapuje které headers Engine může bezpečně přidat/strippovat bez kill rizika.

### Sprint C — Content / body dimension (1 sezení) {#sprint-c}

C1 — Tone greeting prepend ("Dobrý den,\n\n"). Sprint M4 už allow.

C2 — Tone closing append ("\n\nS pozdravem,"). Sprint M4 už allow.

C3 — Signature block append (jméno + role + telefon). Sprint M4 už allow. Důležitý anonymity-aware krok: signature obsahuje jméno odesílatele což je naopak deanonymizační. Pokud chceme anonymitu, signature musí být generic ("Obchodní zástupce") bez specifika identity.

C4 — RestoreDiacritics (canonical CZ words). Sprint M4 už allow.

C5 — humanize-light typography substitutions (zero-width spaces, em-dash, curly quotes). Test ze sprintů I3 + L4 = allow.

C6 — Imperfect diacritics-degrade subject (40% keepProb). Sprint I4 = expected fail. Confirm.

C7 — Imperfect diacritics-degrade body (70%→40% descent). Sprint I4 = expected fail. Confirm. Toto byl killer důvod pro PR #710 SAFE profile.

C8 — Imperfect typo injection (0-3 random commas/periods). Test isolated.

C9 — bump/forward wrap pro step>0 (`Re: original\n> quoted body`). Test: následný email s reply-style wrap.

C10 — voice profile per-sender variations. Engine emituje per-sender voice (DiacriticsRestoreProb varies). Test: 3 různí senders → různé body shape → Seznam to detekuje?

DoD C: 10 content transformací × matice. Identifikuje které transformace jsou bezpečné, které kill, které tradeoff.

### Sprint M — MIME struktura dimension (1 sezení) {#sprint-m}

M1 — multipart/alternative wrap (text/plain + text/html). Sprint M4 = allow.

M2 — plainToHTML minimal wrap (`<html><body><p>...</p></body></html>`). Sprint L4 = allow.

M3 — Engine HTML wrap (Fingerprint Arial+14px outer div + meta-charset). Sprint L4 = allow.

M4 — per-line span injection (30% prob). Sprint L4 (mixed) = allow s rezervou.

M5 — redundant `<div>&nbsp;</div>` injection (20% prob). Sprint L4 = allow.

M6 — header order: Date → Message-ID → MIME-Version → X-Mailer → User-Agent. Test: jestli pořadí samo o sobě je signál.

M7 — boundary string format (`----=_Part_<32hex>`). Test alternativní formátů (NextPart_, mimepart_, etc.). Anonymity: nulová (boundary se generuje randomly), kontrolní bod.

M8 — `Content-Transfer-Encoding: 8bit` vs `quoted-printable`. Test ze sprintů L4 8bit = allow. QP přidává komplexitu MIME ale je striktnější RFC.

DoD M: 8 MIME structural transformací × matice. Output identifikuje minimální MIME shape pro Engine SAFE.

### Sprint V — Cumulative validation (1 sezení) {#sprint-v}

V1 — Engine SAFE profile build. Konfiguruj Engine jen s allow elementy ze sprintů E+H+C+M. Vyřaď všechny kill elementy. Toto je production-ready Engine SAFE profile candidate.

V2 — 36-envelope cross-send přes 4 mailboxy × 3 templates × 3 receivers (default `cmd/anonymity-test` matrix). Drain. IMAP harvest. Anonymity score per zpráva. Computed: delivery rate per (sender×receiver) pair, average anonymity score, distribution. DoD: ≥80% delivery rate u envelope routovaných přes CZ+DE.

V3 — 36-envelope re-run za 24 hodin po V2. Verifikace stabilní delivery (žádný throttling, žádný post-burn ban). Tato 24h validation gate je nutná před production cutover.

DoD V: dvě 36-envelope reports (T0 + T0+24h) s delivery rate a anonymity score. ADR-013 návrh dokumentující SAFE profile elementy a 24h stability evidence.

### Sprint P — Production cutover (1 destructive sezení) {#sprint-p}

P1 — campaign 1+456+455 paused (currently). Verify all paused.

P2 — deploy Engine s SAFE profile (z V1). Re-run cmd/anonymity-test pro cutover sanity.

P3 — resume campaign 1 s konzervativní cadence (5 sends per mailbox per day initially). Daily delivery monitoring přes tracking pixels (separate gap k vyřešit).

P4 — 7-day stability window. Pokud delivery >80% maintained, full ramp. Pokud degrades, rollback na raw plain MIME path.

DoD P: production campaign 1 doručuje verifikovaně at scale. ADR-013 finalized. Memory `feedback_anti_trace_full_stack` updated na "Engine SAFE profile mandatory" místo původního "Engine.WithAntiTrace mandatory".

## Pořadí a paralelismus

Q first — bez fresh recipient, scoring tooling a endpoint logging nemá smysl měřit dimenze.

B navazuje na Q. Single sezení (8-10 sendů celkem).

E, H, C, M jsou paralelní mezi sebou. Spuštíme jako čtyři background agent flow (per memory `feedback_agent_fleet`) — každý dimensional sprint produkuje svou matici nezávisle. Cross-dimensional interakce (např. multipart × span injection × diacritics degrade) testujeme v V, ne tady.

V navazuje na všechny čtyři dimenze. Single sezení.

P operator-supervised, single sezení.

## Open questions

První je granularity per-step envelope count. 1 envelope per step zachytí kill ale nepodá statistickou sílu — Seznam ML může být probabilistický (1/1 zatím prošlo, 50/50 by mohlo selhat). Decision: 5 envelopes per dimensional step (statisticky reasonable ratio detect ≥20% drop), 36 per V.

Druhá je test recipient pool. Pokud B3 (externí Gmail) ukáže že CZ Mullvad doručuje do Gmail 100%, znamená to **Seznam reputace IP je tvrdý strop, ne content**. V tom případě dimenzionální sprinty E+H+C+M nezvýší delivery do Seznam — pouze udrží to co je. Output bude ADR doporučující non-Mullvad CZ egress nebo transactional service.

Třetí je co s mb1@-mb4@ post-Sprint Q1. Pokud vytvoříme fresh Seznam mailbox, ten se ihned po prvním kill flagne. Tedy fresh recipient pool má omezené použití (1-2 měření per recipient). Mitigation: vytvořit 5-10 fresh recipients post-Q1, používat je rotacně tak aby každý dostal ne víc než 3 envelope za celou iniciativu.

Čtvrtá je timing. Komplet dimenzionální sprinty (E+H+C+M paralelně) odhadem 2-4 hodiny work. V validation 1 hodina. P operator-gated podle business decisionu. Celá iniciativa minimum 1 working day, realisticky 2-3 dny s 24h stability gate.

Pátá je co když ani SAFE profile (po V2) nedosáhne 80% u Seznam. Možnosti: A) snížit cíl na 50%, B) dropnout Seznam jako recipient class a pivot na non-Seznam B2B audiences, C) přidat non-Mullvad CZ egress vrstvu (vlastní VPS — operátor v minulosti odmítl ale evidence-driven re-konfrontace by mohla rozhodnutí změnit). Decision tree v ADR-013.

## Cross-references

- HARD RULE memory: `feedback_anti_trace_full_stack` (T0)
- HARD RULE memory: `feedback_no_pii_in_commands` (T0, dnes upgraded)
- HARD RULE memory: `feedback_campaign_send` (T0)
- Architectural ceiling: `seznam_proxy_geo_mismatch` (T2)
- Subsystem map: [`docs/subsystem-maps/anti-trace.md`](../subsystem-maps/anti-trace.md) — 42-step canonical pipeline
- J3 audit: [`docs/audits/2026-05-04-engine-vs-raw-mime-diff.md`](../audits/2026-05-04-engine-vs-raw-mime-diff.md)
- Předchozí (superseded) plán: [`2026-05-04-anti-trace-rebuild-incremental.md`](2026-05-04-anti-trace-rebuild-incremental.md)
- Dnešní fixy v sequence: PR #706 (drain panic) → #707 (docs) → #709 (J3 audit) → #710 (humanize SAFE) → #711 (--allow-placeholder-password) → #715 (5 bisection flags) → #716 (5 more flags) → #717 (DELIVER_DEBUG_MIME) → #718 (canary) → #719 (DRAIN_DISPATCH_M5) → #720 (inline creds) → #721 (duplicate From)
- Element catalog: `docs/audits/anti-trace-elements.json` (vytvoří Sprint Q4)
- Future: ADR-013 (vytvoří Sprint V3)

## Maintenance

Tato iniciativa se aktualizuje po každém sprintu — výsledné matice (delivery × anonymity × kill/allow) se commitují do dimenzionálního section. Po Sprintu P bude celá iniciativa archivována do `docs/archive/` a finální ADR-013 zachová decision rationale.

Pokud iniciativa selže (pravděpodobnostně B3 ukáže že Mullvad reputace je hard ceiling), bude superseded novým initiativem řešícím egress reputation jako primární problém, ne content optimization.
