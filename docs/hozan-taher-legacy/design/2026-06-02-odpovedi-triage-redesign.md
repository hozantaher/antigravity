# UX Redesign — Odpovědi (inbound reply triage)

> **Status:** Návrh k schválení (design-only, žádné code changes) · **Datum:** 2026-06-02
> **Surface:** `/v2/odpovedi` (`V2Odpovedi.jsx` + `v2-odpovedi.css`)
> **Trigger:** operátor — "komplexní, rozpadlé, nesmyslné … lépe vymyslet … jednodušší
> při zachování funkční komplexnosti" (#1586, Jednotka R1).
> **Companion:** `docs/initiatives/2026-06-02-ux-v2-cutover.md` (rozšiřuje R1 z "oprav
> čtecí panel" na "přepracuj celý triage povrch").
>
> NEIMPLEMENTOVÁNO autonomně — mění primární operátorský workflow + má otevřené
> otázky (§7). Čeká na schválení směru, pak se provede jako rozšířená R1 (1 PR,
> Playwright smoke + screenshot light/dark).

## 1. Diagnóza — proč dnešní povrch působí roztříštěně

Pravý panel je dnes **svislý stack sedmi nezávislých boxů** (toolbar, hlavička,
MinedSignals, SignatureCard, ClassificationControl, ChatThread, Composer), každý
s vlastním rámečkem. Důsledky:

- **Telefon — nejcennější signál — je pohřbený na 3. místě** v boxu, který splývá
  s podpisovým a klasifikačním boxem pod ním. U výkupu-po-telefonu má být číslo
  hrdina obrazovky; místo toho je to pilulka mezi patnácti.
- **Žádná hierarchie akce** — toolbar má 4 rovnocenná tlačítka; primární akce
  ("zavolej / odpověz") není odlišená. Operátor musí číst, ne reagovat.
- **Duplicita** — telefon na 2 místech (MinedSignals + SignatureCard), klasifikace
  na 3 (řádkový Tag + hlavičkový Tag + celý ClassificationControl box).
- **Levý sloupec má 5 filtrů + stat strip + klávesový hint + bulk bar** — hodně
  chrome nad seznamem; "Zájem"/"Nevyřízené"/"Vše" se překrývají.
- **Composer je ve scrollovací oblasti pod vláknem** — pro odpověď nutno scrollovat
  přes celou konverzaci (`focusComposer` to obchází hackem → příznak špatného místa).

Shrnutí: **seznam plochých boxů, ne triage nástroj**. Nic neříká "tohle udělej teď".

## 2. Návrhový princip

> **Jeden lead = jedno rozhodnutí = jedna obrazovka. Další krok je vždy zřejmý a
> telefon je hrdina.**

1. **Action rail** pinned pod hlavičkou — jedna primární akce: má-li reply telefon →
   velké **`📞 Zavolat +420…`** (`tel:` click-to-call); nemá-li → **Odpovědět**.
2. **Signály se slijí do jednoho "Fakta" řádku** (telefon povýšen pryč, do railu).
3. **Vzácné ovládání za disclosure** (klasifikační override, vozidlo).

## 3. Navržený layout

```
┌─ SEZNAM ─────────────────┐┌─ KONVERZACE ──────────────────────────────────┐
│ [Nevyřízené][📞Volat][Vše]││ Jan Novák — Bagr Komatsu PC210        ⌄ ★ ✓   │
│ ● Jan Novák         2 h   ││ Zájem · před 2 h · kampaň Výkup-Q2             │
│   Bagr Komatsu PC210      ││ ┌─ AKČNÍ PRUH ──────────────────────────────┐ │
│   Mám zájem prodat…       ││ │ ╔═══════════════════════╗   [↩ Odpovědět] │ │
│   📞 +420 603… 💰320k 🔥  ││ │ ║ 📞 ZAVOLAT +420 603…  ║   AI: Zájem 84%⌄│ │
│ ● Petr Svoboda      5 h   ││ │ ╚═══════════════════════╝                 │ │
│   Kolik nabízíte…? Dotaz  ││ └────────────────────────────────────────────┘ │
│   Marie D.          1 d   ││ ┌─ FAKTA (vytěženo + podpis) ───────────────┐ │
│   Děkuji, nemám… Odmítnutí││ │ 🏢 Stavby Novák s.r.o.·IČO 27…·✓ známý klient│
│                           ││ │ 💰 320 000 Kč  📍 Brno  ⏰ chce zavolat     │ │
│ [j/k] pohyb [c] volat     ││ └────────────────────────────────────────────┘ │
│ [r] odpověď [e] hotovo    ││ ┌─ KONVERZACE (scroll) ─────────────────────┐ │
│                           ││ │ [zákazník bubliny / naše ✓ / 🖼 fotky]      │ │
│                           ││ └────────────────────────────────────────────┘ │
│                           ││ ┌─ ODPOVĚĎ (sticky dole) ───────────────────┐ │
│                           ││ │ Šablony▾ Ollama✨ / textarea / [Odeslat→] 🚚│ │
│                           ││ └────────────────────────────────────────────┘ │
└───────────────────────────┘└────────────────────────────────────────────────┘
```

- **Akční pruh** pinned (nescrolluje): primární = `📞 Zavolat` (vermilion, `tel:`)
  když je telefon, jinak `↩ Odpovědět`. Druhá akce sekundární (outline).
- **AI klasifikace = malý badge** s `⌄` disclosure (default sbalené); klik rozbalí 5 pilulek.
- **"Fakta" řádek** = MinedSignals + SignatureCard sloučené (telefon vytažen do railu →
  jediné místo). Řádek 1 identita, řádek 2 obchodní signály.
- **Composer sticky footer**; konverzace scrolluje nad ním. Vozidlo za disclosure (beze změny).

## 4. Před → po

- **Povýšeno:** telefon → primární `📞 Zavolat` v railu; akce → 1 kontextová primární; composer → sticky.
- **Sloučeno:** MinedSignals+SignatureCard → 1 Fakta box; klasifikace 3 místa → řádkový Tag + AI badge.
- **Za disclosure:** ClassificationControl 5 pilulek; vozidlo (beze změny).
- **Zredukováno:** filtry 5→3 (Nevyřízené · 📞 Volat · Vše); stat strip zvážit zúžit.
- **Přidáno:** `[c]` = zavolat; "volal jsem" stav (výkup se uzavře telefonem, často bez psané odpovědi).
- **Nezměněno:** ReplyRow + snippet (po R1), send path + dvoukrokový confirm, šablony, Ollama, calm states, 30s poll.

## 5. Keyboard-first triage loop

`j`/`k` pohyb · **`c` zavolat (NOVÉ)** · `r` odpověď · `e` hotovo+skok na další ·
`1`–`5` přeřadit klasifikaci (NOVÉ, volitelné) · `Esc` zavři.

Ranní smyčka: `📞 Volat lane → j → přečti → c (zavolej) → e (hotovo, další) → c → e …`
Cíl: odbavit lead bez myši.

## 6. Co zachovat

Mining (telefon/cena/callback/urgent/lokace), podpis (firma/IČO/CRM match),
klasifikace+override+confidence (training signál), ChatThread+quote-strip+přílohy,
composer outbox→relay+dvoukrokový confirm+šablony+Ollama, calm states, vozidlo capture.

## 7. Otevřené otázky pro operátora

1. **Filtry 5→3?** Sloučit Zájem+Nevyřízené, ★Označené jen na klávesu? Nebo 4 = Nevyřízené·Zájem·📞Volat·Vše?
2. **Stat strip** — 4 čísla nebo zúžit na 2 (Nevyřízené/Zájem)?
3. **"Volal jsem"** — má klik na 📞 nabídnout rovnou "označit vyřízené"?
4. **Sticky composer** — OK trvale přilepený dole (~140 px), nebo skrytý a `r` rozbalí?

---

**Po schválení:** provést jako rozšířená R1 — 1 PR, akční pruh + sloučený Fakta řádek
+ sticky composer jako jádro; filtry/stat strip dle odpovědí §7. Smoke + screenshot light/dark.
