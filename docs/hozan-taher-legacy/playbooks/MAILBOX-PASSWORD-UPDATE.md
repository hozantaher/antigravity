# MAILBOX-PASSWORD-UPDATE — nastavení / rotace hesla Seznam schránky

Kanonický flow pro nastavení nebo rotaci hesla libovolné Seznam schránky používané v `modules/outreach`.

---

## 1. Kdy použít

- **Nová schránka** přidaná do systému (po registraci / zakoupení účtu).
- **Plánovaná rotace** — quarterly (každých 90 dní), viz `docs/playbooks/SECRET-ROTATION-LOG.md`.
- **Po security incidentu** (leak, podezřelý přístup, detekce v Have I Been Pwned).

---

## 2. Pre-requisites

- Přístup k **Seznam webmailu** (login existující schránky).
- Přístup k **dashboardu** (local `http://localhost:5175` nebo prod URL) s rolí `operator`.
- **NEMÍT** Railway CLI otevřené — heslo do env vars po SEND-S6.4 memory rule **nikdy nejde**. DB je jediný zdroj pravdy.

---

## 3. Kroky

### a. Login do webmailu
Otevři `https://email.seznam.cz/` a přihlas se pod schránkou, kterou nastavuješ.

### b. Zjisti 2FA stav
Dvoufázové ověření (2FA) rozhoduje o tom, jaký typ hesla použiješ.
Nápověda: <https://o-seznam.cz/napoveda/ucet/dvoufazove-overeni/co-to-je/>.

### c. Pokud **2FA ZAPNUTO** → vygeneruj "heslo pro aplikace"
Seznam SMTP/IMAP nepodporuje interactive 2FA, potřebuješ app-password.
Postup: <https://o-seznam.cz/napoveda/ucet/dvoufazove-overeni/postovni-programy/>.

Výstup je **16znakový řetězec** (bez mezer po zkopírování). Platí dokud ho manuálně nezrušíš.

### d. Pokud **2FA VYPNUTO** → použij login password
Můžeš použít stávající heslo webmailu, **nebo** zvaž zapnutí 2FA a přechod na app-password (doporučeno pro B2B provoz).

### e. Paste do dashboardu
1. Otevři `/mailboxes`.
2. Klikni **Edit** na dotčenou schránku.
3. Paste heslo do pole **Password**.
4. **Save**.

Heslo je odesláno do Go backendu přes BFF (`X-API-Key` chráněný endpoint) a zašifrované uloženo v `outreach_mailboxes.password`.

### f. Probe AUTH přes relay
```bash
curl -sS -X POST "https://<relay>/v1/auth-check" \
  -H "X-API-Key: $RELAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"host":"smtp.seznam.cz","port":465,"username":"X@email.cz","password":"<pasted>"}'
```
Očekávaná odpověď: `{"ok": true}`. Pokud `false` s `535 5.7.8` → viz §4.

### g. Circuit reset (pokud byla schránka paused)
```sql
UPDATE outreach_mailboxes
SET status = 'active', status_reason = NULL
WHERE from_address = 'X@email.cz';
```
Alternativně: dashboard `/mailboxes` → Resume.

### h. Self-send test
Z dashboardu pošli **jeden** test email na vlastní (jinou) schránku. Ověř delivery (ne spam složka) + raw hlavičky.

### i. Update rotation log
Zapiš do [`docs/playbooks/SECRET-ROTATION-LOG.md`](./SECRET-ROTATION-LOG.md): datum, mailbox, výsledek probe (`OK` / `FAIL`), důvod rotace (new / scheduled / incident).

---

## 4. Pokud AUTH fails

| Stav | Symptom | Fix |
|---|---|---|
| 2FA zapnuté, použit login password | `535 5.7.8 authentication failed` | Vygeneruj nové **app-password** (§3c), paste znovu. |
| 2FA vypnuté, špatné heslo | `535 5.7.8` | Změň heslo ve webmailu, paste nové; pokud blokováno, web login hlásí captcha / lock → počkej 15 min. |
| Connection refused / timeout | Probe curl nedokončí | Relay down → `curl https://<relay>/healthz` + Railway logs `anti-trace-relay`. |
| 535 ale heslo OK | App-password expired | Seznam občas invaliduje app-passwords po security eventu → vygeneruj nové. |

---

## 5. Bezpečnostní pravidla (HARD RULES)

1. **NIKDY** heslo do Railway env vars po bootstrap. DB `outreach_mailboxes.password` je jediný zdroj pravdy.
2. **NIKDY** paste heslo do chatu / logů / `.env` souboru lokálně.
3. **NIKDY** heslo do commitu — gitleaks hook tě zastaví, nespoléhej na to.
4. **Rotace po exposure** — pokud heslo viděl někdo jiný (screen share, screenshot, log leak) → okamžitá rotace podle tohoto runbooku.
5. App-password **> login password** pro B2B — menší blast radius při leaku.

---

## 6. Odkazy

- [`DISCIPLINE.md`](../../DISCIPLINE.md) — secret rotation sekce
- [`SEND-OPERATIONS.md`](./SEND-OPERATIONS.md) — non-auth blokery
- [`SECRET-ROTATION-LOG.md`](./SECRET-ROTATION-LOG.md) — historie rotací
- [`../initiatives/2026-04-22-send-pipeline-unblock.md`](../initiatives/2026-04-22-send-pipeline-unblock.md) — SEND initiative (S6.5 provenance)
