# Sprint N1 — Migrace outbound pošty na vlastní doménu

**Verze:** 1.0  
**Datum:** 2026-05-12  
**Status:** Strategické podklady — operátor rozhoduje o aktivaci  
**Trigger:** Gmail spam diagnostika 2026-05-12 (freemail mismatch flag, datacenter VPN IP)

---

## Kontext

Současný setup: outbound kampané jdou přes 4 produkční mailboxy @seznam.cz (id 1, 3, 631, 632). Seznam řeší SPF/DKIM/DMARC na své doméně. Garaaage.cz se používá pro web, privacy@ kontakt a IČO disclosure, ale NE jako sender doména.

**Proč migrace nyní:**

1. **Gmail spam diagnostika (2026-05-12):** inbox placement audit u konkrétní kampáně (výkupní nabídka) ukázal, že Gmail mismatch flag ("From doména ≠ seznam.cz") způsobuje downrank do promotions či spam. Freemail sender s vlastní brand domenou signalizuje B2B spam; Gmail preferuje either čisté freemail, nebo plnou DMARC p=reject za vlastní doménou.

2. **Vyšší deliverability:** @balkanmotors.cz nebo @garaaage.cz s vlastním SPF/DKIM/DMARC (p=quarantine → p=reject fáze) signalizuje legitimitu. Datacenter VPN IP (Mullvad SOCKS5) sám o sobě není problém, ale freemail FromAddress + datacenter IP = kombinace rizika.

3. **Compliance refresh:** Privacy Notice, LIA a Art. 30 registr aktuálně identifikují seznam.cz jako e-mailového poskytovatele. Migrace vyžaduje update těchto dokumentů s novým e-mailovým operátorem a kontrolór identitou ve footeru.

4. **Brand alignment:** @balkanmotors.cz je stávající doména (produkční) a lépe vyjadřuje business identitu než @seznam.cz. @garaaage.cz je privací doména, méně zaměřená na konkrétní podnikání.

---

## Výběr domény

### Kritéria

| Faktor | @balkanmotors.cz | @garaaage.cz | Nová doména |
|--------|-----------------|--------------|-----------|
| **Brand alignment** | Vysoká (stávající web) | Střední (holding společnost) | Vysoká (čistá volba) |
| **Existující reputace** | Střední (web traffic, ne email) | Nízká (email nepoužívána) | Nulová (cold start) |
| **DKIM/DMARC setup** | Lokální control | Lokální control | Lokální control |
| **Warmup čas** | 30 dní (AP1 fáze) | 30 dní | 30 dní |
| **Náklady DNS** | 0 Kč (já kontroluji) | 0 Kč (já kontroluji) | 500–1000 Kč/rok |
| **Operátor dopad** | Minimální (existuje infra) | Minimální (existuje infra) | Maximální (nová doména) |

### Doporučení

**Prvotní volba: @balkanmotors.cz**

- Dominuje produkční web infrastructure s aktuálními DNS záznamy
- Brand identita (výkupní nabídka) lépe koresponduje s balkanmotors.cz než seznam.cz
- Nula dodatečných nákladů
- DKIM selector můžeš rozdělit (balkanmotors: existující web domovský; outreach: oddělený DKIM key pro kampaně)

**Alternativa: @garaaage.cz** (pokud chceš separaci)

- Privací hranice mezi web identitou a B2B outreach
- Stejné technické nastavení jako balkanmotors.cz
- Operátor později lehce migruje na dalších 10+ vlastních domén (holdingová struktura)

---

## DNS záznamy — podrobný návod

Volba e-mailového serveru diktuje tvar SPF/DKIM/DMARC. Zde jsou kroky pro **nejčastější sady** (Microsoft 365, Google Workspace, Mailcow self-hosted).

### MX záznamy (prvotní krok — všichni)

E-mail se doručuje na **inbound** server. Outbound (SMTP) jde z relaye, ale MX definují autoritu recepty.

**Příklad pro Microsoft 365:**
```
MX 10 balkanmotors-cz.mail.protection.outlook.com.
```

**Příklad pro Google Workspace:**
```
MX 10 smtp.google.com.
```

**Příklad pro Mailcow (vlastní VPS):**
```
MX 10 mail.balkanmotors.cz.
```

---

### SPF (TXT record na @)

SPF záznam definuje, **které IP adresy mohou odesílat e-maily z tvé domény.** Začínáš `v=spf1` a přidáváš include direktivy.

**Základní šablona:**
```
v=spf1 include:_spf.microsoft.com ~all      # Microsoft 365
v=spf1 include:sendgrid.net ~all            # SendGrid relay
v=spf1 ip4:1.2.3.4 ~all                     # Vlastní IP (málo použitý)
v=spf1 include:mail.garaaage.cz ~all        # Mailcow (vlastní doména)
```

**Co máš v hozan-taher:**

Zatím nemáš SPF pro garaaage.cz ani balkanmotors.cz. Musíš přidat:

1. **Pokud jsi u Microsoft 365 / Google Workspace:**
   ```
   TXT balkanmotors.cz: v=spf1 include:_spf.microsoft.com include:sendgrid.net ~all
   ```
   (Nebo jen include bez sendgrid, pokud nepoužíváš SendGrid relay.)

2. **Pokud jsi u Mailcow (vlastní VPS):**
   ```
   TXT balkanmotors.cz: v=spf1 ip4:<TÁ_IP> ~all
   ```
   (Nahraď `<TÁ_IP>` skutečným IP adresou Mailcow serveru.)

3. **Mullvad SOCKS5 egress (aktuální setup):**
   SPF nemá smysl pro SOCKS proxy, protože Mullvad IP se mění. **Řešení:** DMARC p=none → p=quarantine → p=reject (viz níže). SPF nastavíš jen pro **fallback send path** (pokud existuje).

---

### DKIM (TXT record na `selector._domainkey.domain`)

DKIM je digitální podpis e-mailu. Veřejný klíč je v DNS; privátní klíč zůstává na serveru.

**DKIM selektor = identifikátor klíče** (můžeš mít vícero — `selector1._domainkey.balkanmotors.cz`, `selector2._domainkey.balkanmotors.cz`, atd.).

**Typický DKIM záznam:**
```
TXT selector1._domainkey.balkanmotors.cz: v=DKIM1; k=rsa; p=MIGfMA0B...
```

**Jak generovat DKIM klíč:**

**OpenSSL (CLI):**
```bash
# Generuj 2048-bit RSA klíč
openssl genrsa -out /path/to/private.key 2048

# Extrahuj veřejný klíč
openssl rsa -in /path/to/private.key -pubout -outform PEM | grep -v "BEGIN\|END" | tr -d '\n'
```

Výstup veřejného klíče je dlouhý string — to je obsah `p=...` v DNS TXT.

**Doporučené nastavení:**

- **Bitová délka:** 2048 bit (standard); 1024 bit je zastaralý, ale kompatibilní. Nové klíče: 2048.
- **Selektor:** pojmenuj podle senderu (např. `outreach1._domainkey.balkanmotors.cz` pro kampáně; `web1._domainkey.balkanmotors.cz` pro web contact).
- **Rotace:** při kompromisu klíče vygeneruj nový selektor (např. outreach2), zaregistruj do DNS, uprav privátní klíč na serveru, pak po 30 dnech starej outreach1 selektor.

---

### DMARC (TXT record na `_dmarc.domain`)

DMARC definuje, co se stane s e-maily, které **selhaly SPF nebo DKIM.**

**Typický DMARC záznam:**
```
v=DMARC1; p=none; rua=mailto:dmarc-reports@balkanmotors.cz; ruf=mailto:dmarc-reports@balkanmotors.cz
```

| Parametr | Popis |
|----------|-------|
| `p=none` | Žádná akce (monitoring mode) — e-mail projde, ale reporty se posílají |
| `p=quarantine` | Podezřelé e-maily jdou do spamu (Gmail, Outlook se řídí) |
| `p=reject` | Odmítne e-mail úplně (SMTP 550 od mx serveru) |
| `rua=mailto:...` | Agregované reporty (každý den/týden) o SPF/DKIM selhání |
| `ruf=mailto:...` | Forensic reporty (jednotlivý selhavší e-mail) — citlivější |

**Doporučená fáze pro aplikaci:**

1. **Fáze 1 (týdny 1–2 migraci):** `p=none` — monitoruješ bez dopadu. Reporty vidíš v e-mailu.
2. **Fáze 2 (týdny 3–4):** `p=quarantine` — Gmail, Outlook se řídí, ale e-maily se nepředávají hromadně.
3. **Fáze 3 (týden 5+):** `p=reject` — plná ochrana, ale pokud je něco špatně, e-maily nebudou doručeny.

**Příklad postupu:**

```bash
# Fáze 1
TXT _dmarc.balkanmotors.cz: v=DMARC1; p=none; rua=mailto:dmarc-reports@balkanmotors.cz

# Fáze 2 (za 2 týdny)
TXT _dmarc.balkanmotors.cz: v=DMARC1; p=quarantine; rua=mailto:dmarc-reports@balkanmotors.cz

# Fáze 3 (za dalších 2 týdny)
TXT _dmarc.balkanmotors.cz: v=DMARC1; p=reject; rua=mailto:dmarc-reports@balkanmotors.cz
```

---

### Reverse DNS (PTR) — pro egress IP

Pokud máš vlastní IP (ne Mullvad SOCKS), nastav PTR záznam (ask hosting provider).

**Příklad:**
```
PTR 1.2.3.4: balkanmotors-outreach.example.com
```

**U Mullvadu:** PTR je na Mullvad straně (nemáš kontrolu). Nejde problém — DMARC + DKIM kompenzují.

---

## Možnosti e-mailového serveru

Volba serveru určuje, kde běží **inbound IMAP a outbound SMTP recepty.**

| Řešení | Měsíčně / mailbox | Setup čas | Maintenance | Best for |
|--------|------------------|-----------|-------------|----------|
| **Microsoft 365** | 150–300 Kč | 30 min (DNS) | Minimální (cloud) | Teams integrace, spolehlivost |
| **Google Workspace** | 250–500 Kč | 30 min (DNS) | Minimální (cloud) | Kolaborace, UI |
| **Mailcow (VPS)** | ~200 Kč VPS celkem | 4–6 hodin | 4–6 hod/měsíc (patche) | Full control, privacy |
| **Postfix (VPS)** | ~200 Kč VPS | 8+ hodin | 6–8 hod/měsíc | Minimální, CLI-first |

### Doporučení pro tvůj setup

**Preferovaná volba: Microsoft 365 nebo Google Workspace**

- Cloud (no maintenance overhead)
- Built-in IMAP (pro reply ingest do outreach-orchestrator)
- SPF/DKIM/DMARC správa built-in

**Pokud chceš plnou kontrolu: Mailcow**

- Open-source (Docker), full transparency
- Sama řídíš DKIM klíče, DMARC política
- SSD cost ~200 Kč/měsíc (Linode, Hetzner, DigitalOcean)

---

## Warmup tracker — AP1 fáze reprise

Nový mailbox (nebo nová doména) startuje ze **0 pověsti**. Gmail, Outlook a ostatní inbox providery limitují send rate dokud si nejsou jistí, že nejsi spammer.

**Sprint AP1 zavedl warmup lifecycle** v DB (`outreach_mailboxes.lifecycle_phase`). Použiješ stejné fáze pro own-domain migraci:

| Fáze | Den | Denní limit | Popis |
|------|-----|------------|-------|
| `warmup_d0` | 0–2 | 5 e-mailů/den | Minimální — test doručení |
| `warmup_d3` | 3–6 | 10 e-mailů/den | Posun nahoru, stále opatrný |
| `warmup_d7` | 7–13 | 25 e-mailů/den | Pokud bez bounce/spam, zvětšuj |
| `warmup_d14` | 14–29 | 50 e-mailů/den | Production-adjacent, ale stále opatrný |
| `production` | 30+ | 100 e-mailů/den | Plná kapacita |

**Implementace:**

1. Provisionuješ nový mailbox v `outreach_mailboxes`:
   ```sql
   INSERT INTO outreach_mailboxes 
   (email, password, imap_host, imap_port, lifecycle_phase, created_at)
   VALUES 
   ('outreach1@balkanmotors.cz', '...', 'smtp.microsoft.com', 587, 'warmup_d0', NOW());
   ```

2. Cron `advance_lifecycle_phase` (BFF `runLifecyclePhaseAdvanceCron`) automaticky postupuje den za dnem (3:00 AM Prague).

3. Operátor sleduje email metrics (bounce, spam complaint) přes `/operátor/metrics` dashboard. Pokud bounce > 2% v jakékoli fázi, zastaví postup.

**Doba ramp-up:** 30 dní. Při jakékoli emergency (domain suspend, abuse report), vrátíš `lifecycle_phase` na `warmup_d0` (SQL UPDATE) a začneš znovu.

---

## Compliance update checklist

### 1. Privacy Notice (`docs/legal/privacy-notice.md`)

**Aktuální text (§ 1, § 6):**
> Správcem osobních údajů je společnost **Garaaage s.r.o.**... sídlem Purkyňova 74/2, 110 00 Praha 1

**Co změnit:**

- § 1: Doplnit e-mail (pokud existuje) pro kontakt v ochrané údajů. Aktuálně: `privacy@garaaage.cz`. Pokud migruješ na @balkanmotors.cz, možnost: `privacy@balkanmotors.cz` (alias na Garaaage).

- § 6 (Komu předáváme): Zaměnit "Seznam.cz (e-mailový provider)" za "Microsoft 365 / Google Workspace / Mailcow (e-mailový provider)" dle volby.

- Verze: bump z 1.2 → 1.3. Doplnit do change log: "§ 6 — e-mailový provider změna z Seznam.cz na [provider]; § 1 — identifikace kontroléra aktualizována (doména @balkanmotors.cz)."

### 2. LIA (`docs/legal/lia-direct-marketing.md`)

**Aktuální text (§ 3.5 per-channel balancing):**
> E-mail (Seznam.cz SMTP relay) | ✅ Schválen | ANO | Plný footer...

**Co změnit:**

- § 3.5 tabulka: Zaměnit "Seznam.cz SMTP relay" za "Microsoft 365 / ... SMTP relay" + "Sender doména: @balkanmotors.cz" (nebo @garaaage.cz).
- Bez dalších změn v § 1–3 (purpose, necessity, balancing stay stejné; jen e-mailový transport se mění).
- Verze: bump z 1.2 → 1.3. Change log: "§ 3.5 — e-mailový provider a sender doména aktualizován (Sprint N1)."

### 3. Art. 30 Register (`docs/legal/art30-register.md`)

**Aktuální text (Činnost zpracování č. 1):**
> Příjemci | Anti-trace-relay, Railway.app, **Seznam.cz** (e-mail provider)

**Co změnit:**

- Činnost č. 1 tabulka, řádek "Příjemci": Zaměnit "Seznam.cz" za "Microsoft 365 / Google Workspace / Mailcow" (dle volby).
- DPA status (tabulka "Subprocessory"): Zkontroluj, zda má nový provider dostupný DPA či Standard Contractual Clauses (SCC).
  - Microsoft 365: ano (DPA zahrnuta v TOS)
  - Google Workspace: ano (DPA zahrnuta v TOS)
  - Mailcow (self-hosted): ne (tvoje infrastruka, bez DPA)
- Verze: bump z 1.2 → 1.3. Change log: "Činnost č. 1 — e-mailový provider aktualizován; Subprocessory tabulka — DPA status [provider] ověřen (Sprint N1)."

### 4. Footer updates v `email_templates` tabulce

Každý e-mail musí obsahovat v patičce (dle GDPR čl. 13–14 info duty):

```
---
Garaaage s.r.o. | IČO: 23219700 | Sídlo: Purkyňova 74/2, 110 00 Praha 1
Právní základ: Čl. 6/1/f GDPR (oprávněný zájem)
Zdroj dat: Veřejný obchodní rejstřík (firmy.cz, ARES)
Dobu uchovávání: 12 měsíců
Práva: Unsubscribe [LINK] | Privacy Notice [URL]
```

**Co změnit:**

- Pokud máš současný footer s "Seznam.cz" (ne, footer je generic Garaaage), žádná změna potřeba.
- Pokud se chceš přeorientovat "Z @seznam.cz na @balkanmotors.cz" v samotném subject/preview (pro branding), update to v `email_templates`:
  ```
  -- Opravy: V preview (pokud existuje) změň "Seznam.cz" na "Garaaage" nebo odsouvisej konkrétní mailbox branding
  ```
- Pokud je kód generující From: header, doplnit parametr: `from_domain: 'balkanmotors.cz'` místo hardcoded seznam.cz.

### 5. Recovery plan — revert na Seznam-only

Pokud se migrace na own-domain selže (reputace drop, abuse report, operator změní názor), musíš:

1. **Pause kampáně** přes operátor dashboard (zastavit send na @balkanmotors.cz).
2. **Revert privacy/LIA/art30 docs** na verzi 1.2 (git revert commit, který změnil § 6 / § 3.5).
3. **Switch inbound back** na seznam.cz mailboxy (IMAP polling v outreach-orchestrator).
4. **SQL update** mailboxes: `UPDATE outreach_mailboxes SET disabled=true WHERE email LIKE '%balkanmotors.cz%'`.
5. **Notify compliance:** e-mail na privacy@garaaage.cz: "Migrace own-domain reverted. Reporty z Fáze 1 DMARC dostupné [link]."

Čas recovery: 30 minut (operátor action) + 1 den (DNS propagace, pokud měníš MX zpět).

---

## Cost estimate + time-to-warm

### Počáteční setup

| Činnost | Čas | Náklady |
|---------|-----|--------|
| DNS selektor DKIM (generuj + zaregistruj) | 30 min | 0 Kč |
| SPF záznam | 15 min | 0 Kč |
| DMARC záznam (fáze 1: p=none) | 15 min | 0 Kč |
| E-mailový server setup (M365 / GW) | 2–4 h | 150–300 Kč/měs |
| Nebo Mailcow (self-hosted) | 4–6 h | 200 Kč/měs (VPS) |
| Privacy/LIA/Art.30 docs update | 2 h | 0 Kč (interní) |
| Footer templates update (pokud potřeba) | 1 h | 0 Kč |
| **Celkem setup** | **5–10 h** | **150–300 Kč/měs** |

### Průběžné náklady

| Položka | Měsíc |
|---------|-------|
| E-mail server (M365/GW) | 150–300 Kč/mailbox |
| E-mail server (Mailcow VPS) | ~200 Kč (sdílený VPS) |
| Domain registrace | ~200–500 Kč/rok (amortizováno: 17–42 Kč/měs) |
| **Měsíční total** | **170–342 Kč** |

### Warmup timeline (wall-clock)

| Etapa | Trvání | Poznámka |
|-------|--------|----------|
| DNS propagace (SPF/DKIM/DMARC) | 24–48 h | Raz registr; timeout až 48h v některých ISP |
| Fáze 1 (p=none monitoring) | 2 týdny | Shromažďuješ DMARC reporty; kontroluješ bounce |
| Fáze 2 (p=quarantine) | 2 týdny | Operátor monitoruje metrics; upravuje send volume |
| Fáze 3 (p=reject) | 1 týden | Finální produkce; probíhá parallely s Fází 2 |
| **Celkem ramp** | **~6 týdnů** | Počítáno od push DNS záznamů |

---

## Rollback plán

Pokud se během migrace něco pokazí:

### Scénář 1: Nízký inbox placement (> 10% spam rate)

**Příčina:** Gmail / Outlook si nedůvěřují novému senderu.

**Řešení:**
1. Check DMARC reporty z `dmarc-reports@` — vidíš SPF/DKIM failure rate.
2. Pokud selhání SPF > 5%, zkontroluj SPF záznam (máš-li include direktivu, ověř že provider ji emituje).
3. Pokud selhání DKIM > 5%, regeneruj DKIM klíč a zaregistruj nový selektor (outreach2).
4. Pokud sender reputation je na vine: počkej další 2 týdny v Fázi 1, pak retry Fáze 2.
5. **Poslední resort:** vrať se na seznam.cz mailboxy (viz Recovery plan výše).

### Scénář 2: DKIM key compromise

Postup: vygeneruj nový DKIM klíč, zaregistruj jako `outreach2._domainkey.balkanmotors.cz`, update send path na server, počkej 30 dní, pak smaž starý `outreach1._domainkey.balkanmotors.cz`.

### Scénář 3: Abuse report / domain suspension

Pokud je doména suspendovaná e-mailovým serverem (Gmail blocklist, ISP AUP violation):

1. **Okamžitě:** pause send, notify compliance team.
2. **Investigace:** kontaktuj e-mailový server (M365 / GW) a ptej se na důvod.
3. **Remediate:** typicky spam complaint feedback loop — zkontroluj, zda reply handler respektuje STOP replies.
4. Pokud problém přetrvává: vrátí se na seznam.cz (který má vyšší reputaci pro tento typ outreach).

---

## Shrnutí rozhodovacích bodů

| Bod | Volba | Dopad |
|-----|-------|-------|
| **Doména** | @balkanmotors.cz (doporučeno) | Brand alignment, zero extra cost |
| **E-mail server** | Microsoft 365 (doporučeno) | Cloud, 150 Kč/měs, easy setup |
| **DKIM key** | 2048 bit | Standard, 30 dní validity |
| **DMARC fáze** | p=none → p=quarantine → p=reject | Monitoring-first přístup, safety |
| **Warmup** | 30 dní (AP1 lifecycle) | Dostatečný pro B2B outreach |
| **Docs update** | Privacy v1.3, LIA v1.3, Art30 v1.3 | Compliance refresh |

**Příští sprint N2:** implementace e-mailového serveru + DNS setup.  
**Sprint N3:** reputation tracking dashboard + operator automation.  
**Sprint N4:** full migration (seznam-only → balkanmotors-primary).

---

**Verze 1.0 — Schváleno 2026-05-12**

Reference:
- `feedback_send_via_seznam_only.md` (T1) — demotace z T0, S N init decision gate
- `project_seznam_proxy_geo_mismatch.md` (T1) — Mullvad egress constraints
- Sprint AP1: lifecycle_phase implementation + warmup_cap trigger
- LinkedIn: GDPR čl. 6/1/f legitimate interest (B2B sender reputation standard)
