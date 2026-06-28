# Zásady zpracování osobních údajů

**Garaaage s.r.o.**
Purkyňova 74/2, Nové Město, 110 00 Praha 1
IČO: 23219700

Datum účinnosti: 2026-05-06
Verze: 1.2

> **Změny ve verzi 1.2 (2026-05-06):** Sjednocen termín na "výkup techniky" (byl "odkup stavební techniky"). Rozšířen scope účelu na veškerou stavební, dopravní, manipulační, zemědělskou a užitkovou techniku (NACE 41–43, 45, 46, 49, 77, 01) — v souladu s reálným obsahem kampaně a aktualizovanou LIA.
>
> **Změny ve verzi 1.1 (2026-04-30):** Doplněna informace o interním zpracování fotografií techniky lokálním AI modelem (§ 4 a § 9). Aktualizován rozsah práva na výmaz (§ 7) o tři nové audit tabulky.

---

## 1. Kdo zpracovává Vaše údaje

Správcem osobních údajů je společnost **Garaaage s.r.o.**, se sídlem Purkyňova 74/2, Nové Město, 110 00 Praha 1, IČO 23219700, zapsaná v obchodním rejstříku vedeném Městským soudem v Praze.

Kontakt ve věcech ochrany údajů: privacy@garaaage.cz

## 2. Jaké údaje zpracováváme

Pro účely B2B obchodního styku zpracováváme tyto kategorie veřejně dostupných údajů:
- e-mailová adresa firmy
- jméno a příjmení kontaktní osoby (pokud uvedeno)
- název firmy, IČO, sídlo, region
- klasifikace činnosti (NACE)

Pokud nám v rámci komunikace dobrovolně zašlete **fotografii použité stavební techniky** (např. v příloze odpovědi na náš e-mail), zpracováváme rovněž:
- binární data fotografie
- strukturované atributy techniky vytěžené z fotografie (značka, model, rok výroby, stav)

Podrobnosti k tomuto zpracování viz § 9 níže.

## 3. Z jakého zdroje údaje pocházejí

Údaje pocházejí z **veřejného obchodního rejstříku firmy.cz** (a souvisejících veřejných zdrojů — ARES, justice.cz). Jedná se o údaje, které byly zveřejněny pro účely podnikání.

## 4. Účel a právní základ zpracování

**Účel:** přímý B2B marketing — nabídka výkupu použité techniky pro vývoz do zahraničí (automobil, dodávka, kamion, bagr, nakladač, traktor, jeřáb, vysokozdvižný vozík a obdobná technika).

**Právní základ:** oprávněný zájem správce dle čl. 6 odst. 1 písm. f) GDPR ve spojení s recitálem 47 GDPR (přímý marketing pro firmy z veřejného obchodního rejstříku).

Před zpracováním jsme provedli **balancing test** (test poměřování oprávněného zájmu vs. práv subjektu) — viz interní dokument `docs/legal/lia-direct-marketing.md`.

## 5. Jak dlouho údaje uchováváme

- Aktivní kontakt: **12 měsíců** od posledního obchodního styku.
- Po námitce / odhlášení: trvale jen e-mailová adresa v suppression listu (pro zajištění, že Vás již nikdy nekontaktujeme).
- Po 12 měsících bez interakce: údaje jsou automaticky smazány.

## 6. Komu údaje předáváme

- **Anti-trace-relay (subprocessor)** — zajištění bezpečné e-mailové infrastruktury
- **Railway.app (hosting)** — provozování aplikační infrastruktury
- **Seznam.cz (e-mailový provider)** — odesílání zpráv

Žádné údaje neprodáváme třetím stranám.

Údaje neopouštějí Evropský hospodářský prostor (EHP).

## 7. Vaše práva (GDPR čl. 15-22)

Máte tato práva, která můžete kdykoli uplatnit:

| Právo | Jak uplatnit |
|---|---|
| **Přístup** k údajům (čl. 15) | privacy@garaaage.cz |
| **Oprava** údajů (čl. 16) | privacy@garaaage.cz |
| **Výmaz** ("zapomenutí", čl. 17) | privacy@garaaage.cz nebo unsubscribe link v každém e-mailu |
| **Omezení zpracování** (čl. 18) | privacy@garaaage.cz |
| **Přenositelnost** (čl. 20) | privacy@garaaage.cz |
| **Námitka proti přímému marketingu** (čl. 21) | unsubscribe link — instantní |
| **Stížnost u dozorového úřadu** (čl. 77) | Úřad pro ochranu osobních údajů, Pplk. Sochora 27, 170 00 Praha 7, www.uoou.cz |

Námitku proti přímému marketingu respektujeme **okamžitě a bezpodmínečně** — kliknutím na unsubscribe link v jakémkoli našem e-mailu.

### 7.1 Rozsah práva na výmaz (čl. 17)

Při uplatnění práva na výmaz odstraníme nebo anonymizujeme Vaše údaje z následujících interních evidencí:

| Tabulka | Akce | Poznámka |
|---|---|---|
| `contacts`, `outreach_contacts` | DELETE | Identifikace subjektu |
| `send_events`, `reply_inbox`, `tracking_events` | DELETE | Komunikační historie + tracking |
| `outreach_threads` | UPDATE → status `closed` | Historie komunikace zachována dle § 7(4) zák. 480/2004 (důkaz respektování opt-outu) |
| `channel_audit_log` | DELETE | Per-channel breadcrumbs |
| `ai_suggestion_audit` | UPDATE → anonymizace (`thread_id=NULL`, `operator_id='erased'`) | Text návrhu zůstává jako interní accountability dle čl. 5/2 GDPR; vazba na subjekt odstraněna |
| `suppression_list`, `outreach_suppressions` | INSERT (zachováno) | Důkaz, že jsme opt-out respektovali (povinné dle § 7(4) zák. 480/2004 + čl. 30 GDPR) |

Záznam o samotném výmazu (kdo, kdy) zachováváme v `operator_audit_log` po dobu 5 let — vyplývá z povinnosti accountability dle čl. 5/2 + čl. 30 GDPR.

## 8. Bezpečnost

- Šifrovaná komunikace (TLS 1.3) mezi všemi systémy
- Šifrování citlivých údajů v databázi (AES-256-GCM)
- Pravidelná rotace přístupových tokenů
- Audit log všech operací nad osobními údaji
- Bezpečnostní monitoring (Sentry)

## 9. Automatizované zpracování a profilování

Zpracování zahrnuje **klasifikaci dle oboru činnosti (NACE) a sektoru** pro určení relevance nabídky. Tato automatizovaná klasifikace nemá pro Vás právní účinky a nedotýká se Vás významně. Klasifikace je zveřejněna ve veřejném registru jako NACE kód.

K přípravě jednotlivých zpráv může být použit **AI asistent** (jazykový model), který generuje text na základě veřejně dostupných údajů o Vaší firmě. Vaše odpovědi vždy zpracovává **lidský operátor** našeho týmu.

### 9.1 Interní zpracování fotografií (lokální AI model)

Pokud nám v rámci komunikace zašlete fotografii použité stavební techniky, zpracováváme ji následovně:

- Fotografie je analyzována **lokálně běžícím AI modelem** (Ollama llama3.2-vision) na infrastruktuře správce. **Nikdy není odesílána žádné třetí straně** ani mimo Evropský hospodářský prostor.
- Cílem analýzy je vytěžení strukturovaných atributů techniky (značka, model, rok výroby, stav) pro přípravu inzerátu na portálu.
- **Princip minimalizace údajů (čl. 5/1/c GDPR):** model může v záběru rozpoznat i nesouvisející osobní údaje (např. obličej kolemjdoucího, registrační značku vozidla v pozadí). Tyto údaje jsou **odděleny do kategorie `discarded`** a nestávají se součástí inzerátu ani uložených atributů. Eviduje se pouze fakt, že byly při parsování detekovány a vyřazeny.
- Audit záznam o každém parsování (`photo_parse_audit`) uchováváme po dobu 12 měsíců.
- Tato automatizovaná analýza nemá pro Vás právní účinky a nepředstavuje rozhodnutí podle čl. 22 GDPR — slouží výhradně k přípravě nabídky, kterou poté reviewuje a schvaluje lidský operátor.

Právním základem pro toto zpracování je oprávněný zájem dle čl. 6/1/f GDPR — viz interní balancing test v `docs/legal/lia-direct-marketing.md` § 3.6.

## 10. Změny

Tento dokument se může změnit. Aktuální verze je vždy dostupná na URL uvedené v patičce našich e-mailů.

---

**Verze 1.2 — účinnost od 2026-05-06**

| Verze | Datum | Změny |
|---|---|---|
| 1.0 | 2026-04-27 | Initial publication |
| 1.1 | 2026-04-30 | + § 2 fotografie jako další kategorie údajů<br>+ § 7.1 explicitní rozsah práva na výmaz (audit tabulky)<br>+ § 9.1 interní zpracování fotografií lokálním AI |
| 1.2 | 2026-05-06 | § 4 — sjednocen termín na "výkup techniky", rozšířen scope na NACE 41–43 + 45 + 46 + 49 + 77 + 01 |
