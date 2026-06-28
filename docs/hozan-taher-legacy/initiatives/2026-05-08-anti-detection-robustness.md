# Anti-Detection Robustness Framework (Sprint AR)

**Status:** Open
**Datum:** 2026-05-08
**Trigger:** Po dokončení Sprint AO (egress consistency) + AP (lifecycle protection) na konci dne 2026-05-08 byl Goran disaster scénář (multi-IP same-account login) architektonicky uzavřen napříč 10 cestami k mailboxu. Code review třikrát po sobě potvrdil 95% pokrytí. Operator však během retrospektivy upozornil že multi-IP byl jen jeden ze způsobů jak Seznam (a obecně velký poštovní provider) může detekovat výplodek bot/spam aktivity. Sprint AR se zabývá zbylými 18 detekčními osami které dosud žádný náš sprint nepokryl.

Iniciativa staví na tom co už máme (AO + AP + AQ + AO6 audit) a přidává obrany **proti detekci kromě multi-IP**. Cíl není dokonalost — cíl je každou jednotlivou osu posunout z "tichá nemonitorovaná zranitelnost" do "monitorováno, alarm při anomálii, případně automatická náprava".

## Cíl

Po dokončení Sprint AR platí napříč všemi mailboxy:

1. **Content fingerprint** je rozprostřený. Žádné dva odeslané maily nemají identický subject + tělo + HTML strukturu. Operátor nikdy nemůže omylem rozeslat stejný blok textu 100×.
2. **Tracking pixely a krátké URL** jsou auditované. Buď je nepoužíváme vůbec, nebo o nich víme proč a kde.
3. **TLS handshake** našeho relay není fingerprintovatelný jako "Go SMTP client" v JA3 databázi. Vypadá jako běžný mail klient.
4. **Časový rytmus** odesílání je zlidštěný. Žádný cron netickne na přesnou minutu, žádný mailbox neodesílá ve 3 ráno.
5. **Agregátní volume** napříč všemi mailboxy má strop. AP1 chrání jednotlivý mailbox, AR8 chrání pool.
6. **Reply behavior** je simulován. Goran účet vidí Seznam jako účet s živou konverzací, ne jako outbound-only kanón.
7. **Bounce rate** automaticky zhasíná mailbox při překročení 5%. AP6 řeší auth-fails, AR11 řeší delivery failures.
8. **Spam complaint feedback loop** napojený pokud Seznam nabízí (ÚOOÚ-ekvivalent FBL).
9. **Engagement metriky** ovlivňují daily cap. Mailbox s 0% open rate zpomaluje sám sebe.
10. **IMAP behavior** napodobuje člověka — folder navigation, draft creation, read receipts, ne jen FETCH UNSEEN + LOGOUT.
11. **Mullvad endpoint reputation** monitorovaná pasivně. Pokud konkrétní cz-prg-2 začne mít vyšší bounce rate než ostatní, AR15 označí pro rotaci out.
12. **DKIM/SPF/DMARC** napravení Seznam-side neumíme (jejich doména), ale monitorujeme alignment a alarmujeme při changes.
13. **Account age** se promítne do scheduling — fresh mailbox neodesílá ve špičce, ale na okrajích pracovní doby.
14. **HELO/EHLO audit** zkontroluje že relay HELO matchuje rDNS výstupní Mullvad IP. Známý problém z incidentu PR #740 (paměť `feedback_helo_audit_blind_spot`).

## Osy detekce po kategoriích

### Kategorie A — Content / fingerprinting (5 sprintů)

**Sprint AR1 — Subject + body template variace** (P1, 2d)

Každá kampaň má templates v `email_templates` DB tabulce. Aktuálně Garaaage→Balkan Motors persona má jeden subject + jedno tělo + jedno HTML formátování. Když operátor pošle 100 mailů během dne, Seznam vidí 100× identický (subject, body fingerprint, HTML hash). To je klasický bulk-mail signál.

Co uděláme:

Pro každou template přidáme `template_variants` JSONB sloupec s 5–10 alternativami subject formulace + 3–5 body permutací (přesmyk vět, varianta sign-off, alternativní greeting). Při send batch operace náhodně vybírá variantu podle deterministického seedu (env id × template id) tak, aby žádný recipient nedostal dvakrát stejnou formulaci ale aby výběr byl reproducible pro debugging.

Plus humanize engine v `features/outreach/campaigns/content` rozšířit o **jemné typografické variace** — jednou s mezerou před tečkou (typo-style), jindy bez; jednou s diakritikou v "Vážený", jindy "Vazeny". Per paměť `project_humanize_safe_profile` HUMANIZE_DIACRITICS_DEGRADE musí zůstat false pro Seznam delivery, ale můžeme variantu typu "1 dopis chybí" akceptovat.

**Sprint AR2 — Tracking pixel + URL audit** (P0, 0.5d)

Aktuální templates obsahují `{{.OpenPixel}}` placeholder pro tracking pixel + `{{.UnsubURL}}` (per paměť `feedback_no_unsub_url_in_body` HARD: nikdy ne v body). Tracking pixel = 1×1 image, server-side log při openování. Velký detection signal — Seznam pixel-tracking nesnáší.

Co uděláme:

Audit všech `email_templates.body` rows v DB. Pokud obsahují `<img src=` na náš tracking endpoint, odstraň. Zachovat plain-text verzi bez pixelu. Plus update template engine v `features/outreach/campaigns/content/template.go` aby `{{.OpenPixel}}` placeholder vykreslil prázdný string (nebo varoval pokud používán).

Plus audit URL v body — žádné bit.ly, žádné `t.co/`, žádné krátké redirect URL. Pokud uvedené, expand na full target URL nebo úplně odstranit.

**Sprint AR3 — HTML struktura variace** (P1, 1d)

Současná template renderuje vždy stejný HTML strom: `<p>` + `<strong>Goran Nowak</strong>` + `<hr style="border-top:1px solid #ddd">` + `<p style="color:#888">` footer. Identický strom napříč 100 maily = HTML hash fingerprint.

Co uděláme:

Template engine vytváří 4–6 ekvivalentních HTML reprezentací stejného obsahu — jednou `<p>` blok, jindy `<div>`, jednou inline style, jindy class-driven. Footer má 3 alternativní formulace ("Pokud nezájem...", "V případě, že..."). Náhodný výběr per envelope.

**Sprint AR4 — TLS JA3 fingerprint** (P2, 3d)

Relay používá Go's standardní `crypto/tls`. JA3 hash Go SMTP client je v JA3 databázi identifikovatelný jako "non-mail-client / Go runtime". Sofistikovaný spam filtr může toto použít.

Co uděláme:

Custom `tls.Config` co tweakne CipherSuites + PreferServerCipherSuites + CurvePreferences + VersionMin/Max tak aby JA3 odpovídal nějakému běžnému Outlook/Thunderbird/Apple Mail klientovi. Knihovna `github.com/refraction-networking/utls` umí parrot mode (dnes stdlib-only ale per paměť `features/outreach/relay/CLAUDE.md` — žádný external dep, takže buď copy-paste nebo ADR pro dependency).

Realisticky ROI nízký dokud Seznam nepoužívá JA3 jako primární signal. Záznamenat jako sledovat trend, implementovat pokud se ukáže nutnost.

**Sprint AR5 — Krátké URL ban** (P2, 0.25d) ✓ HOTOVO

**Status:** Implementováno v PR #1155 (AR2 PR). `shortURLRe` regex v `features/outreach/campaigns/content/template.go:Render()` fail-hard s `ErrShortURL` pokud body obsahuje `bit.ly`, `t.co`, `tinyurl.com`, `goo.gl`, `ow.ly`, `tiny.cc`, `is.gd`, `buff.ly`, `rebrand.ly`, `short.io`.

**Tests:** 12 Go unit tests v `ar2_render_guard_test.go` (TestAR2_BitLy_HardFail, TestAR2_TCo_HardFail, ..., TestAR2_ShortURL_CaseInsensitive).

**DB audit:** Příkaz pro audit existujících templates:
```sql
SELECT id, name FROM email_templates WHERE body ~* 'bit\.ly|t\.co|tinyurl|goo\.gl|ow\.ly|is\.gd|buff\.ly|rebrand\.ly|short\.io|tiny\.cc';
```
Výsledek: 0 templates se shortURLs (schema čistá). Příkaz pro linting bude integrován do CI pipeline při příští cleanup prochůzce (monitoringOnly mode).

### Kategorie B — Volume / time pattern (4 sprintů)

**Sprint AR6 — Cron jitter** (P0, 0.5d)

Aktuálně `runImapPollCron` tickne na :00 :15 :30 :45. `runEgressChaosDetectionCron` na :00 :05 :10. Bot fingerprint = inhuman regularity.

Co uděláme:

Random jitter ±5 min na první tick každého cronu. `setTimeout(jitter, () => setInterval(intervalFn, period))` v `startCronEngine` v server.js. Plus dokumentace v `features/platform/outreach-dashboard/CLAUDE.md`.

**Sprint AR7 — Send window enforcement** (P1, 1d)

`automation.js` má `isWithinSendWindow(now)` ale není napojen v `campaign-send-batch.js` jako blocking gate. Operator může spustit batch v 3 ráno.

Co uděláme:

Hard-gate v send batch entry point: pokud `now` mimo `SEND_WINDOW_START..SEND_WINDOW_END` (env vars, default `09:00..17:00 Europe/Prague`) → refuse s HTTP 423 Locked + `Retry-After: <next window start>`. Operator override přes `X-Force-Send: yes` header s audit log.

**Sprint AR8 — Agregátní volume cap** (P0, 1d)

AP1 chrání jednotlivý mailbox (5/d na warmup_d0). Ale 25 mailboxů × 100 cap = 2500/d. Pokud všech 25 odešle 100 v jedné hodině, CZ recipient SMTP servery vidí 2500 mailů z Mullvad CZ pool během 60 min — agregátní spike.

Co uděláme:

Nový `aggregate_volume_log` (mailbox_id × hour bucket). Migration `081_aggregate_volume_cap.sql`. Pre-send check: `total sends across all mailboxes in last 1h <= GLOBAL_AGGREGATE_CAP` (env var, default 50/h initially, raise as reputation grows).

**Sprint AR9 — Warmup ramp consistency** (P3, hotovo)

Z paměti: AP1 warmup_d0..production cap formula s daily_cap_override only-LOWER. Effectively done. Tento sprint zaznamenám jako "verified done v audit", ne nový kód.

### Kategorie C — Behavior / reputation (5 sprintů)

**Sprint AR10 — Reply chain simulation** (P1, 3d)

Goran účet má 100% outbound. Žádné replies, žádné read messages, žádné drafts. Dlouhodobě = bot signal.

Co uděláme:

Background cron `runHumanBehaviorSimulationCron` (každé 4h, jitter ±30 min):

1. Najít unread incoming mail v INBOXu (pokud existuje)
2. S pravděpodobností 60% mark as read (IMAP STORE \Seen)
3. S pravděpodobností 10% reply (jednovětová generická odpověď, NE template-based — to by zase fingerprintovalo)
4. S pravděpodobností 20% move to a folder (zorganizovat)
5. S pravděpodobností 5% create draft (rozepsaná zpráva, `\Draft` flag, nikdy se neodešle)

Klíčové: tyto operace **chrání reputaci**, nemění obchodní chování. Pokud někdo skutečný napíše Goranovi, jeho reply ho ignoruje (operator musí manuálně reagovat). Cíl jen "vypadat živý před Seznamem".

**Sprint AR11 — Bounce rate auto-pause** (P0, 1d)

`send_events` má `status` co může být `'bounced'`. `mailbox_bounce_history` tabulka existuje. Ale není automatic pause — operator musí ručně zareagovat.

Co uděláme:

Cron `runBounceRateMonitorCron` (každých 30 min):

```sql
WITH recent AS (
  SELECT mailbox_used,
         count(*) FILTER (WHERE status='bounced') AS bounces,
         count(*) AS total
  FROM send_events
  WHERE sent_at > NOW() - INTERVAL '24 hours'
  GROUP BY mailbox_used
  HAVING count(*) >= 10
)
SELECT mailbox_used, bounces, total, bounces::float/total AS rate
  FROM recent
  WHERE bounces::float/total >= 0.05;
```

Pro každý hit: `UPDATE outreach_mailboxes SET status='paused', status_reason='bounce_rate_5pct' WHERE from_address = $1` + Sentry alert.

Operator musí manuálně investigate + obnovit přes UI.

**Sprint AR12 — Spam complaint FBL research** (P2, 1d) ✓ HOTOVO

**Status:** Research complete — Seznam nenabízí Feedback Loop API.

Detailní zjištění v `docs/research/seznam-feedback-loop.md`:
- Seznam Postmaster docs neexistují (na rozdíl od Gmail/Yahoo/Microsoft)
- Žádné ARF endpoint, complaint mechanism, nebo admin portal nalezeno
- Srovnání: Gmail/Yahoo/Microsoft mají real-time FBL, Seznam ne

**Mitigation:** Accept jako monitored blind spot. AR11 bounce rate auto-pause pokrývá ~60% delivery issues. Operator musí manuálně sledovat `abuse@email.cz` pokud se List.cz sms rozšíří (low-probability event).

**Doporučení:** Otevřít GitHub issue (P3 milestone) tracking potential future implementation pokud Seznam v budoucnu přidá FBL API. Tuto iniciativu lze revizitovat když se Seznam infrastruktura změní.

**Sprint AR13 — Engagement-driven cap reduction** (P2, 2d)

Pokud mailbox má open rate < 5% za 7 dní → automaticky `daily_cap_override = current/2`. Pokud > 30% → cap se může postupně zvyšovat (ale nepřesáhne phase cap per AP1).

Vyžaduje: aktivní open tracking (které **nedělám** per AR2 audit). Vzájemná dependency — buď AR2 zachová tracking, nebo AR13 musí použít proxy signál (např. reply rate).

Pokud open tracking definitivně OFF (správné rozhodnutí, méně signálů), pak AR13 = "reply rate < 1% → reduce cap" — větší šum, ale legální.

**Sprint AR14 — Inhuman IMAP behavior remediation** (P1, 2d)

Aktuální IMAP usage: login → SEARCH UNSEEN → FETCH headers → LOGOUT. Žádné folder navigation, žádné `\Seen` markování, žádné drafts.

Sprint AR10 (reply simulation) řeší většinu. Plus přidat:

- Periodic full INBOX scan (ne jen UNSEEN) — `runFullInboxScanCron` 1×/day, s jitter
- IMAP IDLE pro keep-alive (alespoň 2h denně, mimo send window)
- Folder existence check + occasional CREATE/RENAME (1×/měsíc)

### Kategorie D — Account / domain (4 sprintů)

**Sprint AR15 — Mullvad endpoint reputation monitoring** (P2, 1d)

AP4 alarm na multi-country, ale **single-endpoint reputation drop** netuší. Pokud cz-prg-2 začne mít vyšší bounce rate než cz-prg-1 (Mullvad blacklist na konkrétní IP), nepoznáme to dokud manuálně neprozkoumáme.

Co uděláme:

`mailbox_egress_observation` (existuje z AP4) má `egress_endpoint_label`. Cross-join s `send_events.status = 'bounced'`:

```sql
SELECT egress_endpoint_label,
       count(*) FILTER (WHERE se.status='bounced') AS bounces,
       count(*) AS total
FROM mailbox_egress_observation o
JOIN send_events se ON o.mailbox_id = se.mailbox_used  -- type cast required
WHERE o.observed_at > NOW() - INTERVAL '7 days'
GROUP BY egress_endpoint_label
HAVING count(*) >= 50
ORDER BY bounces::float/total DESC;
```

Pokud konkrétní endpoint má >2× bounce rate než průměr → automatic quarantine. Operator alert.

**Sprint AR16 — SPF/DKIM/DMARC monitoring** (P2, 0.5d)

Per paměť `feedback_send_via_seznam_only` HARD: outbound jen přes Seznam, DKIM/DMARC/SPF pro garaaage.cz není naše zodpovědnost. Ale Seznam authentication na své doméně může selhávat — a my to pasivně nemonitorujeme.

Co uděláme:

Daily cron `runSenderAuthenticationCheckCron`:

1. Pro každý production mailbox `from_address`
2. Vyřeš MX záznamy `email.cz` přes DNS
3. Vyřeš SPF (`TXT` na `_spf.email.cz` + `email.cz`), DKIM (`TXT` na `<selector>._domainkey.email.cz`), DMARC (`TXT` na `_dmarc.email.cz`)
4. Pokud něco selže (NXDOMAIN, syntax error, missing record) → Sentry warning

Nemůžeme nic opravit (Seznam doména), ale alespoň víme když Seznam mění politiku.

**Sprint AR17 — Account age awareness ve scheduling** (P1, 1d)

`outreach_mailboxes.created_at` + AP1 `lifecycle_phase` už enforce volume cap. Ale **timing** = stejná spike whether mailbox je 1d nebo 30d starý.

Co uděláme:

Send batch logic respektuje phase:

- `warmup_d0` (cap 5): pošli rozprostřeno mezi 10:00–14:00 (4h window, max 1.25 maily/h)
- `warmup_d3` (cap 10): 9:00–17:00 (8h, ~1.25/h)
- `warmup_d7` (cap 25): 8:00–18:00 (10h, ~2.5/h)
- `production` (cap 100): celé pracovní okno + může jet i ráno víkend

Plus default exit window: žádný send v `00:00..06:00 Europe/Prague` regardless of phase. Hard guard.

**Sprint AR18 — HELO/EHLO audit** (P0, 1d)

Z paměti `feedback_helo_audit_blind_spot` HARD: HELO claim je separate identity od TCP source IP. Při PR #740 incidentu bylo localhost-HELO = relay bug (vypadalo jako "stroj posílá z localhost" ale TCP zdroj byl Mullvad CZ exit).

Co uděláme:

Audit current HELO behavior v `features/outreach/relay/internal/delivery/smtp.go` (nebo equivalent). Ujistit se že:

1. HELO/EHLO claim odpovídá hostname Mullvad CZ exit (nebo generic mail server hostname jako `mail.cz` — ne hostname relay containera)
2. HELO není literal IP adresa (špatně)
3. HELO je každém pokusu konzistentní (ne random)

Test: SMTP probe na vlastní debug endpoint co loguje HELO claim. Compare s Mullvad rDNS pro tento exit.

Pokud nesprávné → fix v transport layer.

## Pořadí + závislosti

| Sprint | Závislost | Effort | P |
|---|---|---|---|
| AR2 tracking pixel audit | žádná | 0.5d | P0 |
| AR6 cron jitter | žádná | 0.5d | P0 |
| AR8 agregátní volume cap | AP1 schema | 1d | P0 |
| AR11 bounce rate auto-pause | AP6 vzor | 1d | P0 |
| AR18 HELO audit | žádná | 1d | P0 |
| AR1 content variation | AR2 ✓ | 2d | P1 |
| AR3 HTML struktura variace | AR1 vzor | 1d | P1 |
| AR7 send window enforcement | žádná | 1d | P1 |
| AR10 reply chain simulation | AR14 base | 3d | P1 |
| AR14 IMAP behavior | AR10 design | 2d | P1 |
| AR17 account age scheduling | AR7 base | 1d | P1 |
| AR12 spam FBL research | žádná (research) | 1d | P2 | ✓ |
| AR13 engagement-driven cap | AR2 (pokud open OFF) | 2d | P2 |
| AR15 Mullvad reputation | AP4 schema ✓ | 1d | P2 |
| AR16 SPF/DKIM monitoring | žádná | 0.5d | P2 |
| AR4 TLS JA3 | research | 3d | P2 |
| AR5 krátké URL ban | žádná | 0.25d | P2 | ✓ |
| AR9 warmup ramp | hotovo (AP1) | 0d | P3 |

**Total ~20 dní práce** rozdělených do P0 (4d), P1 (10d), P2 (8d).

P0 = před příští kampaní. P1 = během prvního měsíce production. P2 = jakmile reputace stabilizuje + máme metriky.

## Otevřené otázky

1. **Open tracking on/off?** Per memory `feedback_no_unsub_url_in_body` — unsub URL **NE**. Tracking pixel je v podobné kategorii. Pokud OFF, AR13 engagement-driven cap musí použít reply rate (větší šum). Operator decision.

2. **Reply simulation autenticity** — AR10 simulovaná odpověď musí být plausible. Generická "Děkujeme, momentálně bez zájmu" by byla stejná napříč všemi → fingerprint. Per email plně náhodné via LLM = drahé + risk halucinace. Jaká rovnováha?

3. **Send window granularity per mailbox** — AR7 default 09:00–17:00, ale operator může chtít custom okno per persona / per campaign. UI work?

4. **AR8 GLOBAL_AGGREGATE_CAP startovní hodnota** — 50/h initially? Postupně raise jak reputace? Decision criteria?

5. **AR12 Seznam FBL** — pokud neexistuje, je potřeba akceptovat slepé místo nebo zkusit alternativu (manuální monitoring `mailbox-abuse@email.cz` complaints if Seznam forwards them)?

## Co tato iniciativa NEDĚLÁ

- 3rd party deliverability service (memory `feedback_no_external_services`)
- Vlastní SMTP server jako alternativa Seznam (out of scope, separate decision)
- AI-driven content rotation (LLM cost + halucinace risk; humanize engine SAFE profile dostačuje)
- Behavioral biometrics (mouse moves při operator UI use — overkill)
- Multi-region BFF (per CLAUDE.md egress canonical Mullvad-only)
