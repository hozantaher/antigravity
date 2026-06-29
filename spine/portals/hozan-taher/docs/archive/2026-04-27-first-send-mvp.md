# First Real Send MVP

**Status:** Superseded
**Datum:** 2026-04-27
**Trigger:** MVP send gate achieved 2026-04-27; subsumed into master plan phase 0

**Související:**
- [2026-04-27-launch-fasttrack.md](2026-04-27-launch-fasttrack.md) — širší 1-denní paralelní pipeline
- [2026-04-27-launch-readiness.md](2026-04-27-launch-readiness.md) — 3-denní conservative variant
- [feedback_campaign_send](memory) — HARD RULE: nikdy bez explicit GO

## Cíl

Odeslat **1** ostrý B2B e-mail z campaign 455 na verifikovaného CZ recipienta
přes produkční pipeline. Po úspěšném single-send rozhodnout o scale-up na
zbývajících 19 kontaktů kampaně.

Tento dokument je **MVP**: minimální blocking checklist, ne full production
hardening. Production-grade gates jsou v `launch-readiness.md`.

## Test recipient

| Field | Value |
|---|---|
| contact_id | 418176 |
| email | ing.martincech@centrum.cz |
| firma | Stavební firma Čech |
| segment | construction (CZ-NACE 41-43) |
| source | firmy.cz |

Důvod výběru: jediný eligible kontakt v campaign 455 (ostatních 19
deferred to next_send_at = NOW() + 30d). Stavební firma = naše core
vertical pro odkup techniky.

## Sprinty

### S1 — Pre-flight (15-30 min)

**Cíl:** ověřit, že pipeline je v provozním stavu PŘED sendem.

| ID | Task | Stav | Ověření |
|---|---|---|---|
| S1.1 | Transport mode | TODO | Sender používá native SMTP submission (auth + STARTTLS) na provider, NE SOCKS5 churn ani localhost openssl. Check env + `features/outreach/campaigns/sender/antitrace.go`. |
| S1.2 | Mailbox auth | TODO | IMAP login na sending mailbox funguje s heslem z `outreach_mailboxes`. Test: `pnpm probe:smtp <mailbox_id>`. |
| S1.3 | Suppression UNION | TODO | Pre-send guard volá UNION nad `outreach_suppressions` ∪ `suppression_list`. Recipient `ing.martincech@centrum.cz` ne v žádné tabulce. |
| S1.4 | Reply classifier | TODO | `features/platform/common/humanize/response.go` rozezná reply „nechci" → ReplyNegative → suppression cascade. Existující test musí passovat. |
| S1.5 | Footer compliance | DONE | `intro_machinery.tmpl` v35 obsahuje § 7 marker + opt-out + source. |
| S1.6 | Strict geo proxy | DONE | `features/outreach/relay/internal/transport/proxy_pool.go` filtruje pool na PROXY_COUNTRY_CODES, default Central Europe (CZ,SK,DE,AT,PL,HU,SI); `PROXY_STRICT_GEO=1` v relay env hard-rejectuje non-EU (Vietnam). 17 nových testů + 1384 legacy passes. |

**Akceptace S1:** všech 6 řádků ✓. Pokud kterýkoliv ✗ → fix nebo abort.

**Deployment poznámka pro S1.6:** kód je merged, ale `PROXY_STRICT_GEO=1` musí být nastaven v relay service env (Railway dashboard). Bez toho fix neaktivní.

### S2 — Single send + monitor (30-60 min)

**Cíl:** odeslat 1 e-mail, ověřit dispatch + bounce-free + reply path.

| ID | Task | Ověření |
|---|---|---|
| S2.1 | Explicit GO | Tomáš písemně potvrdí v chatu „GO send 418176". Bez tohoto NEsend (memory rule). |
| S2.2 | Trigger send | Spuštění campaign-run pro contact 418176. Either `/tmp/outreach-bin campaign-run 455` (single eligible) nebo manuální dispatch z BFF. |
| S2.3 | Verify dispatch | Row v `send_events` se status `sent`, timestamp, mailbox_id correct. Log line `op=sender.engine.send/ok`. |
| S2.4 | Verify Sent folder | IMAP login na sending mailbox → e-mail v Sent/Odeslané. Body matches v35 render. |
| S2.5 | Bounce monitor (30min) | IMAP poller checkuje inbox každých 60s. Žádný hard-bounce notification. |
| S2.6 | Spam-flag check | SMTP response 250 OK pro RCPT TO. Žádný 4xx greylist nebo 5xx reject. |
| S2.7 | Reply window (1h) | Pasivně sleduj 1 hod. Pokud reply „nechci" → verify suppress fires. Pokud reply pozitivní → eskalace Tobě. |

**Akceptace S2:**
- ✓ `send_events.status='sent'` pro 418176
- ✓ E-mail v Sent folderu
- ✓ Žádný bounce do 30 min
- ✓ SMTP 250 OK
- ✗ pokud cokoliv → STOP + root-cause před S3

### S3 — Scale gate (decision)

**Cíl:** rozhodnout, zda pokračovat na zbývajících 19 kontaktů.

| Scenario | Rozhodnutí |
|---|---|
| S2 plně OK + recipient nereagoval | Proceed: scale to 5 contacts (gradient ramp, 1/hour) |
| S2 OK + reply pozitivní | Hold: focus on lead, scale up po vyřízení |
| S2 OK + reply „nechci" | Proceed: scale to 5 contacts, suppress fired = system works |
| Bounce hard | Hold: review address quality, consider segment audit |
| Spam-flag (5xx) | Stop: deliverability problém, vyřešit před scale |

Decision log v tomto souboru pod sekcí **Send log** níže.

### S4 — Post-launch hardening (1-2 týdny)

**Cíl:** dotáhnout production-grade gates, které nejsou MVP-blocking.

| ID | Task | Priorita | ETA |
|---|---|---|---|
| S4.1 | List-Unsubscribe header (RFC 8058) | P1 | týden 1 |
| S4.2 | privacy@hozan-taher.cz inbox + monitoring | P1 | týden 1 |
| S4.3 | Footer update: doplnit privacy@ DSR | P1 | po S4.2 |
| S4.4 | Retention cron (auto-delete >12 měsíců) | P2 | týden 2 |
| S4.5 | Auto-suppress on hard bounce + 3× soft | P2 | týden 2 |
| S4.6 | LIA refresh pro current scope (machinery export MENA) | P2 | týden 2 |
| S4.7 | Subprocessor DPA review (Railway, Seznam) | P3 | měsíc 1 |
| S4.8 | Dedicated sending domain @hozan-taher.cz (SPF/DKIM/DMARC) | P3 | měsíc 1+ |

## Hard red lines (NESKIPOVAT)

1. **NEsendovat dokud Tomáš explicit GO neudělá** (memory `feedback_campaign_send`)
2. **NEsendovat na suppressed kontakt** (UNION check je gate)
3. **NEsendovat z localhost openssl/curl** (memory `feedback_no_direct_smtp`)
4. **Mailbox heslo NIKDY do env/.env/log** (memory `feedback_mailbox_passwords_via_db`)
5. **Při bounce >5% nebo complaint stop** (Tvoje hard rollback rule)

## Současný stav patičky (v35)

```
--
Tomáš Messing, Garaaage s.r.o.
Purkyňova 74/2, 110 00 Praha 1, IČ 23219700

Pokud si nepřejete, abych Vás kontaktoval, napište mi „nechci"
a víc se neozvu. Tento e-mail byl odeslán v rámci oprávněného
zájmu jako obchodní sdělení dle § 7 zák. 480/2004, kontakt
jsem našel ve veřejném rejstříku firmy.cz.
```

Compliance floor:
- ✓ § 7 marker (zák. 480/2004)
- ✓ identifikace odesílatele (firma + IČ + adresa v signatuře)
- ✓ opt-out instrukce (reply „nechci")
- ✓ source data (firmy.cz)
- ✓ legal basis (oprávněný zájem)
- △ DSR contact (chybí privacy@ — doplníme v S4.3)
- △ retence claim (chybí, nejde-li o public registry data)

## Send log

| Datum | Recipient | Outcome | Notes |
|---|---|---|---|
| — | — | — | čekáme na S1 + S2 |

(Aktualizovat po každém realném sendu.)

## Otázky k Tobě

1. Mám teď spustit S1 pre-flight checks?
2. Po pre-flight pass — explicit GO pro send na 418176?
3. Souhlasíš s footer v35 jako MVP minimum (DSR contact až v S4)?
