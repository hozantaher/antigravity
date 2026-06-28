# First Live Campaign — Plán

> **Goal:** Spustit první ostrou B2B outreach kampaň na dealer-partnery
> těžké techniky. Flow: segment → uložit → kampaň → naplánovat obesílání →
> hlídat odpovědi → ukládat leady.

---

## 1. Cílový segment

**CZ-NACE 43.11 + 43.12 — Demolice a zemní práce**

Rozhodnutí postavené na:
- každá taková firma **prakticky jistě** provozuje rýpadla / nakladače / dampery
- malé až střední firmy (2–30 osob) → jeden rozhodovatel (majitel / jednatel)
- dohledatelné v ARES přesně přes NACE, ~3–5k subjektů v ČR
- cyklický nákup opotřebitelné techniky (2–5 let) → timing nemusí sedět „na den"

**Filtr první vlny:**
- `category ∈ {43.11, 43.12}`
- `email.status = valid` (po verifikaci)
- `hasWebsite = true`
- `region = CZ`
- `lastContactedNever = true`
- **cap: 300 firem** → po verifikaci ~150–200 odeslatelných

**Záložní segmenty pro 2. vlnu:** NACE 08 (kamenolomy), 02.40 (lesnictví), 38.11 (odpady).

---

## 2. Co je hotovo (po merge `wm/new-features`)

Scout potvrdil:

| Vrstva | Stav | Zdroj |
|---|---|---|
| Segmenty + NACE kategorie | ✓ | `internal/segment/store.go`, `internal/classify/nace_map.go` |
| Kampaň (sequence + cadence) | ✓ | `internal/campaign/runner.go` |
| MX/SMTP verifikace | ✓ | `internal/validation/verifier.go` — catch-all, role, spamtrap |
| Mailbox pool + warmup | ✓ | `internal/mailbox/`, `internal/warmup/` |
| SOCKS5/HTTP proxy per mailbox | ✓ | migrace 039 |
| Circuit breaker + auth-fail | ✓ | migrace 038–040 |
| Tracking pixel + click redirect | ✓ | `/o`, `/c` endpointy |
| Spintax + persona + humanize | ✓ | `internal/content/spin.go`, `internal/humanize/` |
| IMAP poller + reply classifier | ✓ | `internal/imap/`, `internal/thread/` |
| Bounce processor + suppression | ✓ | `internal/bounce/`, migrace 037 |
| DNS/DMARC L3 probe | ✓ (S4) | `internal/protections/probe/probes_l3_dns.go` |
| Per-send protection_trace | ✓ (S6) | migrace 042, `internal/sender/trace.go` |
| Alert routing + escalace | ✓ (S7) | migrace 043, `internal/protections/alert/` |
| Observability hardening | ✓ (S8) | `internal/protections/probe/metrics_sink.go` |

## 3. Co chybí před prvním odesláním

Přesný rozpis sprintů viz [FIRST-CAMPAIGN-SPRINTS.md](FIRST-CAMPAIGN-SPRINTS.md).

**Kritická cesta:**
1. Scheduler daemon (runner je dnes CLI-only)
2. Pre-send verification gate (`status=valid` only)
3. Unsubscribe footer injection (ověřit, že je v každé šabloně)
4. DNS/DMARC preflight audit 24 mailboxů (přes S4 probe)
5. UI — Uložit segment / Vytvořit kampaň / Inbox
6. Šablony + spintax (prvokontakt + 2 follow-upy)
7. Leads tabulka + auto-insert na `reply_type=interested`

## 4. Obsah mailu — „jako člověk"

**Strukturální:**
- plain-text first, HTML minimální (žádné tabulky, žádný hero obrázek)
- max 700 znaků těla
- jeden link, ne pět
- **první mail bez tracking pixelu** — zapnout až od follow-upu 1
- reply-to == from vždy (Gmail jinak flaguje jako phishing)

**Jazyk:**
- šablona = kostra, LLM varianta = úvod (D2 sprint)
- česky, krátké věty, bez „obchoďáckého jazyka"
- žádné `REVOLUČNÍ` / `ULTIMÁTNÍ` / `Dobrý den, doufám, že se máte krásně`
- česká diakritika musí jít přes quoted-printable (RFC 2047)

**Persona:**
- `jmeno.prijmeni@dealer-partner.cz` (ne `sales@`, ne `info@`)
- podpis = jméno + telefon + firma, **bez webu v podpisu** (další link = penalty)
- 1 persona = 1–3 mailboxy (nesdílet fingerprint napříč 24)
- humanize ON, per-persona nastavený (cirkadián, tón, imperfekce)

**Deterministická variabilita:**
- spintax seed = `sha256(contact_id + step_idx)` → reodesíláním vznikne stejný mail
- LLM variace také seedem řízená (přes `temperature=0` + seeded prompt hash)

## 5. Verifikace před odesláním

Pipeline (existuje, jen musí být v kampani povinná):

1. syntax regex + unicode
2. MX lookup (doména existuje + MX záznam)
3. domain cache (7 dní)
4. SMTP RCPT TO probe **přes rotační SOCKS5** (nikdy z provozní IP!)
5. catch-all detekce (náhodná lokální část)
6. role detekce (`info@`, `sales@`, `office@` → `role_only`)
7. disposable + spamtrap listy

**Gate:** odesílat JEN `status=valid`. Ostatní → review queue, NE do kampaně.

Probe rate limit: **≤20 domén/min/pool-IP**. Nad tím signál „scan" → blacklist.

## 6. Reply loop

- IMAP poller matchuje přes `In-Reply-To` / `References` (hotovo)
- classifier: `interested / not_interested / meeting / reply_unclass / bounce / opt_out` (hotovo)
- **auto-reply na opt-out = NE** (= confirmation že schránka žije = budoucí spam)
- `interested` → nová `leads` tabulka + webhook (E1 sprint)
- obrázky v příchozích: ukládat metadata vždy, bytes jen pokud `< 1 MB`
- ruční „Odpovědět" z UI přes stejnou personu / mailbox (E3 sprint)

## 7. Pasti

| Past | Dopad | Mitigace |
|---|---|---|
| Nový mailbox posílá 300/den od 1. dne | Google/O365 blok na měsíce | warmup plán (máme) — den 1 = 20/den, rampa +10/den |
| SPF/DKIM/DMARC chybí | 40 % mailů do spamu | A4 sprint — DNS/DMARC preflight audit (S4 probe) |
| 1 IP = 24 mailboxů | 1 spam report zabije všech 24 | SOCKS5 pool, 1 IP = max 3 mailboxy |
| Rate-limit na Seznam.cz ~30/hod/IP | throttle | domain throttler (máme) — 20/hod/doména/mailbox |
| Všechny maily v 09:00:00 | bot fingerprint | humanize jitter ±90 min (máme) |
| Suppression race — opt-out během vlny | právní riziko | re-check suppression těsně před `smtp.Data()` |
| Bounce burst první den | circuit breaker zavře mailbox | OK pokud `status=bounce_hold`, ne `retired` |
| Double-send při scheduler race | kontakt dostane 2× mail | Postgres advisory lock + `UNIQUE (campaign_id, contact_id, step_idx)` |
| **Holding/pobočky** — 50 firem sdílí `info@holding.cz` | 50 mailů jedné osobě → spam report, blacklist | A5 dedup gate: `UNIQUE (campaign_id, email_hash)` + domain cap (default 3) + holding cluster cap (1) |
| **Doménový flood** — 10 kontaktů ze stejné domény | doména nás zablokuje | A5 `DomainCap` konfigurovatelný per-kampaň |
| Česká diakritika v Subject | encoding degradace `???` | quoted-printable, RFC 2047 |
| SMTP probe z provozní IP | „scanning" signál → blacklist | přes rotační SOCKS5 pool |

## 8. Timeline (3 týdny k ostrému startu)

- **Týden 1 (EPIC A + B):** Foundations + Segment UI
- **Týden 2 (EPIC C + D):** Campaign UI + Content library
- **Týden 3 (EPIC E + F):** Reply loop + Pre-flight + Go-live na 30 kontaktech

Detailní sprinty + akceptační kritéria → [FIRST-CAMPAIGN-SPRINTS.md](FIRST-CAMPAIGN-SPRINTS.md).

## 9. Open questions (potřebuju odsouhlasit)

1. Kategorie — potvrdit NACE 43.11+43.12, nebo jinou?
2. Cap první vlny — 300 firem → ~150–200 odeslaných?
3. Persona identita — reálný člověk-dealer nebo smyšlený?
4. Kdo bere `interested` leady (obchoďák / integrace / manuál)?
5. LLM variace už v 1. vlně, nebo až ve 2.?
6. Pořadí sprintů — souhlas, nebo přerovnat?
