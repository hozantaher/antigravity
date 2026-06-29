---
vektor-app:
  identita: "Evropská aukce vozidel, strojů a techniky na otevřených papírech a poctivé dražbě."
  smysl: "Jistota při rozhodnutí, které stojí statisíce — slepou důvěru nahrazuje průhledností a kůží ve hře."
  smer:
    - transparency
    - serious-community
    - fair-price
    - borderless
    - curated
  hlas: "profesionální, věcný, důvěryhodný — zkušený obchodník, ne marketér"
  hotovo-app: "každá veřejná feature podpírá ≥1 z 5 slibů (smer); jinak je kandidát na škrt"
---

# Příběh Auction24 — co aplikace vypráví směrem ven

> Tohle není spec ani roadmapa. Je to **severka**: příběh, který Auction24 vrhá na svět,
> a podle kterého se měří každá veřejná feature. Když nějaká obrazovka, tlačítko nebo text
> nepodpírá žádný z pěti slibů níže, ptáme se, proč existuje.
>
> Značka je **Auction24** (auction24.cz). Pracovní/infra názvy „garaaage*" (Firebase projekt,
> ESLint namespace) jsou interní plumbing — ven se nikdy nedostanou.

---

## Logline

**Auction24 je evropská aukce vozidel, strojů a techniky — místo, kde i nákup přes hranice a
bez prohlídky stojí na otevřených papírech a poctivé dražbě, ne na slepé důvěře.**

---

## Svět, který Auction24 řeší

Profesionální obchod s vozidly a stroji je vysoká hra. Nákupčí kupuje tahač, bagr, dodávku nebo
osobák — často přes hranici, bez prohlídky, za statisíce. A trh je neprůhledný: zatočené
motohodiny a tachometry, zatajené škody, nejasná historie, nespolehlivé protistrany. Přes hranici
přibude jazyk a nulová důvěra. Pro profíka není špatný nákup koníček, na kterém prodělá — je to
zásah do byznysu.

Auction24 tuhle hru obrací. **Slepou důvěru nahrazuje průhledností a kůží ve hře.** Každý stroj
přijde s otevřenými papíry. Do dražby se platí vratnou kaucí, takže proti vám stojí jen vážní
hráči. Cena se nehádá — poctivě ji najde dražba. A celé to mluví dvanácti jazyky, takže tahač
v Brně najde kupce v Kyjevě, Berlíně i Dubaji.

Výsledný pocit: **jistota při rozhodnutí, které stojí peníze.**

---

## Pět slibů (a feature, která je drží)

Příběh nestojí na marketingu — stojí na pěti slibech, a každý má v aplikaci fyzický důkaz.

### 1. Otevřené papíry

Každý stroj má papíry na stole: VIN dekódovaný do detailu (palivo, převodovka, výkon, objem,
historie), fotky ze všech úhlů včetně **360° prohlídky**, technické parametry vedle sebe.

> *„Vidíš všechno, co bys viděl při osobní prohlídce — a víc. Nic schovaného."*
> Drží: Vincario VIN dekodér · galerie + Pano 360° · technické parametry · porovnání vozů.

### 2. Vážní dražitelé

Vratná kauce (10 000 Kč / 500 €) odemyká přihazování. Žádní turisté, žádné plané příhozy.

> *„V dražbě jsou jen lidi, co to myslí vážně. Tvůj příhoz něco znamená — a soupeřův taky."*
> Drží: deposit gate (kauce ⇒ `isUserEligibleToBid`) · ověřené účty.

### 3. Poctivá dražba

Cenu netvoří prodejce ani algoritmus — tvoří ji trh, naživo a transparentně. Soft-close brání
ulovení v poslední vteřině.

> *„Nepřeplatíš, protože vedle tebe stojí trh. A neprodáš pod cenou, protože stojí i na tvé straně."*
> Drží: aukční mechanismus · soft-close · živý stav položky.

### 4. Bez hranic

Dvanáct jazyků, CZK i EUR, od Česka přes Balkán a Polsko po Ukrajinu, Rusko a arabský trh.
Stroj nezná hranice — kupec ani vývozce taky ne.

> *„Tvůj kupec nebo tvůj stroj je možná o tři země dál. Auction24 je most."*
> Drží: 12 locales · multi-currency · přeshraniční a exportní dosah.

### 5. Vybráno pro vás

Z tisíců strojů ti platforma podá ten tvůj — „Vybráno pro vás", podobné inzeráty, kurátorství
místo nekonečného scrollu.

> *„Neutopíš se v inzerátech. Auction24 tě zná a podá ti správný stroj."*
> Drží: doporučovací engine (detail rail · homepage rail · newsletter).

---

## Pro koho příběh je

**Profesionální a vážní kupci a prodejci napříč Evropou** — autobazary a dealeři, dopravci
a firmy s vozovým parkem, kupci a vývozci techniky, obchodníci. Ví, co chce. Chce to koupit bez
rizika, často přes hranice nebo na export. Nehledá nejlevnější bazar — hledá místo, kde se dá
věřit tomu, co vidí, a tomu, kdo stojí proti němu v dražbě.

---

## Co u nás člověk prožije (oblouk směrem ven)

1. **Otevře nabídku** — homepage není jen tabulka inzerátů, ale kurátorovaný vstup.
2. **Stroj má příběh** — detail otevře papíry: VIN, 360°, historie, parametry. Důvěra roste dřív než touha.
3. **Složí kauci** — z diváka se stává vážný dražitel. Kauce není poplatek, je to vstupenka.
4. **Draží** — napětí, ale viditelná, férová pravidla.
5. **Vyhraje** — stroj je jeho, klidně přes hranice, s jistotou.

---

## Hlas Auction24

Profesionální, věcný, důvěryhodný. Auction24 je aukční síň, které dá profík přednost — mluvíme
**jako zkušený obchodník, ne jako banka ani jako prodejce pod tlakem.** Přímo, znale, bez
korporátního chladu („Nemáte nárok přihazovat") i bez vykřičníkového marketingu. Sebevědomě,
protože nemáme co skrývat — důvěra se staví průhledností a výsledky, ne sliby.

---

## Jak příběh tvoří aplikaci směrem ven

Severka má důsledky. Co příběh **vyžaduje** od veřejných ploch:

- **Homepage** = kurátorovaný vstup s jasným „proč Auction24", ne rovnou grid inzerátů.
- **Detail stroje** = otevřené papíry. VIN, parametry a 360° mají vizuální přednost před cenou.
- **Kauce** = vstupenka do dražby, komunikovaná jako vážnost a důvěra — nikdy jako bariéra/poplatek.
- **Dražba** = naživo a férově; pravidla (soft-close) se vysvětlují, ne skrývají.
- **Jazyk a měna** = neviditelná samozřejmost + hodnota („prodáš i za hranice"), ne jen přepínač.
- **Doporučení** = „Auction24 tě zná" — relevantní, ne generický feed.

**Pravidlo:** každá veřejná feature je jedna věta tohoto příběhu. Když nepodpírá žádný
z pěti slibů, je to kandidát na škrt nebo přehodnocení.

---

## Data slouží příběhu

Měříme proto, abychom **dokázali, že příběh je pravdivý** — ne kvůli vanity číslům. Každý
slib má svůj důkaz v datech:

| Slib | Důkaz v datech |
|---|---|
| Otevřené papíry | % strojů s kompletním VIN + fotkami · kolik parametrů člověk projde před příhozem |
| Vážní dražitelé | konverze kauce · podíl příhozů krytých kaucí (z designu 100 %) |
| Poctivá dražba | počet přihazujících na položku · rozptyl cena→výsledek · prodloužení soft-close |
| Bez hranic | cross-border páry (země stroje ≠ země kupce) · pokrytí jazyků/měn |
| Vybráno pro vás | CTR doporučení · cesta z railu k příhozu |

Tahle tabulka je most k druhé půlce zadání: až budeme „vyhodnocovat data", měříme tyhle
sloupce — protože slouží příběhu, ne naopak.

---

## Předpoklady — POTVRZENO (2026-06-21)

Brand je **rozhodnutý: Auction24** (identita garaaage pryč). Tyto tři předpoklady byly **potvrzeny
(2026-06-21)** — `story.md` je tím **zamčená jako app-lore (severka)**:

1. **Záběr** = vozidla **i stroje/technika** (tahače, bagry, osobáky), ne jen osobní auta. ✅
2. **Publikum** = profíci + vážní kupci/vývozci jako **těžiště** (autobazary, dopravci, exportéři); běžný vážný kupec je vítán — kauce filtruje turisty bez ohledu na cílovku. ✅
3. **Hlas** = profesionální/věcný/důvěryhodný, ne nadšenecký („zkušený obchodník, ne banka ani prodejce pod tlakem"). ✅
