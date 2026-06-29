# Iniciativa: Campaign 457 produkční launch (Strojírenství výkup techniky)

**Status:** Aktivní — AU1 hotový, AU2 čeká na spouštěč
**Datum vytvoření:** 2026-05-09
**Trigger:** Operátor požaduje 24/7 outbound přes 2 nově vytvořené Seznam schránky, prvních 100 kontaktů (campaign 457) z dataset firmy strojírenství CZ. Předchozí Goran-disaster (8.5. ráno, fraud-lock obou původních schránek) byl řešen sprinty AO/AP/AQ/AR/AS — ty teď platí jako safety baseline.

## Kontext

Campaign 457 (`Strojírenství — výkup techniky první vlna`) drží 100 pending kontaktů zaměřených na výkup těžké techniky (rypadla, nakladače, jeřáby). Posíláme z přizvaných českých B2B prodejců (persona Goran Nowak / Balkan Motors). Email šablona ID 1889 je po několika iteracích finální (česky, plurál — píšeme firmě, GDPR patička, žádný unsub link, opt-out přes reply).

Po 8 sprintech defenze (AO–AS, dohromady 42+ PR) je pipeline připravená. Tahle iniciativa je o reálném spuštění — krok za krokem, s tím že každý další krok je gated PASS signálem od předchozího.

## Cílové metriky

Po vyčerpání 100 kontaktů (cca 5–7 dní):
- **Doručitelnost** ≥ 95 % (relay vrátil `outbound_smtp_delivered`)
- **Bounce rate** < 5 % (jinak AR11 auto-pauzuje sám)
- **Auth-fail** = 0 (jinak AP6 quarantenuje schránku)
- **Reply rate** ≥ 3 % (CZ B2B cold-mail baseline)
- **Žádný spam-folder signál** od Seznam reputation

## Sprinty

### AU1 — Pre-flight infrastruktura (hotovo 2026-05-09 ~21:30 CEST)

Dnes se podařilo srovnat tři věci. **24/7 send window** — `isWithinSendWindow` umí číst `SEND_WINDOW_START_HOUR`, `SEND_WINDOW_END_HOUR`, `SEND_WEEKDAYS_ONLY` z env, defaulty zůstaly bezpečné, na Railway nastaveno 0–24 + víkendy povoleny (PR #1175). **Date hlavička v Praha tz** — `formatRFC5322Date` produkuje `+0200/+0100` podle DST, BFF a smtpSend ji pasují do relay payloadu (PR #1176, #1177). **Wire-MIME ověřeno** — relay debug dump (PR #1178) prokázal že hlavička dorazí na linku správně. Side-find: orchestrator IMAP poller obchází SOCKS5 (HARD RULE violation), zapsáno jako issue #1179.

2 schránky `nowak.goran@seznam.cz` (mb 14227) a `goran.nowak@seznam.cz` (mb 14228) jsou active, warmup_d0, pinované na `cz-prg-wg-101/102` Mullvad endpointy. Mb-to-mb test (3 envelopes) v 21:08 CEST prošel za 21 sekund per envelope.

### AU2 — První ostrý send + 30min watch (čeká)

Pokyn od operátora: aktivovat `campaign 457` přepnutím statusu na `running`. Žádný cap override — necháme platit warmup_d0 phase cap = 10/d/schránka. Orchestrator's campaign daemon má tick každých 15 minut, takže do čtvrt hodiny vyzobne 457 a začne paceovat (45–180 s mezi sendy). První mail půjde z mb 14227 nebo 14228 na první kontakt v 457 (PMDP ředitelství dle session summary).

Brána pro pokračování AU3: po 30 min uvidíme v relay logu `outbound_smtp_delivered`, v `send_events` řádku se status `sent`, `bounce_events` zůstane prázdná, schránka neflipnula na `auth_locked`. Pokud čokoliv selže, halt a RCA.

### AU3 — Plný warmup_d0 přes víkend (24h)

Po PASS AU2 nedělám nic — orchestrator paceuje sám. Cap = 10/d/schránka × 2 schránky = max 20 mails/den, realisticky ~7–15 dnes večer + noc, do zítřejšího rána plná dávka. Operátor sleduje pasivně přes Sentry + dashboard Replies tab.

Brána pro pokračování AU4: po 24h vidíme bounce <5 %, žádný spam-folder return, schránky stále `active`, Mullvad endpointy `cz-prg-wg-101/102` neletí do quarantine.

### AU4 — Lifecycle ramp + zbývající kontakty

Cron 03:00 Praha auto-povýší fázi schránek: `warmup_d0` (10/d) → `warmup_d3` (25/d) den 3, `warmup_d7` (50/d) den 7, `warmup_d14` (100/d) den 14, `production` (100/d) den 30. Při default tempu vyčerpáme 100 kontaktů 457 cca den 4–5, tedy v polovině ramp.

Pokud během ramp nastane signál (bounce klepe na 5 %, ÚOOÚ stížnost, Seznam reputation drift), AR15 a AR11 zareagují sami. Operátor primárně řeší jen reply triage.

### AU5 — Monitoring 24/7 (kontinuální)

Sentry alerty pro Go errory + crashloops. Ochrany panel pro L2/L3 health probes. Replies tab pro klasifikaci `interested` / `negative` / `oof` / `auto`. `interested` letí jako alert operátorovi, `negative` auto-suppress, `oof` ignore, `auto` ignore. Pokud někde tichá selhání (např. orchestrator daemon přestane tick-ovat víc než 5 min), Sentry deadman v `runDaemonDeadAlert` zachytí.

### AU6 — Post-mortem po 100 kontaktech

Po vyčerpání 457 (status `completed`) sepíšeme krátký review: kolik replies přišlo, jaký reply mix, kolik bounce / suppress / DSR žádostí, kolik unique opens (pokud máme tracking — ale dnes ne, kvůli Seznam anti-spam), schránka health score deltas, Mullvad endpoint reputation deltas. Z toho rozhodneme tunings pro další várky (cílení, šablona, rate, schránky).

## Co se NEDĚLÁ

- **Žádný `daily_cap_override`** — necháme phase cap nastavený. Operátor může LOWER (na 5, 3, 1) ale nikdy raise nad phase cap.
- **Žádné víc než 2 schránky** dnes — focus na warmup obou. Až po success ramp druhé várky přidáme schránky.
- **Žádné A/B variant** šablon pro 457 — jen 1889 final. A/B testing až další várka, ne první.
- **Žádný open-pixel tracking ani click-redirect** — Seznam by to flagnul (memory `project_humanize_safe_profile`, AR2/AR5 hard rules).
- **Žádný unsubscribe link v body** — opt-out jen přes reply (`feedback_no_unsub_url_in_body`).

## Eskalační runbook (kdyby šlo do háje)

| Symptom | Auto-action | Operátor action |
|---|---|---|
| Bounce rate ≥ 5% za 24h | AR11 auto-pause campaigny | Investigate bounce typy; pokud spam-related → halt; pokud invalid-recipient → suppress + resume |
| Schránka 3× auth-fail/h same op_type | AP6 quarantine `auth_locked`, 24h cooldown | Po 24h ověřit creds, ručně unlock přes `POST /api/mailboxes/:id/clear-auth-lock` |
| 2+ countries za hodinu | AP4 chaos detection auto-pause | Investigate egress (Mullvad endpoint flap?), restartovat relay |
| Mullvad endpoint 2× avg bounce | AR15 quarantine endpointu | Wait pro samo-recover (6h cron); pokud chronický, manually swap endpoint |
| `runDaemonDeadAlert` Sentry alert | Sentry escalation | Restartovat machinery-outreach service |
| Seznam SMTP 421 / 550 spam | Single-send fail, eventually breaker | Pokud > 30% sendů → halt, audit headers + content, možná flush Mullvad endpoint reputation |

## Dnešní sprint AU2 — start checklist

Operátor potvrdí:
- [ ] Souhlas se spuštěním (HARD memory `feedback_campaign_send`)
- [ ] OK že první send může jít na PMDP v sobotu večer (recipient otevře nejdřív pondělí ráno, ale tech. pipeline test může běžet)
- [ ] Žádný cap override (= default warmup_d0 = 10/d/schránka)

Po potvrzení: SQL update + 30 min watch.
