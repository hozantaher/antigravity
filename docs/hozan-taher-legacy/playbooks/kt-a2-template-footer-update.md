# KT-A2 — Doplnění IČO, sídla a Privacy URL do tří emailových šablon

> **Sprint:** KT-A2 (GH issue #296)
> **Status:** připraveno k execution. Operátor (Tomáš) aplikuje 3 diffy a commitne.
> **Doba:** 5–10 min
> **Předpoklad:** žádný (čistě textová úprava 3 souborů).

Tento playbook připravuje fixy patičky tří produkčních šablon kampaně výkupu. Patičky dnes obsahují placeholdery `{{IČO_PLACEHOLDER}}` a `{{SÍDLO_PLACEHOLDER}}` — než kampaň odejde, musí být reálné údaje + odkaz na publikovanou Privacy Notice + povinné GDPR informace dle Recital 47 + Art. 13/14.

---

## 1. Zdrojová data (autoritativní)

Tyto hodnoty jsou jediným zdrojem pravdy — pocházejí z [`docs/legal/privacy-notice.md`](../legal/privacy-notice.md) v.1.0 (účinnost 2026-04-27) a z root [`CLAUDE.md`](../../CLAUDE.md).

| Pole | Hodnota |
|---|---|
| Správce | `Garaaage s.r.o.` |
| IČO | `23219700` |
| Sídlo | `Purkyňova 74/2, Nové Město, 110 00 Praha 1` |
| Právní základ | čl. 6 odst. 1 písm. f) GDPR (oprávněný zájem) + Recital 47 |
| Zdroj dat | veřejný obchodní rejstřík firmy.cz (a souvisejících veřejných zdrojů — ARES, justice.cz) |
| Doba uchování | 12 měsíců od posledního obchodního styku; po námitce trvale jen e-mail v suppression listu |
| Privacy URL | `https://garaaage.cz/privacy` (fallback GitHub Pages, viz §4) |
| Kontakt pro DSR | `privacy@garaaage.cz` |

Tyto hodnoty MUSÍ odpovídat publikované Privacy Notice. Pokud se mění sídlo, zdroj dat nebo retention, **neaktualizuj jen šablony** — synchronizuj `docs/legal/privacy-notice.md`, `lia-direct-marketing.md` i ROPA dokument zároveň.

---

## 2. Soubory k úpravě (3)

| # | Soubor | Step v kampani |
|---|---|---|
| 1 | `features/outreach/campaigns/configs/templates/initial.tmpl` | první email |
| 2 | `features/outreach/campaigns/configs/templates/followup1.tmpl` | followup 1 |
| 3 | `features/outreach/campaigns/configs/templates/final.tmpl` | poslední email v sekvenci |

Všechny tři dnes sdílejí stejnou patičku (řádky 23–30 / 24–31 / 21–28). Diff je proto identický strukturou — liší se jen offsetem řádků.

---

## 3. Cílová podoba patičky (společná pro všechny 3 šablony)

Patička drží:

1. Identifikaci správce + IČO + sídlo (Art. 13/1/a)
2. Účel zpracování (B2B nabídka aukční služby)
3. Právní základ (legitimate interest, Art. 6/1/f + Recital 47)
4. Zdroj dat (firmy.cz + ARES — Art. 14/2/f)
5. Dobu uchování (Art. 13/2/a)
6. Funkční unsubscribe link (1-click HMAC token; existující {{.UnsubURL}})
7. Odkaz na publikovanou Privacy Notice (Art. 13/2/b — kde najít detail svých práv)

```
---
Obchodní sdělení odesílatele Garaaage s.r.o., IČO 23219700,
sídlem Purkyňova 74/2, 110 00 Praha 1. Kontakt jsme získali z veřejného
obchodního rejstříku firmy.cz (ARES) pro účel oslovení s nabídkou aukční
služby — oprávněný zájem dle čl. 6 odst. 1 písm. f) GDPR (Recital 47).
Doba uchování: 12 měsíců od posledního kontaktu, po námitce trvale jen
e-mail v suppression listu.

Pro odhlášení odpovězte STOP nebo klikněte: {{.UnsubURL}}
Vaše práva (přístup, výmaz, námitka): https://garaaage.cz/privacy
Kontakt pro GDPR: privacy@garaaage.cz
```

> **Pozor:** body šablony (humanize, subject line komentáře, oslovení, ofera) zůstávají beze změny — měníme **pouze patičku** od `---` dolů.

---

## 4. Privacy URL — předpoklad pro KT-A2 done-gate

Cílová URL `https://garaaage.cz/privacy` musí vrátit `200 OK` před prvním sendem (jinak link v patičce je dead a porušuje Art. 13/2/b). Operátor:

1. Pokud `garaaage.cz` má hosting → upload `docs/legal/privacy-notice.md` jako `/privacy` (statická HTML / markdown render)
2. Pokud `garaaage.cz` zatím není provozován → fallback GitHub Pages:
   - Repo `messingdev/garaaage-public` (vytvořit pokud chybí)
   - Push `privacy.md` jako kopie z `docs/legal/privacy-notice.md`
   - Pages enable → `https://messingdev.github.io/garaaage-public/privacy` jako fallback URL v patičce
3. Verify: `curl -sIo /dev/null -w '%{http_code}\n' https://garaaage.cz/privacy` → `200`

Pokud se použije fallback URL, **uprav v šabloně** — nesmí být dead-link.

---

## 5. Diff — `initial.tmpl`

```diff
--- a/features/outreach/campaigns/configs/templates/initial.tmpl
+++ b/features/outreach/campaigns/configs/templates/initial.tmpl
@@ -21,8 +21,11 @@ Diky,
 B. Maarek
 Garaaage

 ---
-Obchodní sdělení odesílatele Garaaage s.r.o., IČO {{IČO_PLACEHOLDER}},
-sídlem {{SÍDLO_PLACEHOLDER}}. Kontakt jsme získali z veřejného
-registru firmy.cz pro účel oslovení s nabídkou aukční služby
-(oprávněný zájem dle čl. 6(1)(f) GDPR).
+Obchodní sdělení odesílatele Garaaage s.r.o., IČO 23219700,
+sídlem Purkyňova 74/2, 110 00 Praha 1. Kontakt jsme získali z veřejného
+obchodního rejstříku firmy.cz (ARES) pro účel oslovení s nabídkou aukční
+služby — oprávněný zájem dle čl. 6 odst. 1 písm. f) GDPR (Recital 47).
+Doba uchování: 12 měsíců od posledního kontaktu, po námitce trvale jen
+e-mail v suppression listu.

 Pro odhlášení odpovězte STOP nebo klikněte: {{.UnsubURL}}
-Privacy policy: https://garaaage.cz/privacy
+Vaše práva (přístup, výmaz, námitka): https://garaaage.cz/privacy
+Kontakt pro GDPR: privacy@garaaage.cz
```

---

## 6. Diff — `followup1.tmpl`

```diff
--- a/features/outreach/campaigns/configs/templates/followup1.tmpl
+++ b/features/outreach/campaigns/configs/templates/followup1.tmpl
@@ -22,8 +22,11 @@ Diky,
 B. Maarek
 Garaaage

 ---
-Obchodní sdělení odesílatele Garaaage s.r.o., IČO {{IČO_PLACEHOLDER}},
-sídlem {{SÍDLO_PLACEHOLDER}}. Kontakt jsme získali z veřejného
-registru firmy.cz pro účel oslovení s nabídkou aukční služby
-(oprávněný zájem dle čl. 6(1)(f) GDPR).
+Obchodní sdělení odesílatele Garaaage s.r.o., IČO 23219700,
+sídlem Purkyňova 74/2, 110 00 Praha 1. Kontakt jsme získali z veřejného
+obchodního rejstříku firmy.cz (ARES) pro účel oslovení s nabídkou aukční
+služby — oprávněný zájem dle čl. 6 odst. 1 písm. f) GDPR (Recital 47).
+Doba uchování: 12 měsíců od posledního kontaktu, po námitce trvale jen
+e-mail v suppression listu.

 Pro odhlášení odpovězte STOP nebo klikněte: {{.UnsubURL}}
-Privacy policy: https://garaaage.cz/privacy
+Vaše práva (přístup, výmaz, námitka): https://garaaage.cz/privacy
+Kontakt pro GDPR: privacy@garaaage.cz
```

---

## 7. Diff — `final.tmpl`

```diff
--- a/features/outreach/campaigns/configs/templates/final.tmpl
+++ b/features/outreach/campaigns/configs/templates/final.tmpl
@@ -19,8 +19,11 @@ Dekuji za cas,
 B. Maarek
 Garaaage

 ---
-Obchodní sdělení odesílatele Garaaage s.r.o., IČO {{IČO_PLACEHOLDER}},
-sídlem {{SÍDLO_PLACEHOLDER}}. Kontakt jsme získali z veřejného
-registru firmy.cz pro účel oslovení s nabídkou aukční služby
-(oprávněný zájem dle čl. 6(1)(f) GDPR).
+Obchodní sdělení odesílatele Garaaage s.r.o., IČO 23219700,
+sídlem Purkyňova 74/2, 110 00 Praha 1. Kontakt jsme získali z veřejného
+obchodního rejstříku firmy.cz (ARES) pro účel oslovení s nabídkou aukční
+služby — oprávněný zájem dle čl. 6 odst. 1 písm. f) GDPR (Recital 47).
+Doba uchování: 12 měsíců od posledního kontaktu, po námitce trvale jen
+e-mail v suppression listu.

 Pro odhlášení odpovězte STOP nebo klikněte: {{.UnsubURL}}
-Privacy policy: https://garaaage.cz/privacy
+Vaše práva (přístup, výmaz, námitka): https://garaaage.cz/privacy
+Kontakt pro GDPR: privacy@garaaage.cz
```

---

## 8. Aplikace diffů (operátor)

Tři možnosti, vyber tu nejpohodlnější:

### A. Manuálně v editoru
Otevři každý ze 3 souborů, edituj patičku přesně podle §3.

### B. `git apply` z tohoto playbooku
1. Zkopíruj `diff` bloky (§5/§6/§7) do `/tmp/kt-a2-footer.patch`
2. `cd /Users/messingtomas/Documents/Projekty/hozan-taher`
3. `git checkout -b chore/kt-a2-footer-fill`
4. `git apply /tmp/kt-a2-footer.patch`
5. Verify: `git diff --stat` → 3 changed files, ~42 insertions, ~12 deletions
6. `git add features/outreach/campaigns/configs/templates/{initial,followup1,final}.tmpl`
7. `git commit -m 'chore(templates): KT-A2 fill IČO + sídlo + privacy URL in 3 footers'`
8. `git push -u origin chore/kt-a2-footer-fill`
9. `gh pr create --base main --title "chore(templates): KT-A2 footer compliance fill"`

### C. `sed` (rychlé in-place — rizikové, neauditovatelné)
**Nedoporučeno** — patička obsahuje vícero řádků a sed by mohl trefit kolizi v subject komentáři. Použij A nebo B.

---

## 9. Post-aplikace verifikace

1. **Žádný placeholder nezůstal:**
   ```bash
   grep -r 'PLACEHOLDER' features/outreach/campaigns/configs/templates/
   # očekávaný výstup: žádný hit
   ```

2. **Tmpl rendering nezahodil patičku** — preview přes BFF endpoint:
   ```bash
   curl -sS "http://localhost:3100/api/templates/preview?name=initial" \
     -H "x-api-key: $OUTREACH_API_KEY" | jq -r '.body' | tail -10
   # očekávaný: 7 řádků patičky bez {{IČO_PLACEHOLDER}}
   ```

3. **Privacy URL live:**
   ```bash
   curl -sIo /dev/null -w 'HTTP %{http_code}\n' https://garaaage.cz/privacy
   # očekávaný: HTTP 200 (nebo HTTP 200 na fallback URL pokud byl použit)
   ```

4. **Send-test do operátorské schránky** — eyeball patičky v real inboxu:
   ```bash
   curl -X POST "${BFF_URL}/api/mailboxes/631/send-test?force=1" \
     -H "x-api-key: $OUTREACH_API_KEY" \
     -d '{"to":"<tva_osobni_adresa>","subject":"KT-A2 footer check","template":"initial"}'
   ```

   Otevři přijatý email, ověř:
   - IČO 23219700 ✓
   - Sídlo Purkyňova 74/2 ✓
   - Recital 47 cite ✓
   - Retention 12 měsíců ✓
   - `{{.UnsubURL}}` se vyrenderoval na funkční URL ✓
   - Privacy link otevře 200 OK ✓
   - `privacy@garaaage.cz` dorazí jako kontakt pro GDPR ✓

5. **Audit log:**
   ```sql
   SELECT created_at, actor, details->>'reason'
   FROM operator_audit_log
   WHERE entity_type = 'template'
   ORDER BY created_at DESC LIMIT 5;
   ```

---

## 10. Done gate (uzavři issue #296)

Issue zavři teprve když:

- [ ] 3 šablony obsahují IČO 23219700 + sídlo Purkyňova 74/2 + privacy URL
- [ ] `grep PLACEHOLDER features/outreach/campaigns/configs/templates/` vrací prázdno
- [ ] `https://garaaage.cz/privacy` (nebo fallback) odpovídá HTTP 200
- [ ] Send-test dorazil do operátorské schránky a patička vypadá vizuálně OK
- [ ] PR mergnut na main

```
gh issue close 296 --comment "Templates compliant with Art. 13/14 + Recital 47.
Diffs applied per docs/playbooks/kt-a2-template-footer-update.md.
Privacy URL live: <verified URL>.
Send-test screenshot: <link or path>."
```

---

## 11. Reference

- [`docs/legal/privacy-notice.md`](../legal/privacy-notice.md) — autoritativní obsah Privacy Notice (v.1.0)
- [`docs/legal/lia-direct-marketing.md`](../legal/lia-direct-marketing.md) — Legitimate Interest Assessment (3-step test)
- [`CLAUDE.md`](../../CLAUDE.md) — controller identity (Garaaage s.r.o., IČO 23219700)
- [`features/outreach/campaigns/CLAUDE.md`](../../features/outreach/campaigns/CLAUDE.md) — template rendering pipeline
- [`features/outreach/campaigns/campaign/runner.go:806`](../../features/outreach/campaigns/campaign/runner.go) — `buildUnsubURL` HMAC token format (`{{.UnsubURL}}`)
- GH issue #296 — sprint definition
