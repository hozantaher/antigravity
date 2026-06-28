# Zásady ochrany osobních údajů — Garaaage

> **Last updated**: 2026-04-25
> **Operator-supplied fields**: `[OP]`
> **Deploy target**: https://garaaage.cz/privacy (markdown lze hostovat přes GitHub Pages, Netlify, nebo statický pluging na Railway)

## 1. Správce osobních údajů

Garaaage s.r.o.
IČO: `[OP — doplnit]`
Sídlo: `[OP — doplnit]`
Kontaktní email: `[OP — doplnit]`

Garaaage s.r.o. (dále jen "**Správce**") zpracovává osobní údaje v souladu s nařízením (EU) 2016/679 (**GDPR**) a zákonem č. 110/2019 Sb., o zpracování osobních údajů.

## 2. Kategorie zpracovávaných osobních údajů

V rámci provozu portálu Garaaage a oslovování potenciálních prodejců použité techniky zpracováváme:

- **Email**: kontaktní adresa (zdroj: veřejný registr firmy.cz / ARES)
- **Křestní jméno**: pokud je publikováno v registru
- **Region**: administrativní kraj
- **Název firmy + IČO**: údaje organizační, nikoli osobní

Nezpracováváme zvláštní kategorie osobních údajů (čl. 9 GDPR — zdravotní stav, biometrika, atd.) ani údaje o trestních záznamech.

## 3. Účel a právní základ zpracování

| Účel | Právní základ | Doba zpracování |
|---|---|---|
| Oslovení potenciálních prodejců s nabídkou výkupu použité techniky (Garaaage) | **Oprávněný zájem** dle čl. 6(1)(f) GDPR (přímý marketing — Recital 47) | 24 měsíců od posledního kontaktu |
| Vedení záznamů o námitkách a odhláškách | Plnění právní povinnosti (čl. 6(1)(c) — čl. 21 GDPR) | Trvale |
| Provozní logy, bezpečnost, audit | Oprávněný zájem (čl. 6(1)(f) — bezpečnost provozu) | 12-36 měsíců |
| Vyřízení požadavků dle GDPR | Plnění právní povinnosti (čl. 6(1)(c)) | 3 roky od vyřízení |

**Vyhodnocení oprávněného zájmu**: Správce provedl test proporcionality (LIA-001) a posoudil dopad na práva subjektů údajů jako přiměřený s ohledem na:
- Veřejnou dostupnost zdrojových údajů z obchodního registru
- B2B kontext oslovení (nikoli soukromý)
- Snadný opt-out v každé zprávě
- Nezpracovávání zvláštních kategorií dat
- Nepoužívání profilování ani automatizovaného rozhodování

## 4. Zdroje osobních údajů

Údaje získáváme výhradně z následujících veřejně dostupných zdrojů:

- **firmy.cz** (https://www.firmy.cz) — veřejný obchodní katalog
- **ARES** (https://ares.gov.cz) — Administrativní registr ekonomických subjektů, MFČR

Údaje nezískáváme nákupem databází, scrapingem sociálních sítí, ani jiným způsobem v rozporu s podmínkami zdroje.

## 5. Příjemci osobních údajů

Vaše osobní údaje **nepředáváme třetím stranám pro marketingové účely**. Sdílíme je pouze s následujícími zpracovateli pro provoz služby:

| Příjemce | Účel | Smluvní vztah |
|---|---|---|
| Railway Inc. | Hosting databáze | DPA via Railway TOS |
| Anti-trace-relay (interní) | Doručování emailů + SOCKS5 transport | Vlastní infrastruktura |
| Proxy providers | IP rotace pro doručitelnost | DPA s providery |
| Seznam.cz | Odchozí SMTP server | Standardní SMTP TLS |

## 6. Mezinárodní předávání

Některé infrastrukturní služby (Railway hosting) mohou data zpracovávat v zemích mimo EU/EEA. V takovém případě je předání zajištěno **standardními smluvními doložkami (SCC)** schválenými Evropskou komisí.

`[OP — pokud Railway region = EU, doplnit "Aktuálně všechna data zpracováváme v EU."]`

## 7. Doba uchování

| Údaj | Doba |
|---|---|
| Kontaktní email + související záznamy | 24 měsíců od posledního kontaktu |
| Záznamy o odhláškách (suppression list) | **Trvale** (důkaz o respektování čl. 21) |
| Záznamy o doručených odpovědech | 36 měsíců |
| Tracking události (otevření, kliknutí) | 12 měsíců |
| Audit logy | 36 měsíců |

Po uplynutí doby uchování jsou údaje automaticky mazány retenčním procesem.

## 8. Vaše práva

V souladu s GDPR máte následující práva:

- **Právo na přístup** (čl. 15) — zjistit, jaké údaje o Vás zpracováváme
- **Právo na opravu** (čl. 16) — opravit nepřesné údaje
- **Právo na výmaz** (čl. 17) — "právo být zapomenut"
- **Právo na omezení zpracování** (čl. 18)
- **Právo na přenositelnost** (čl. 20)
- **Právo vznést námitku** (čl. 21) — proti zpracování pro přímý marketing
- **Právo nebýt předmětem automatizovaného rozhodování** (čl. 22) — nezpracováváme automaticky

### Jak práva uplatnit

- **Email**: `[OP — doplnit]`
- **Odhlášení z mailingu**: kliknutí na odkaz v každé zprávě nebo odpověď slovem "STOP"

Žádost vyřídíme do **1 měsíce** (čl. 12 GDPR). V odůvodněných případech můžeme prodloužit o další 2 měsíce, o čemž Vás budeme informovat.

## 9. Stížnosti

Pokud se domníváte, že Vaše osobní údaje zpracováváme v rozporu s předpisy, máte právo podat stížnost u dozorového úřadu:

**Úřad pro ochranu osobních údajů (ÚOOÚ)**
Pplk. Sochora 27, 170 00 Praha 7
https://www.uoou.cz

## 10. Cookies a tracking

`[OP — pokud portál Garaaage používá cookies, doplnit cookie policy. Aktuálně email send pipeline tracking pixel NEAKTIVNÍ pro první zprávu.]`

## 11. Změny zásad

Tyto zásady mohou být aktualizovány. Aktuální verze je vždy k dispozici na https://garaaage.cz/privacy. Materiální změny budou oznámeny minimálně 30 dní předem.

## 12. AI a automatizované zpracování

V současné době **nepoužíváme AI systémy** (ve smyslu Nařízení (EU) 2024/1689 — AI Act, čl. 3(1)) pro zpracování Vašich osobních údajů. Klasifikace odpovědí je založena na jednoduchém pravidlovém algoritmu (regex), nikoli strojovém učení.

Pokud by se to v budoucnu změnilo, doplníme zde transparentní informaci v souladu s čl. 50 AI Act.

---

**Verze**: 1.0
**Účinnost**: 2026-04-25
