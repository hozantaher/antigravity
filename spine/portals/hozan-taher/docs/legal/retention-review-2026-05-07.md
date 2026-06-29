# Retention Period Disclosure — Přezkum defensibility

**Status:** Open
**Datum:** 2026-05-07
**Trigger:** Sprint H5.4 / J2 — post-launch hardening. Posouzení, zda tiered notice v cold email patičce bez inline retention periody je právně udržitelná pozice.

---

## 1. Současný stav

### Co patička obsahuje

Šablona `modules/outreach/configs/templates/intro_machinery.tmpl` (stav po PR #960 + #995) zahrnuje v patičce tyto prvky:

- Identifikace správce: Garaaage s.r.o., IČO 23219700, sídlo
- Právní základ: čl. 6(1)(f) GDPR + Recital 47
- Zdroj kontaktu: "veřejně dostupný katalog firem"
- Odkaz na plnou Privacy Notice: prostřednictvím reply mechanismu ("stačí odepsat na tento e-mail")
- Právo na námitku / opt-out: kliknutelný unsubscribe link ({{.UnsubURL}})
- Obchodní sdělení dle zák. č. 480/2004 Sb.: ano

### Co patička neobsahuje

- **Doba uchování** (12 měsíců od posledního kontaktu)
- Enumerace individuálních práv (přístup, výmaz, oprava, přenositelnost)
- Kontakt na ÚOOÚ jako dohledový orgán

### Stav Privacy Notice

`docs/legal/privacy-notice.md` verze 1.2 (2026-05-06) obsahuje retention period explicitně v § 5:

> "Aktivní kontakt: **12 měsíců** od posledního obchodního styku."

Privacy Notice je dostupná na žádost prostřednictvím reply mechanismu. Odkaz na URL v patičce je implicitní ("stačí odepsat").

### Reply mechanism

Příjemce je vyzván odepsat na email pro podrobnosti o zpracování. Operátor monitoruje inbox. Tato podmínka je funkční — nutno udržet.

---

## 2. GDPR Art. 14 — co zákon vyžaduje

Článek 14 GDPR (informace u nepřímého sběru dat — data not obtained from data subject) stanoví:

### Art. 14(1) — povinné informace vždy

- totožnost a kontaktní údaje správce ✓
- účely a právní základ ✓
- oprávněné zájmy, pokud je právním základem čl. 6(1)(f) ✓
- případní příjemci údajů — v Privacy Notice ✓
- přenos do třetích zemí — n/a (zpracování v EHP) ✓

### Art. 14(2) — dodatečné informace (pokud je to nezbytné pro zajištění řádného zpracování)

- **(a) Doba uchování** nebo kritéria pro její určení — v patičce CHYBÍ
- **(b) Práva subjektu** (přístup, výmaz, omezení, přenositelnost, námitka) — v patičce jen opt-out, plná enumerace chybí
- **(d) Právo odvolat souhlas** — n/a (právní základ je oprávněný zájem, ne souhlas)
- **(e) Právo podat stížnost u ÚOOÚ** — v patičce CHYBÍ
- **(f) Zdroj osobních údajů** — zdroj uveden ✓

### Art. 14(3) — načasování

Informace musí být sděleny:

> "do přiměřené doby po získání osobních údajů, nejdéle však do jednoho měsíce, přičemž se přihlíží k specifickým okolnostem, **nebo nejpozději v okamžiku první komunikace** s dotčenou osobou, je-li osobních údajů využíváno ke komunikaci s touto osobou."

Protože komunikujeme s příjemci emailem, aplikuje se varianta "při první komunikaci". Informace tedy musí být v prvním emailu — nebo dostupné na žádost z téhož emailu.

### Art. 14(5)(b) — výjimka

Povinnosti dle Art. 14 se neuplatní, pokud:

> "poskytnutí takových informací **není možné nebo by vyžadovalo nepřiměřené úsilí**."

Tato výjimka se u strukturovaného B2B emailingu **neaplikuje** — individuální příjemci jsou adresováni a informace je technicky snadno doručitelná.

---

## 3. Tiered notice — přijatelnost dle EDPB

Pracovní skupina pro ochranu osobních údajů (WP29, nyní EDPB) v **Guidelines on Transparency under Regulation 2016/679** (WP260, finalizováno EDPB 2018, reafirmováno 2020) explicitně povoluje vrstvený přístup ke zpřístupnění informací:

> "A layered approach to privacy information provides an initial short notice with the most important information **supplemented** by additional layers of information."

Podmínky akceptovatelnosti tiered notice:

1. Přijatelný rozsah první vrstvy — musí obsahovat nejdůležitější prvky, ne jen odkaz na "více info"
2. Reply/link mechanism musí být funkční a vést k úplné informaci
3. Celý informační balíček (vrstva 1 + vrstva 2) musí dohromady splnit Art. 14(1)+(2)

**Pozice naší patičky:** vrstva 1 obsahuje správce, právní základ, zdroj, opt-out. Vrstva 2 (Privacy Notice) obsahuje retention, práva, ÚOOÚ. Mechanism přístupu k vrstvě 2 je reply email.

Slabina: Art. 14(3) říká "v okamžiku první komunikace" — to interpretuje EDPB jako "v rámci sdělení při první komunikaci", nikoliv jako "k dispozici na žádost se zpožděním". Tento výklad nebyl k datu tohoto dokumentu předmětem veřejného ÚOOÚ rozhodnutí o B2B cold email v ČR.

---

## 4. Risk assessment

### Low risk

- Tiered notice s funkčním reply mechanismem, nízké frekvence (max 3 emaily / 12 měsíců per recipient), úzký NACE targeting
- B2B context, veřejný registrační zdroj — příjemci mají reduced privacy expectations oproti consumer kontextu (Recital 47)
- Privacy Notice plně soulad s Art. 14(1)+(2), dostupná okamžitě na žádost

### Medium risk

- Retention period ani ÚOOÚ kontakt nejsou v patičce inline — pokud ÚOOÚ dostane stížnost na cold email, tato absence může být citována jako formální porušení Art. 14(2)(a) a 14(2)(e)
- Výsledek ÚOOÚ šetření závisí na aktuálním enforcement přístupu, který se může měnit

### High risk (trigger events)

- Pokud reply mechanism přestane fungovat (auto-rejekce, unmonitored inbox, mailbox zaplněn): vrstva 2 se stane nedostupnou a celá tiered notice pozice se rozpadá
- Při přechodu na >500 emailů/den: ÚOOÚ pravděpodobně přikládá větší váhu objemu při rozhodování o prioritizaci šetření (bez citovatelného rozhodnutí — toto je provozní úsudek, nikoliv právní standard)

---

## 5. Decision matrix

| Trigger | Doporučená akce |
|---|---|
| Žádná stížnost ÚOOÚ + <500 emailů/den | Tiered notice jako dosud — monitoring reply inbox |
| Recipient odpoví s dotazem na dobu uchování | Odpovědět s inline retention (12 měsíců) danému příjemci, zaznamenat pattern |
| 3+ příjemci za měsíc se dotáží na retention | Signál: přidat inline retention do patičky preventivně |
| ÚOOÚ obdrží stížnost vztahující se k retention | Okamžitě přidat inline retention do patičky + synchronizovat Privacy Notice |
| Scale na >500 emailů/den | Přidat inline retention preventivně před překonáním tohoto prahu |
| Roční DPIA review (každý duben) | Přehodnotit dle aktuálního ÚOOÚ enforcement trendu a EDPB guidelines |
| Reply mechanism selže (bounce, unmonitored) | STOP campaigns → opravit → audit → restart |

---

## 6. Doporučená inline formulace (připravena k aktivaci)

Pokud bude rozhodnutí přidat retention inline, doporučená formulace přidaná na konec patičky:

```
Vaše údaje uchovávám 12 měsíců od posledního kontaktu nebo do okamžiku Vaší žádosti o výmaz.
```

Tradeoff: jedná se o jednu větu navíc (~65 znaků). Zmenšuje formální risk Art. 14(2)(a) na nulu. Snižuje "cold email feel" minimálně (faktická informace, nikoliv právní blok).

Alternativní varianta s ÚOOÚ (pokrývá Art. 14(2)(e)):

```
Vaše údaje uchovávám 12 měsíců od posledního kontaktu nebo do Vaší žádosti o výmaz. Stížnost můžete podat u ÚOOÚ (www.uoou.cz).
```

---

## 7. Doporučený postup

1. **Sprintový rámec (první launch do 100 kontaktů):** Tiered notice je udržitelná pozice. Žádná změna není nezbytná před prvním launchem.

2. **Po launchi — monitoring:** Sledovat reply inbox denně. Pokud přijde jakýkoli dotaz na dobu uchování nebo práva, zaznamenat jako signal event a re-evaluovat před druhým launchem.

3. **Před expanzí segmentu (>500 emailů/den):** Přidat inline retention (viz § 6) — preventivně před, ne až po překonání prahu.

4. **Při příštím ročním review (duben 2027):** Prověřit aktuální ÚOOÚ enforcement prioritizaci B2B cold email a aktualizovat tento dokument.

---

## 8. Citace a normativní zdroje

- GDPR — Nařízení Evropského parlamentu a Rady (EU) 2016/679, čl. 14(1), 14(2), 14(3), 14(5)(b)
- EDPB Guidelines on Transparency (WP260 rev.01, finalizované 2018): "layered approach" jako explicitně akceptovaný formát
- Recital 47 GDPR: přímý marketing jako příklad oprávněného zájmu
- Zákon č. 480/2004 Sb. § 7: povinné náležitosti obchodního sdělení (opt-out)
- GDPR čl. 77: právo podat stížnost u dozorového úřadu (ÚOOÚ pro ČR)

---

**Připravil:** Garaaage s.r.o.
**Datum:** 2026-05-07
**Příští přezkum:** 2027-04-27 (roční DPIA cycle) nebo při triggeru v decision matrix výše.
