# Karanténa (Lift & Shift Staging Area)

Adresář `products/` již **neslouží** k trvalému běhu legacy kódu (jak to dělal starý Octavius engine). Tento adresář nyní funguje výhradně jako **Quarantine & Staging zóna** pro migraci legacy repozitářů do nové vektorové architektury ve `spine/`.

## Jak probíhá migrace (Lift & Shift)

Antigravity Engine kód z těchto repozitářů nečte "in-place". Místo toho se postupuje takto:
1. **Clone:** Kód starého produktu se naklonuje do dočasné složky.
2. **Scaffold:** Pomocí `node dist/index.js create <nodeId>` se ve `spine/` vytvoří nové sémantické uzly.
3. **Merge & Move:** Metadata z původních `vektor.json` se sloučí do nových uzlů a fyzický kód (.ts, .mjs, .vue) se přesune do `spine/`.
4. **Audit:** Spustí se `audit --heal`, který odhalí osiřelé soubory a zkontroluje integritu hran.
5. **Delete:** Zcela zmigrovaná složka se z karantény smaže.

## Zbývající produkty k migraci

| složka | origin | stav migrace | repozitář |
|---|---|---|---|
| `frontier/` | `frontier` | ✅ **PLNĚ ZMIGROVÁNO** (Smazáno z karantény) | `hozantaher/frontier` |
| `auction24/` | `auction24` | ⏳ Čeká na migraci (Cíl: `spine/sale`) | `danielkrul97/garaaage-auction` |
| `hozan-taher/` | `data-core` | ⏳ Čeká na migraci (Cíl: `spine/supply`) | `hozantaher/hozan-taher` |
| `properlak/` | `properlak` | ⏳ Čeká na migraci (Cíl: nezařazeno) | `hozantaher/properlak` |

## Příprava pro migraci (Naklonování repozitáře)

Pokud chcete začít migrovat projekt, naklonujte si ho nejprve sem:

```bash
git clone https://github.com/danielkrul97/garaaage-auction.git products/auction24
git clone https://github.com/hozantaher/hozan-taher.git        products/hozan-taher
```
