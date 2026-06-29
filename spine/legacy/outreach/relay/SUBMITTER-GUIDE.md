# Submitter Guide

Jak bezpečně odeslat zprávu přes anti-trace relay. Tři kroky, žádné stopy na zařízení.

---

## Co potřebuješ

1. **Passphrase** -- zapamatovatelná fráze (4+ slov), sdílená s příjemcem
2. **Recipient key** -- 64-znakový hex kód (veřejný klíč příjemce)
3. **Relay adresa** -- `.onion` URL relay serveru

Tyto tři údaje ti musí předat tvůj kontakt **bezpečným kanálem** (osobně, šifrovaným chatem, papírem). Nikdy emailem ani telefonem.

---

## Krok 1: Připrav prostředí

### Nejbezpečnější: Tails USB

1. Stáhni [Tails](https://tails.net) na jiném počítači
2. Nahraj na USB flash disk
3. Nabootuj z USB (při startu drž klávesu pro boot menu)
4. Tails automaticky routuje vše přes Tor
5. Po vypnutí nezůstanou žádné stopy

### Alternativa: Tor Browser

1. Stáhni [Tor Browser](https://www.torproject.org)
2. Spusť a počkej na připojení k Tor síti
3. Zbytek proveď v terminálu se `torsocks`

---

## Krok 2: Stáhni submit binary

Stáhni binárku pro svůj systém:

| Systém | Soubor |
|--------|--------|
| Linux (Intel/AMD) | `submit` z `linux-amd64/` |
| Linux (ARM, Raspberry Pi) | `submit` z `linux-arm64/` |
| macOS (Intel) | `submit` z `darwin-amd64/` |
| macOS (Apple Silicon) | `submit` z `darwin-arm64/` |

```bash
# Na Tails/Linux:
chmod +x submit
```

### Ověř checksum

```bash
sha256sum submit
# Porovnej s SHA256SUMS souborem od tvého kontaktu
```

---

## Krok 3: Odešli zprávu

```bash
echo "tvoje-tajná-fráze" | ./submit \
  --relay https://xxxxxxxxxxxxxxxx.onion \
  --recipient-key abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789 \
  --message "Tvoje zpráva zde"
```

Uvidíš:
```
Passphrase:
Submitted successfully.
```

**Hotovo.** Zpráva je zašifrována a odeslána. Binárka po sobě nezanechala žádné soubory.

---

## Co se děje na pozadí

1. Z tvé fráze se odvodí šifrovací klíč (28 sekund výpočtu -- to je ochrana)
2. Zpráva se zašifruje klíčem příjemce (nikdo jiný ji nemůže přečíst)
3. Zpráva se doplní na standardní velikost (aby nebyla rozpoznatelná)
4. Odešle se do "mrtvé schránky" na relay serveru
5. Příjemce si zprávu vyzvedne ze stejné schránky (zná stejnou frázi)
6. Všechny klíče a data se smažou z paměti
7. Program se ukončí

---

## Bezpečnostní pravidla

### Dělej

- Používej Tails nebo alespoň Tor Browser
- Odesílej z veřejné WiFi (kavárna, knihovna)
- Zapamatuj si frázi -- nepiš ji nikam
- Smaž binárku po odeslání (`rm submit`)
- Každou zprávu odesílej z jiného místa (pokud možné)

### Nedělej

- Neodesílej z domácí WiFi
- Nepoužívej telefon s SIM na tvé jméno
- Neukládej frázi do telefonu, poznámek ani cloudu
- Nenech binárku na počítači déle než nutné
- Neříkej nikomu, že používáš tento systém
- Neposílej totožnou zprávu více kanály (korelace)

---

## Nouzová situace (duress)

Pokud tě někdo nutí ukázat systém:

1. Zadej **jinou frázi** (ne tu skutečnou)
2. Systém zobrazí: "Authentication failed. Please try again."
3. Všechna data se automaticky smažou z paměti
4. Pro pozorovatele to vypadá jako překlep -- nelze odlišit od duress

---

## Často kladené otázky

**Jak dlouho trvá odeslání?**
~30 sekund (většina je odvozování klíče z fráze -- to je záměrné).

**Co když zadám špatnou frázi?**
Zobrazí se "Authentication failed." Nic se neodešle, nic se neuloží.

**Může zprávu přečíst provozovatel relay?**
Ne. Zpráva je zašifrována klíčem příjemce. Relay vidí jen zašifrovaný blob.

**Může někdo zjistit, komu píšu?**
Relay neví, kdo jsi (alias) ani kam zpráva jde (mrtvá schránka). Síťový provoz je routován přes Tor.

**Co když je relay zabaven?**
Zprávy jsou zašifrované. Bez klíče příjemce je nelze přečíst. Identity submitterů jsou v odděleném vaultu s vlastním klíčem.

**Funguje to bez internetu?**
Ne. Potřebuješ připojení k Tor síti.

---

## Pro příjemce: Vyzvednutí zpráv

Příjemce používá `receive` binary se stejnou sdílenou frází:

### Zobrazení veřejného klíče (jednorázově, sdílí se s odesílatelem)

```bash
echo "sdílená-fráze" | ./receive --show-key
# Výstup: 64-znakový hex veřejný klíč
# Tento klíč sdílej s odesílatelem (on ho použije jako --recipient-key)
```

### Vyzvednutí zpráv

```bash
echo "sdílená-fráze" | ./receive --relay https://xxxxxxxx.onion
```

Uvidíš:
```
Passphrase:
1 message(s) received:

URGENT: Need evacuation from sector 7...
```

### Jak to funguje

1. Ze stejné fráze se odvodí stejná mrtvá schránka (sender i receiver)
2. Receiver odvodí svůj soukromý klíč (pro dešifrování)
3. Zprávy se vyzvednou a dešifrují
4. Po vyzvednutí se schránka vyprázdní (jednorázové čtení)
5. Vše se smaže z paměti

### Důležité

- Zprávy se dají vyzvednout **jen jednou** -- po pollu se smažou
- Frázi sdílej **osobně** nebo přes šifrovaný kanál
- Veřejný klíč stačí sdílet jednou (je odvozený z fráze, nezmění se)
