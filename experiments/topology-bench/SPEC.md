# SPEC: Topology Bench (Freeze Document)

## 1. Topologie (Archetypy)
Tento benchmark porovnává stávající baseline proti 5 novým, reálně zhmotněným topologiím:
*   **T0 - Vector-Tree (Baseline):** Stávající řešení ve `spine/`. Fyzické uzly seskupené podle byznys osy (PC1), provázané skrz `vektor.json` hrany a `// @vektor-link:` reverzní vazby. Hierarchický sémantický strom.
*   **T1 - Layered (N-Tier):** Kód je dělen do horizontálních vrstev: `presentation`, `application`, `domain`, `infrastructure`. Uzly ztrácí byznysovou soudržnost na disku, soubory se dělí dle technické příslušnosti. Importy jdou striktně shora dolů.
*   **T2 - Feature-Sliced Design (FSD):** `app` / `pages` / `widgets` / `features` / `entities` / `shared`. Každá capability se stane feature nebo entitou. Striktně jednosměrné importy dolů napříč vrstvami.
*   **T3 - Hexagonal (Ports & Adapters):** Každá capability tvoří "Domain Core" izolované od infrastruktury. Komunikace přes "Ports" (interface) a "Adapters" (implementace). Závislosti míří vždy dovnitř k doméně.
*   **T4 - Event-Driven (Choreography):** Plně rozpojené moduly. Přímé závislosti (reverzní linky a importy) jsou eliminovány a nahrazeny event-busem (topiky). Osa příběhu určuje jen jmenný prostor pub/sub kanálů.
*   **T5 - Flat Tag-Graph:** Absolutně plochá struktura. Neexistují žádné zanořené složky (např. `/spine/sale`, `/spine/supply`). Všechny uzly leží v jednom adresáři `/flat/` a jsou filtrovány pouze metadaty (tagy) v manifestech.

## 2. Metriky a dimenze (D1-D4)

### D1: AI-context / LLM Bubble (Váha 0.30)
Pro každý uzel se "resolvuje" kontextová bublina, kterou engine servíruje AI (dense soubory + reverzní linky + BFS sousedi do hloubky `k=1`).
*   **Velikost (Size):** Medián a 95. percentil počtu bytů (přepočteno na tokeny: `bytes / 4`).
*   **Přesnost (Precision):** Podíl bubliny, který je reálně potřeba pro vykonání typické změny (menší a trefnější = lepší). Normalizováno tak, aby 1.0 znamenalo nejmenší a nejkompaktnější užitečnou bublinu.

### D2: Lokalita změny / Blast-radius (Váha 0.30)
Měřeno nad sadou 10 fixních "Change Scenarios" z byznysu. Skript nasimuluje dotčené soubory. Měří se průměr na scénář:
1. Počet dotčených souborů (Files mutated).
2. Počet dotčených architektonických uzlů (Nodes mutated).
3. Počet porušených vrstev/hranic (Boundary Leaks).
**Méně = lepší (Normalizace k 1.0).**

**Change Scenarios (Fixní seznam):**
1. Přidej VIN-decode pole do vehicle capture a propiš do settlement.
2. Přidej scraper sauto.cz vedle firmy-cz.
3. GDPR erasure pole → propsat do suppression + dsr + outreach.
4. Změň zaokrouhlení měny v settlement → invoicing + deposit-billing následují.
5. Per-mailbox rate cap pro novou IMAP operaci.
6. Audit-log call do každé write cesty.
7. Přejmenuj core uzel (např. bidding na live-auction) a kaskáduj.
8. Uprav autorizační token (api-tokens) pro přístup do dashboard-bff.
9. Nová push-notifikace napříč shadow-broker a symphony-queue.
10. Sjednocení UI komponent pro input napříč demand-search a dashboard-core.

### D3: Zdraví grafu (Váha 0.20)
*   **Coupling:** Průměrný Fan-in / Fan-out.
*   **Cohesion & Q-Modularity:** Síla vnitřních vazeb proti vnějším (detekce komunit).
*   **Zranitelnost (Cycles & Max Depth):** Počet cyklických závislostí a maximální hloubka závislostí. Měřena též distribuce In-Degree (Hub vulnerability).
**Lépe strukturovaný graf = lepší (Normalizace k 1.0).**

### D4: Odolnost vůči driftu (Váha 0.20)
Záměrná sabotáž. Provedou se multi-seed (3 seedy: `[42, 1337, 2026]`) náhodné mutace kódu (přesunutí souboru do jiné domény, vytvoření orphan importu, smazání manifestu). Poté se spustí "auto-heal" (`audit --heal`).
*   **Zachycené defekty:** Počet zachycených `violations`.
*   **Heal Rate:** Procento poškození, které dokázal systém automaticky samoopravit bez zásahu vývojáře.
**Větší Heal Rate = lepší (Normalizace k 1.0).**

## 3. Kompozitní Skóre a Normalizace
Každá dimenze vrací raw skóre. Všechna raw skóre budou deterministicky normalizována na interval `[0.0, 1.0]` relativně vůči sobě (min/max scaling) tak, že **1.0 je vždy nejlepší**.
**Kompozit = (D1 * 0.3) + (D2 * 0.3) + (D3 * 0.2) + (D4 * 0.2)**

Zlaté pravidlo: Topologie, kterou nejde pro specifický scénář vůbec postavit nebo selže build/audit, získává ve scénáři penalizaci `0.0`.
Vítěz musí porazit baseline T0 nad rámec šumu (rozdíl celkového skóre větší než ±1 směrodatná odchylka napříč seedy).
