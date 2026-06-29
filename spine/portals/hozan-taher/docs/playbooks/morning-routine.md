# Morning Routine — 3 kroky a kampaň jede

> **Status:** Active
> **Datum:** 2026-05-01
> **Audience:** operator (Tomáš) — daily startup
> **Companion piece:** [operator-launch-checklist.md](operator-launch-checklist.md) for the
> first-launch 90-minute Phase 0 session. This doc covers the daily routine
> after Phase 0.

Single-screen checklist pro každodenní zahájení kampaně. Otevři aplikaci,
klikni **Příprava** v levém menu (klávesa ⌘0) a sleduj 3 karty.

## Otevři Přípravu

`http://localhost:18175/priprava` (lokálně) nebo `https://outreach.garaaage.cz/priprava` (prod).

Stránka obnoví status každých 60 s. Refresh button v pravém horním rohu pro okamžitý update.

## 3 karty, každá zelená

### 1. Schránky s heslem

- ✓ zelená = všech 24 schránek má reálné heslo (8+ znaků, ne placeholder)
- ✗ červená = některé schránky mají `xxxx`, `password`, `admin` ap.

**Co dělat když červená:**

1. Klikni "Otevřít" na kartě → /mailboxes
2. Klikni řádek schránky → drawer "Upravit"
3. Vyplň heslo (Seznam app-specific password, generuj na
   https://email.seznam.cz/ → Developer Settings → App Passwords)
4. Klikni "Uložit"

Nebo deep-link rovnou ze samotné karty Příprava — rozbal "Schránky bez hesla"
a klikni mailbox; drawer se otevře automaticky přes `?mb=<id>`.

**HARD RULE** (memory `feedback_mailbox_passwords_via_db`): hesla
NIKDY do env vars; výhradně přes UI nebo přímý SQL UPDATE.

### 2. E-mail (šablona)

- ✓ zelená = aspoň jedna šablona má neprázdný předmět + tělo
- ✗ červená = žádná šablona, nebo všechny mají chybějící pole

**Co dělat když červená:** klikni "Otevřít" → /templates → Nová šablona →
vyplň předmět + tělo → Uložit.

GDPR patička se přidává automaticky runner.go při odesílání (controller
identita + IČO + sídlo + zdroj dat + čl. 6/1/f + Recital 47 + unsub link
+ STOP keyword + privacy URL). Audit ratchet
`features/outreach/campaigns/content/gdpr_footer_audit_test.go` blokuje merge
šablony, která některé z 9 polí postrádá.

### 3. Segment (sektor)

- ✓ zelená = víc než 0 odesilatelných kontaktů ve vybraných sektorech
  (po aplikaci suppression UNION)
- ✗ červená = 0 kontaktů, nebo prospect data neimportovány

**Co dělat když červená:** klikni "Otevřít" → /campaigns/new → krok 3
→ zaškrtni jeden nebo více sektorů (machinery, metalwork, atd.).

Sektory jsou pevný seznam 13 položek (machinery, metalwork, construction,
agriculture, transport, automotive, woodwork, plastics, food_processing,
chemicals, waste, energy, printing). Mapování company → sector se děje
v `features/acquisition/contacts/classify/`.

## Když všechny 3 zelené

Dole se zobrazí prominentní tlačítko **"Pokračovat na Novou kampaň"**.
Klikni → /campaigns?new=1 → 4krokový formulář:

1. **Základní info** — název, popis (pro audit log + reporty)
2. **Šablona** — vyber jednu z hotových
3. **Segment** — zaškrtni sektory (které jsi viděl v Přípravě)
4. **Sekvence** — ponech default (initial → followup1 +3 dny → final +7 dní)

Po Vytvoření je kampaň v `paused` stavu. Klikni **Aktivovat** v Kampaních.

## Pre-flight gate

Když klikneš Aktivovat, BFF spustí pre-flight (M1/T1/S1 checks identické
s Přípravou). Pokud cokoli chybí, dostaneš toast typu:

> Nelze spustit: Schránka, Sektor. Otevři Přípravu.

Otevři Přípravu, vyřeš červené body, vrať se a klikni Aktivovat znovu.

**Bypass** (pouze deliberate override): `?force=1` query param.
NIKDY tohle nepoužívej v produkci bez vážného důvodu — gate existuje
kvůli reálným silent-failure incidentům.

## První tick scheduleru

Po `Aktivovat` se kampaň přepne na `running`. Reálný send se děje na
následujícím scheduler ticku (každých ~60 s — viz
`features/outreach/campaigns/campaign/scheduler.go`). První mail tedy odejde
do minuty.

Sledování:
- /replies — odpovědi prichází za hodiny/dny, klasifikátor je značí
- /watchdog — alerts při bounce burst nebo SMTP-AUTH selhání
- /observability — system-wide health (cron heartbeats, drift)

## Když něco selže

| Symptom | Kde se dívat |
|---|---|
| Žádné sendy po Aktivovat | /observability `runFullCheckCron` heartbeat — pokud stale, cron je broken |
| Vysoká bounce rate | /watchdog — ukáže auto-hold per mailbox, F3-1 backpressure feed |
| Kampaň `paused` sám | Sentry breadcrumbs — `campaign.scheduler/auto-pause` op |
| 0 sendů ale status `running` | `pnpm report` z features/platform/outreach-dashboard — unified diagnostic |

Detailní troubleshooting: [first-campaign-launch.md](first-campaign-launch.md)
+ [bot-operations.md](bot-operations.md).

## Související

- [operator-launch-checklist.md](operator-launch-checklist.md) — Phase 0 90-min onboarding
- [first-campaign-launch.md](first-campaign-launch.md) — 0→1→5→20 escalation staircase
- [auth-fail-alert-response.md](AUTH-FAIL-ALERT-RESPONSE.md) — když SMTP-AUTH začne padat
- API endpoint: `GET /api/morning-readiness` (synth aggregátor pro Příprava UI)
- Memory: `feedback_mailbox_passwords_via_db`, `feedback_campaign_send`
