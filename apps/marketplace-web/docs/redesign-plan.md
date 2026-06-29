# Redesign vzhledu (aplikace + admin) — implementační plán

Inspirace: `/home/dkrul/Projects/stargate` (Nuxt UI v4, slate + blue, flat/border-first,
collapsible sidebar shell). Cíl: přenést **estetiku** stargate na garaaage-auction, který
`@nuxt/ui` **nepoužívá** (staví na `Base*` + `@headlessui/vue` + striktní CSS). Není to klon —
je to "inspirováno".

## 0. Zafixovaná rozhodnutí (vstup od zadavatele)

| Téma | Rozhodnutí |
| --- | --- |
| **Barva** | Slate neutrály + **blue-500 jako primární chrome**; **červená `#db302f` rezervovaná jako akcent pro aukce/přihazování**. |
| **Dark mode** | **Vynechat úplně.** Smazat mrtvé `.dark` hooky (`main.css:177`, `default.vue` `.page-root dark:*`), `@nuxtjs/color-mode` neinstalovat. Single-mode tokeny. |
| **Admin** | **Přijmout stargate shell** — collapsible/resizable levý sidebar + grouped icon+label nav + per-page top navbar; command palette (Cmd-K) jako stretch. |

Default (nedotázané, snadno reverzibilní): **font zůstává Lato** (brand, type-scale 12/14/16/18/24/32
už je shodný se stargate, žádná změna), **ikony** — pro nový chrome (sidebar, tabulky, paleta)
zavést `lucide`, ostatní heroicons/flag/cib ponechat.

## 1. Cílový designový jazyk → token systém

Vše jako **sémantické tokeny v `assets/css/main.css @theme`**, komponenty referencují tokeny
(ne hex). Žádné dark varianty.

### Paleta

| Token (návrh) | Hodnota | Role |
| --- | --- | --- |
| `--color-app-bg` | slate-50 `#f8fafc` | pozadí stránky (nahrazuje `gray-100`) |
| `--color-app-surface` | white `#ffffff` | karty, panely, hlavička |
| `--color-app-surface-muted` | slate-100 `#f1f5f9` | thead, inset boxy, hover fill |
| `--color-app-border` | slate-200 `#e2e8f0` | hairline borders, dividery |
| `--color-app-border-strong` | slate-300 `#cbd5e1` | výraznější ohraničení |
| `--color-app-text` | slate-700 `#334155` | běžný text |
| `--color-app-text-muted` | slate-500 `#64748b` | popisky, sekundární |
| `--color-app-text-strong` | slate-900 `#0f172a` | nadpisy, čísla, hodnoty |
| `--color-app-primary` | blue-500 `#3b82f6` | **chrome primární** |
| `--color-app-primary-hover` | blue-600 `#2563eb` | hover primárního |
| `--color-app-red` (zachovat) | `#db302f` | **akcent aukce/bid**, destruktivní akce |
| `--color-app-green` (zachovat) | green-600 `#16a34a` | buy-now, success, výhra |
| `--color-app-amber` (nový) | amber-500 `#f59e0b` | pending / „brzy" / čekání na platbu |

**Nejvyšší páka — přemapovat `gray` ramp na slate v `@theme`** (`--color-gray-50…950` = slate
hodnoty). Tím se všech **252** výskytů `*-gray-*` překlopí na chladné slate **bez editace komponent**.
(Riziko: pár míst spoléhajících na nuanci „pravé šedi" — vizuálně ověřit. Pokud by to bylo riskantní,
fallback = ponechat `gray` a slate-ifikovat jen přes nové sémantické tokeny.)

### Pravidlo barvy (kde modrá / červená / zelená) — závazné pro celou implementaci

- **MODRÁ (`app-primary`) = chrome:** všechna obecná tlačítka/CTA, odkazy, focus ringy formulářů,
  zaškrtnutý checkbox/radio, aktivní nav (public i admin), aktuální stránka paginace, compare CTA,
  command palette, aktivní položka sidebaru, odeslání kontaktního formuláře, potvrzení v modalech
  (nedestruktivní).
- **ČERVENÁ (`app-red`) = aukce + destrukce:** status „Live", aktuální příhoz / počet příhozů,
  CTA „Přihodit" u aukčních položek, zvýraznění bid-rows (winning = zelená, outbid/mine = červená),
  NProgress bar (brand moment), destruktivní akce (smazat).
- **ZELENÁ (`app-green`) = buy-now + úspěch:** „BUY NOW" pill/cena, paid/success, výherní příhoz.
- **AMBER = pending:** „brzy", čekání na bankovní platbu (deposit).

Přirozený split, který drží auction24 afordance: *zelená = buy-now, červená = aukce/příhoz,
modrá = systémový chrome*.

### Tvar, hloubka, hustota

- **Radius (beze změny škály):** karty/inputy/tlačítka `rounded-lg` (8px), pilulky/avatary
  `rounded-full`. (stargate má 6px `rounded-md` — u nás **zakázáno**, použít `rounded-lg`.)
- **Hloubka = flat, border-first.** Z `app-panel`/karet odstranit `shadow`/`shadow-lg` +
  `ring-1 ring-black/5` → nahradit `border border-app-border` (1px). Stín ponechat **jen** na
  plovoucích vrstvách (modaly, dropdowny, `CompareDock`, sticky lišty).
- **Hustota:** kompaktní (stargate). Tabulky `th py-2` / `td py-3`, bez zebry, 1px dividery,
  jemný hover.

### Klíčové redefinice `@utility` v `main.css` (= největší páka, jeden soubor)

```css
@utility app-btn {                 /* PRIMÁRNÍ chrome — plochá modrá, bez stínu */
  @apply flex w-full cursor-pointer justify-center rounded-lg border border-transparent px-4 py-2 text-sm font-medium text-white;
  @apply bg-app-primary hover:bg-app-primary-hover;
  @apply focus:ring-2 focus:ring-app-primary/40 focus:ring-offset-2 focus:outline-none;
  @apply disabled:cursor-not-allowed disabled:opacity-30;
}
@utility app-btn-auction {         /* NOVÉ — červené solid pro „Přihodit" */
  @apply ... bg-app-red hover:bg-app-red ...;
}
@utility app-panel {               /* flat: border místo shadow+ring */
  @apply rounded-lg border border-app-border bg-app-surface px-[16px];
}
```

Protože kód prochází přes `app-btn` (78×), `app-panel` (24×), `app-red` (71×) a `gray-*` (252×),
**redefinice v `main.css` + layouty překlopí ~80 % plochy s editacemi v jednom souboru**. Per-komponentní
fáze pak hlavně (a) dořeší off-paletu (`indigo`, `yellow-400`, `amber`, `green-600/800`) a (b) přepnou
specifická místa na pravidlo modrá/červená/zelená.

## 2. Fáze (sekvenčně; testovat na devu po každé)

| # | Fáze | Hlavní soubory | Rozsah |
| --- | --- | --- | --- |
| **0** | **Token foundation** — `@theme` (slate ramp, sémantické tokeny, primary, amber), redefinice `app-btn*`/`app-panel*`, `html` bg → slate-50, smazat dead dark hooky | `assets/css/main.css`, `layouts/default.vue` | **L (keystone)** |
| **1** | **Chrome public** — `Header` (flat 1px border-bottom místo shadow, aktivní nav modrá), `Footer` (slate, indigo→blue) | `Header.vue`, `Footer.vue` | M |
| **2** | **Listing surfaces** — `ItemCard` (flat border, bid=červená, buy-now=zelená, compare=modrá), `ItemStatus` pills → subtle-badge systém, `ItemsRail`, `CompareDock`, `CookiesBar` (z červeného bloku na neutrální lištu + primary btn), `ContactForm` (červený panel → modrý/slate, odstranit indigo) | `components/Item*`, `CompareDock`, `CookiesBar`, `ContactForm`, `NoItems` | L |
| **3** | **Base formuláře** — sjednotit na flat 1px border + modrý focus; checkbox(byl červený)→modrá, radio(byl zelený)→modrá; `BaseModal`/`Confirmation` flat panel | `components/Base*.vue` | M |
| **4** | **Detail položky** — `ItemInfo`, `ItemBids`/`BidRow` (aukce=červená/zelená), `ItemGallery`/`Lightbox`/`Pano`, `PriceStatus`, `FlagBadge`, `SimilarItems` | `pages/item/**`, `components/Item*` | M |
| **5** | **Profil** — taby, `Invoices` tabulka → stargate dense (bez zebry, 1px dividery, link buňky modré, status badge), `DepositCard`, profilové edit rows | `pages/profile/**`, `Invoices.vue` | M |
| **6** | **Deposit wizard** (samostatný sub-brand) — darkBlue→primary blue, zachovat zelenou (success) + amber (pending), překreslit stepper/step karty/konfety/SVG gradienty | `components/deposit/**` | M |
| **7** | **Admin shell** — nový `layouts/admin.vue`: collapsible/resizable levý sidebar (slate surface, **ne** starý gray-800 dark rail), grouped lucide icon+label nav, brand/účet nahoře, user menu dole (`border-t`), per-page top navbar (collapse toggle + titul + akce „+ Nová položka"). Slide-over/menu přes headless UI. **Command palette (Cmd-K) = stretch.** | `layouts/admin.vue`, nové `components/admin/*` | **L** |
| **8** | **Admin stránky** — datatables (items/users/api-tokens) → stargate dense pattern (sortable headery se šipkami, link buňky modré, status badge, ellipsis row menu, left-search/right-filter toolbar, pravá paginace). Editor (`ItemDetail` + taby) dědí z fáze 3. | `pages/admin/**` | L |
| **9** | **Cleanup + enforcement** — smazat mrtvé utility (`app-base-menu-items` 0×, přejmenovat `app-hover-green`), dořešit zbylou off-paletu, aktualizovat `CLAUDE.md` (paleta + pravidlo modrá/červená/zelená), `components/playground` Foundations swatche, `pnpm lint` + `lint:css` + `test:unit` | `main.css`, `CLAUDE.md`, `playground/**` | S |

**Paralelizace:** fáze 0 je keystone (vše na ní závisí). Po ní jsou **1–6 (public)** a **7–8 (admin)**
do velké míry nezávislé → lze rozdělit mezi sezení/subagenty. Fáze 9 poslední.

## 3. Testování na devu (failable check po každé fázi)

Dev běží: `PORT=3001 pnpm dev` (vybral si **:3002**, 3000/3001 obsazené stargatem). Po každé fázi:

1. **`pnpm lint:css` + `pnpm lint` MUSÍ projít** — redesign stojí a padá na striktních pravidlech
   (no inline tailwind, no raw values, no arbitrary `@apply`, radius `sm/lg/xl/full`, scale 12/14/16/18/24/32,
   no min/max-width MQ, no BEM, no `stylelint-disable`). Toto je tvrdá brána.
2. **Screenshot dotčených routes** (Playwright na :3002) a porovnat se záměrem fáze.
3. **`pnpm test:unit`** — žádné vizuální testy, ale chytí rozbití (mappery, helpery).
4. **Žádné nové console errory.**
5. **`/playground`** (dev-only galerie, `layout:false`) — jednostránkový důkaz tokenů/komponent;
   po fázi 0/3 nejrychlejší ověření celého systému naráz.

**Per-route checklist** (ať se neztratí netnutý povrch): `/`, `/auctions`, `/buy-now`, `/sold`,
`/categories`, `/category/:id`, `/item/:id`, `/compare`, `/contact`, `/sign`, `/sign/up`,
`/profile`, `/profile/billing`, `/admin/items`, `/admin/users`, `/admin/item/:id`, `/admin/api-tokens`.

> ⚠️ **Předpoklad pro auth-gated povrchy:** `/profile/**` a `/admin/**` jsou `ssr:false` + vyžadují
> přihlášení (Firebase). Pro screenshoty potřebuji testovací login (seed `admin1`) nebo dočasné
> obejití guardu na devu. Nutno vyřešit před fází 5/7/8.

## 4. Rizika & sebe-kritika

1. **Žádná automatická vizuální regrese** — ověření je screenshot-okem + lint. Riziko regresí na
   neodscreenshotovaných povrchech. Mitigace: per-route checklist výše + `/playground` jako single-page proof.
2. **`gray → slate` override je globální** — může odhalit subtilní kontrastní kolize (slate na slate).
   Vizuálně ověřit; fallback = nemapovat `gray` a slate-ifikovat jen přes nové tokeny (víc práce, bezpečnější).
3. **Auth-gated screenshoty** (profil/admin) bez přihlášení nejdou — viz předpoklad výše.
4. **Command palette (Cmd-K)** není jen re-skin, ale nová funkce (search index) → držet jako **stretch**,
   ať fáze 7 nenabobtná.
5. **Deposit konfety/SVG gradienty** (fáze 6) jsou fiddly a izolované — počítat s časem.
6. **Lato vs system font** — ponechání Lata je můj default, ne explicitní volba zadavatele; rychlá
   reverzibilní změna (swap `--font-sans`), pokud bys chtěl stargate system-font feel.
7. **„Červená pro aukce" musí mít ostré hranice** — pravidlo v §1 je proto explicitní; při review hlídat,
   aby se červená nevracela do obecného chrome.

## 5. Odhad rozsahu

Velký, vícedenní redesign. Hrubě: **fáze 0 + 1** dají největší vizuální posun za nejméně práce
(token-first). **Fáze 7 (admin shell)** je největší strukturální kus (nový layout + nav komponenty).
Doporučené pořadí dodání hodnoty: **0 → 1 → 2 → (3) → 7 → 8 → 4 → 5 → 6 → 9**.
