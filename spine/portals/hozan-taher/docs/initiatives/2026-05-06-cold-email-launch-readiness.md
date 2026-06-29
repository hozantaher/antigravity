# Cold-mail launch readiness — campaign 457

**Status:** Open
**Datum:** 2026-05-06
**Trigger:** Email content hotový po 80+ iteracích na výkup-techniky pitch (saved `~/Desktop/garaaage-vykup-email.txt`). Zbývá template do DB, legal docs alignment a smoke test před skutečným launchem.

## Cíl

Posunout campaign 457 ze stavu "draft + ready content" do "running" během dnešního odpoledne nebo zítra ráno.

---

## Sprint A — Template DB update

Email obsah musí dorazit do `email_templates` DB tabulky pro campaign 457. Templates v repu jsou jen legacy seed (per HARD RULE memory `feedback_templates_in_db`), production runtime fetchuje z DB.

- **A1:** Zjistit který template ID kampaň 457 používá: `SELECT template_id FROM campaigns WHERE id=457;`
- **A2:** Update template přes dashboard `/templates` UI nebo SQL UPDATE — nahradit subject + body obsahem z `~/Desktop/garaaage-vykup-email.txt`
- **A3:** Sanity check fetched template: `SELECT subject, LEFT(body, 200) FROM email_templates WHERE id=...;`

## Sprint B — Legal docs alignment

Tři legal dokumenty nesou starý termín "aukční služba" / "odkup", patička emailu říká "výkup". Zároveň LIA dokument pokrývá jen NACE 41–43 (stavebnictví), zatímco email nabízí výkup techniky pro NACE 45 (autoopravárenství) + 46 (velkoobchod) + 49 (doprava) + 77 (pronájem strojů) + 01 (zemědělství). Pokud rozesíláme firmám mimo 41–43 a LIA neaktualizujeme, máme audit gap.

- **B1:** Sjednotit termín "výkup techniky" napříč `docs/legal/privacy-notice.md` + `docs/legal/lia-direct-marketing.md` + `docs/legal/art30-register.md`
- **B2:** Rozšířit LIA dokument § 1 a § 2 o širší NACE scope (41–43 + 45 + 46 + 49 + 77 + 01) — odůvodnit, že výkup pokrývá veškerou stavební, manipulační, dopravní, zemědělskou i užitkovou techniku
- **B3:** Update LIA § 3 (balancing test) — argumentovat, že rozšířený scope stále vyhovuje recipient expectation, protože všechny tyto firmy běžně mají vozový park a dostávají outreach od buyout dealerů
- **B4:** PR + admin merge

## Sprint C — Smoke test

Před skutečným ostrym sendem na 100 kontaktů test na 3-5 friendly příjemců. Verify celého stacku end-to-end na reálném provozu.

- **C1:** Vybrat 3-5 friendly emailů (gmail, seznam, něčí firemní) — operatorský úkon
- **C2:** Manuálně přidat jako test recipients pro campaign nebo poslat přes dashboard preview-send
- **C3:** Verify v inboxech: doručení do hlavní složky (ne spam), raw header obsahuje List-Unsubscribe, sender vypadá legitimně
- **C4:** Friendly recipient odpoví natural-language refusalem ("díky, nezájem") → verify že systém klasifikuje jako negative reply a INSERT do suppression list
- **C5:** Friendly recipient odpoví otázkou na privacy → verify že vidíš v inboxu a odpovíš do 24h
- **C6:** Pokud vše green → posun na Sprint D. Pokud spam folder placement → diagnostika (Seznam mailbox skóre, send rate, content trigger)

## Sprint D — Real Launch (operátorský úkon + monitoring)

Po pass všech předchozích sprintů. Operator klikne Aktivovat. Já monitoring po celý send window.

- **D1:** Hard-refresh dashboardu, otevřít `/launch-readiness?campaign_id=457&segment_id=7`, ověřit verdict=green
- **D2:** Klik "Aktivovat" na campaign 457 (status draft → running)
- **D3:** První hodina: cap 1/mailbox/day = 4 maily celkem, sleduji bounce rate, replies, mailbox health
- **D4:** Pokud 24h green → ramp 1→2→5→10 dle plánu z `docs/initiatives/2026-05-06-mvp-launch-day.md`

---

## Závislosti

- A → C → D je kritická cesta
- B je nezávislý ale měl by být done před D (audit risk)

## Co je MIMO scope této iniciativy

- DKIM/DMARC pro garaaage.cz — ne, posíláme přes Seznam (HARD RULE memory `feedback_send_via_seznam_only`)
- "stop" keyword fix v reply classifieru — drop, existující CZ classifier + LLM pokrývá natural-language refusals; smoke test odhalí gap pokud existuje
- Railway DPA — preexisting accepted debt (memory `project_accepted_debt`)

## Co se zachovalo z 80+ iterací emailu

- Pattern uložen do memory `feedback_cold_email_pattern.md` — recipe + 12 chyb + 7 principles
- Email content na `~/Desktop/garaaage-vykup-email.txt`
- Compliance footer template reusable pro budoucí kampaně
