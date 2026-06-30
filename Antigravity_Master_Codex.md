# ANTIGRAVITY: THE MASTER CODEX (v3.0 - The Complete Compendium)

*Absolutní architektonická, byznysová a technická Bible pro systém řízený autonomními agenty, navržený pro nekonečné škálování a provoz +100M valuace bez lidských zaměstnanců.*

Tento dokument je definitivním a jediným referenčním bodem pro celý projekt Antigravity. Sjednocuje historii vývoje, absolutní mapu stromové struktury, byznys model a nízkoúrovňové technické řešení LLM enginu do jedné celistvé filozofie: **Kód je Byznys, Strom je Zákon.**

Struktura tohoto gigantického kánonu postupuje striktně shora dolů (Top-Down): Od byznysové myšlenky přes datové modely až k hlubokým inženýrským algoritmům, které systém udržují naživu.

---

# KNIHA I: THE VECTOR (Vrchol Abstrakce)

## 1. Konec Softwarového Inženýrství
V klasickém pojetí vývoje softwaru existuje propastná mezera (informační latence) mezi byznysovou myšlenkou (CEO/Produktový manažer) a finální exekucí (Programátor). Výsledkem tohoto šumu je technický dluh, mrtvý kód a systémy, které dělají něco jiného, než byznys potřebuje.

Antigravity tento koncept zcela maže. Softwarové inženýrství bylo nahrazeno **Byznysovou Kompilací**.
Kód už nepíšeme jako textový dokument instrukcí pro procesor. Píšeme myšlenku do uzlu (Vektoru), kterou kompilátor (Symphony Orchestrator a jeho Roje) přemění ve fyzickou exekutivu.

## 2. Anatomie Vektoru (`vektor.json`)
Základní stavební jednotkou a DNA celého systému není `.ts` soubor, ale manifest `vektor.json`. Tento soubor nahrazuje dokumentaci, README, JIRA tickety, i architektonické nákresy. Je to kognitivní buňka.

Zde je kompletní a vyčerpávající specifikace absolutního `vektor.json` manifestu:

```json
{
  "id": "shadow-broker",
  "axis": "deals",
  "state": "met",
  "businessStory": "Exekuční modul pro Zero Friction uzavření obchodu. Zákazník nevidí žádný formulář, dostává pouze Magic Link. Tímto uzlem protéká 100 % našich konverzí.",
  "operatorStory": "Operátor v tomto uzlu vůbec nezasahuje. Transakce se potvrzují biometricky na straně klienta. Pokud transakce přesáhne 50 000 EUR, operátor dostane notifikaci k manuálnímu schválení.",
  "roiModel": "Úspora 12 minut práce obchodníka na jeden Deal. Při 10 000 dealech měsíčně = 2 000 hodin ušetřeného lidského času = cca +2 500 000 CZK k čisté marži.",
  "agentPrompt": "Při jakékoliv úpravě tohoto uzlu nesmíš vyžadovat další uživatelské vstupy. Udržuj proces na 1 kliknutí. Pokud přidáváš nové platební metody, musí být plně asynchronní přes Webhooky.",
  "tags": [
    "shadow-execution", 
    "magic-link", 
    "conversion",
    "tier-1-critical"
  ],
  "facets": {
    "own": [
      "./index.ts", 
      "./services/magicLinkGenerator.ts",
      "./services/cryptoSigner.ts"
    ],
    "link": [
      "@substrate/core-types/Opportunity.ts", 
      "@substrate/core-types/Deal.ts",
      "@substrate/core-types/Signature.ts"
    ]
  },
  "edges": [
    "sale-settlement", 
    "outreach",
    "invoice-generator"
  ],
  "proofSignal": [
    "vitest run src/broker.test.ts --run",
    "eslint src/ --max-warnings=0"
  ],
  "meta": {
    "createdAt": "2026-06-30T10:00:00Z",
    "lastModifiedBy": "Symphony-Sonnet-3.5",
    "astNodeCount": 4250,
    "mitosisRisk": "low"
  }
}
```

### 2.1 Dekonstrukce Polí Vektoru
* **id & axis:** Sémantické zařazení do HNSW grafu. Slouží pro O(1) Routing.
* **state:** Mutex Zámek (`pending`, `locked`, `met`, `failed`). Řídí asynchronní přístup 50 agentů současně, aniž by došlo ke kolizím (Race Conditions).
* **businessStory & operatorStory:** Srdce systému. Tyto řetězce nečte počítač, ale LLM s miliardami parametrů. Agent díky nim ví, *proč* kód existuje.
* **roiModel:** Kognitivní Ekonomika. Pokud agent při svém RAG (Retrieval-Augmented Generation) vyhledávání a kódování propálí více API kreditů, než jakou hodnotu má tento uzel (ROI), orchestrátor jeho operaci stornuje.
* **facets (own & link):** RAG Izolační bariéra. Agent nevidí celý repozitář. Dostane pouze soubory uvedené v `own` a typová Zod rozhraní z `link`. To zabraňuje zhroucení LLM paměti (Attention Degradation).
* **edges:** Tvrdé hrany směrovaného grafu (DAG). Data z tohoto uzlu smějí fyzicky putovat pouze do uzlů specifikovaných zde.
* **proofSignal:** Deterministický pískovištní test (Zod Enforcer). Kód agenta není nasazen, dokud tento příkaz nevrátí Exit Code 0.

## 3. The Arterial Compiler (Kompilátor Byznysu)
Protože dokumentace už neexistuje ve formě volného textu, nahrazujeme ji automatizací.
Arterial Compiler je nízkoúrovňový skript v `antigravity-cli`, který funguje následovně:
1. Rekurzivně projde všechny adresáře a posbírá `vektor.json`.
2. Provede sémantickou analýzu Zod-Compliant schémat.
3. Vygeneruje dynamický `LIVE_ARCHITECTURE.md`, který vizualizuje strukturu.
4. Exportuje data jako Vektorové Embeddingy do `.vektor/diary` pro O(1) sémantické vyhledávání dalšími Agenty.

Tím je zajištěno, že zdrojový kód, byznys cíl a dokumentace jsou jedna fyzická, nerozbitelná substance.

---

# KNIHA II: THE GOD VIEW (Architektura)

## 4. Směrovaný Acyklický Graf (DAG)
Složky v Antigravity nejsou adresáře. Jsou to uzly v DAG (Directed Acyclic Graph). Celý repozitář tvoří gigantický organismus, do kterého nahoře vstupují surová data a dole vypadávají čisté peníze.

Zde je absolutní topologická mapa systému. Pozorně si všimněte, jak tok informací odráží tok hodnoty:

```text
antigravity/                             ◈ INDEX ROOT (vektor.json: god-node)
│
├── 📦 assets/            [OS 1: Těžba Surovin a Zero CAC]
│   ├── ⊙ acquisition-ball 
│   │   ├── 🕷️ b2b-miner/                 [Vektor: b2b-miner] [Edges: parser-compiler]
│   │   │   ├── src/crawler.ts       
│   │   │   └── fleet-api.ts         
│   │   ├── 📡 sitemap-watcher/           [Vektor: sitemap-watcher] [Edges: scrapers]
│   │   │   └── src/monitor.ts
│   │   ├── 🤖 scrapers/                  [Vektor: scrapers] [Edges: parser-compiler]
│   │   │   ├── src/mobile-de.ts
│   │   │   └── src/autoscout.ts
│   │   └── 🕸️ dark-web-intel/            [Vektor: intel] [Edges: risk-matrix]
│   │       └── src/tor-proxy.ts
│   └── ⊙ processing-ball 
│       ├── 🧩 parser-compiler/           [Vektor: parser] [Edges: arbitrage-miner]
│       │   └── src/zod-mapper.ts
│       └── 🧹 data-sanitizer/            [Vektor: sanitizer] [Edges: parser-compiler]
│           └── src/cleaner.ts
│
├── 🎯 opportunities/     [OS 2: Arbitráž a Vyhodnocení]
│   ├── ⊙ scoring-ball 
│   │   ├── 📈 arbitrage-miner/           [Vektor: arbitrage-miner] [Edges: shadow-broker, dead-asset-pool]
│   │   │   └── src/spread-calc.ts
│   │   └── 🧮 risk-matrix/               [Vektor: risk-matrix] [Edges: arbitrage-miner]
│   │       └── src/credit-score.ts
│   └── ⊙ discovery-ball 
│       ├── 🔬 deep-research/             [Vektor: deep-research] [Edges: arbitrage-miner]
│       │   └── src/o1-researcher.ts
│       ├── 🏪 inbound-marketplace/       [Vektor: inbound-marketplace] [Edges: shadow-broker]
│       │   └── src/web-gateway.ts
│       └── 📱 mobile-app-gateway/        [Vektor: mobile-gateway] [Edges: shadow-broker]
│           └── src/api-gateway.ts
│
├── 🤝 deals/             🔒 [OS 3: Inkasování a Shadow Execution]
│   ├── ⊙ execution-ball 
│   │   ├── 🔏 shadow-broker/              [Vektor: shadow-broker] [Edges: sale-settlement, outreach]
│   │   │   └── src/magic-link.ts    
│   │   └── ⚖️ legal-compiler/            [Vektor: legal-compiler] [Edges: shadow-broker]
│   │       └── src/contract-gen.ts
│   ├── ⊙ finance-ball 
│   │   ├── 💸 sale-settlement/           [Vektor: sale-settlement] [Edges: invoicing, ledger]
│   │   │   └── src/stripe-hook.ts
│   │   ├── 🧾 invoicing/                 [Vektor: invoicing] [Edges: accounting]
│   │   │   └── src/pdf-gen.ts
│   │   └── 🏦 ledger/                    [Vektor: ledger] [Edges: accounting]
│   │       └── src/blockchain-log.ts
│   └── ⊙ logistics-ball 
│       ├── 📦 dispatch/                  [Vektor: dispatch] [Edges: delivery-tracker]
│       │   └── src/shipping.ts
│       └── 🚚 delivery-tracker/          [Vektor: tracker] [Edges: none]
│           └── src/gps-poll.ts
│
├── 🧠 agents/            [OS 4: Autonomní Exekutiva a Roj]
│   ├── ⊙ communication-ball 
│   │   ├── 📬 outreach/                  [Vektor: outreach] [Edges: inbox-orchestrator]
│   │   │   └── src/cold-email.ts
│   │   ├── 📨 inbox-orchestrator/        [Vektor: inbox-orchestrator] [Edges: symphony, shadow-broker]
│   │   │   └── src/mail-parser.ts
│   │   └── 💬 whatsapp-relay/            [Vektor: whatsapp-relay] [Edges: inbox-orchestrator]
│   │       └── src/twilio.ts
│   ├── ⊙ intelligence-ball 
│   │   ├── 🔀 relay/                     [Vektor: relay] [Edges: symphony]
│   │   │   └── src/router.ts
│   │   └── 🕵️ espionage/                [Vektor: espionage] [Edges: symphony] (Průmyslová Špionáž)
│   │       └── src/reverse-compiler.ts
│   └── ⊙ orchestration-ball 
│       ├── 🤖 symphony/                  [Vektor: symphony] [Edges: worker]
│       │   └── src/event-loop.ts
│       ├── ⚙️ worker/                    [Vektor: worker] [Edges: substrate]
│       │   └── src/llm-container.ts
│       └── 🧪 chaos-labs/                [Vektor: chaos-labs] [Edges: none]
│           └── src/shadow-traffic.ts
│
└── 🏛️ substrate/         ◇ [OS 5: Kmen - Zákony Fyziky Platformy]
    ├── 🧠 .vektor/                  (The Global Brain - paměť agentů)
    │   └── diary/
    │       ├── err_1A2B_embed.json  (Logy selhání z Vitestu)
    │       ├── fix_zod_schema.json  (Úspěšné kódové opravy)
    │       └── espionage_cache/     (Data z cizích asimilovaných repozitářů)
    ├── ⊙ schema-ball/
    │   ├── core-types/              [facets.link - Tvrdá byznysová pravidla Zod]
    │   │   ├── Opportunity.ts
    │   │   ├── Deal.ts
    │   │   ├── Asset.ts
    │   │   └── Ledger.ts
    │   └── rule-registry/           [Sdílená obchodní logika]
    │       └── thresholds.ts
    ├── ⊙ protection-ball/
    │   ├── privacy-gateway/         [NLP Tokenizer - Izolace GDPR dat]
    │   │   └── src/pii-masker.ts
    │   └── firewall/                [Rate limiting a DDoS ochrana pro Agenty]
    │       └── src/shield.ts
    ├── ⊙ infrastructure-ball/       [Terraform a K8s manifesty generované přes Vektory]
    │   └── k8s-generator.ts
    └── ⊙ engine-ball/               (Zdrojový kód antigravity-cli routeru)
        ├── src/dfs-cycle-check.ts
        ├── src/mitosis-sharding.ts
        └── src/zod-compiler.ts
```

## 5. Zrcadlení Byznysu (The Zero CAC Principle)
Strom fyzicky zakazuje programátorům vytvořit tradiční nákladovou organizaci.
1. Osa 1 (Assets) funguje jako agregátor cizích datových zdrojů. My negenerujeme poptávku, my těžíme suroviny (Deep Inventory). Cena akvizice zákazníka (CAC) se limitně blíží nule.
2. Osa 2 (Opportunities) aplikuje *Arbitrage Mining*. Hledá tržní nedokonalosti, špatně naceněná aktiva a okamžitě počítá Spread.
3. Osa 3 (Deals) transformuje spread na cashflow přes asymetrickou exekuci (*Shadow Broker*). Nikdo nekliká v back-office, systém sám emituje smlouvy a procesuje platby pomocí webhooků.

---

# KNIHA III: THE SWARM (Rojová Orchestrace)

Když je strom postaven, přichází na řadu Symphony Orchestrator. Systém nečeká na příkazy z klávesnice. Žije vlastním životem řízeným frontou zpráv (Event Loop).

## 6. RAG Izolace a Mutex Zámky (Odstranění Git Konfliktů)
Představte si 50 programátorů pracujících v jedné složce na GitHubu. Výsledkem je katastrofa v podobě Merge Konfliktů. V Antigravity pracují AI Agenti, ne lidé. A pracují jich stovky.

**Mechanismus zámku:**
1. Symphony vygeneruje úkol: *"Napojit novou platební bránu na shadow-broker"*.
2. Vektorový Router najde uzel `shadow-broker` a zkontroluje parametr `state`.
3. Pokud je `state: "met"`, Symphony změní stav na `state: "locked"`.
4. Symphony izoluje agenta do RAG bubliny. Agent obdrží obsah souborů z `facets.own` a definice z `facets.link`. Vše ostatní ze stromu je před ním skryto. Tímto se 100% eliminuje kognitivní zahlcení LLM a halucinace.
5. Další agent, který by chtěl upravit stejný uzel, narazí na `state: "locked"` a jeho požadavek se odloží do fronty. Git konflikty tak fyzicky nemohou vzniknout.

## 7. The Global Brain (`.vektor/diary`) a Anti-Křehkost
Klasický kód hnije (Bit-rot). V Antigravity se kód s každým selháním stává silnějším.
Pokud LLM Agent nahraje špatný kód, Zod Enforcer mu vyhodí exception s gigantickým Stack-Tracem.
Toto selhání se nevyhodí do koše!
Zaloguje se do vrstvy `substrate/.vektor/diary/err_xyz.json`. Zároveň se uloží vektorový embedding tohoto chybového stavu.
Když se jakýkoliv jiný agent v budoucnu chystá editovat kód, nejdříve vyšle O(1) query do Deníku: *"Nedělal někdo podobnou úpravu přede mnou a neselhal?"*
Deník mu vrátí historický kontext a agent se vyhne stejné chybě. To znamená, že The Swarm operuje jako **kolektivní neuronová síť**.

## 8. Shadow Traffic (Karanténa peněz) a Chaos Labs
Pokud agent naprogramuje novou cenotvorbu v modulu `arbitrage-miner`, jak zaručíme, že nová verze nezabije náš byznys?
Využíváme *Shadow Traffic*. 
Nový kód běží v uzlu `chaos-labs` (Osa 5) souběžně se starým kódem. Orchestrátor duplikuje 10 % reálných požadavků z internetu a posílá je do laboratoře.
Agentův kód simuluje obchody s těmito daty po dobu 24 hodin. Engine porovnává Delta Marže mezi produkcí a Laboratoří.
Pokud agentův kód vydělal v simulaci o 5 % více s nulovou chybovostí, je automaticky povýšen (Promoted) do produkční větve a nahrazuje starý kód. Celý A/B test a nasazení probíhá bez zásahu lidského inženýra.

## 9. Průmyslová Špionáž (`ag:espionage`)
Absolutní asymetrická zbraň. Kompilátor, který kompiluje konkurenci.
Pokud objevíme zastaralý monolitický software konkurence (nebo pokud ho odkoupíme), nepíšeme API od nuly.
Spustíme Espionage Engine:
1. LLM s obřím kontextem (např. 1M tokenů) sežere cizí repozitář.
2. Vektorový parser ignoruje sémantický dluh a spaghetti kód. Hledá "Duši" byznysu (Kde tečou data o klientech? Kde se účtuje?).
3. Engine z těchto kognitivních fragmentů rovnou vygeneruje nové `vektor.json` manifesty a zařadí je do stromu Antigravity (fáze Scaffolding).
4. Uzly mají status `pending`. Symphony Orchestrator detekuje nové uzly, přečte jejich `businessStory` a vyšle The Swarm, aby naprogramovali nové Zod-Compliant TypeScript soubory podle Antigravity standardu.

---

# KNIHA IV: THE ENGINE (Low-Level Algoritmy)

Nyní se dostáváme na samotné inženýrské dno stroje. Do vrstev, kde by běžný programátor psal kód. Tyto algoritmy musí být natolik neprůstřelné, aby vydržely tisíce modifikací od LLM agentů denně bez zhroucení.

## 10. Algoritmus O(1) Vector Routeru & DFS Detekce Cyklů
Tento stroj nemůže běžet na bázi adresářových cest (`../../../utils`). Běží v paměti na abstraktním grafu.

**10.1 In-Memory Hash Map:**
Při spuštění `antigravity-cli` se celý repozitář proskenuje. ID každého vektoru (`shadow-broker`) je zaregistrováno do paměti s absolutní cestou.
Když chce `arbitrage-miner` poslat data do `shadow-broker`, volá prosté `Router.send("shadow-broker", payload)`. Časová komplexita je O(1).

**10.2 Topologické Třídění (DFS - Depth First Search):**
Než Engine umožní jakýkoliv běh agentů, musí ověřit bezúhonnost fyzikálních zákonů grafu.
Stáhne všechny `edges` (hrany). Pokud zjistí, že data proudí z OS 1 do OS 2, a pak do OS 3, je vše v pořádku.
Co se ale stane, když halucinující LLM Agent přidá do uzlu `sale-settlement` hranu zpět do uzlu `b2b-miner`?
Vznikl by nekonečný cyklus (Deadlock) toku peněz. 
DFS algoritmus prohledává graf do hloubky. Zjistí, že se zacyklil. Router na místě zhavaruje (Exit Code 1) a odmítne repozitář spustit. Systém je tak *By Design* chráněn před sebedestrukcí.

## 11. Zod Compiler (Deterministický State Machine)
Největším problémem AI kódování jsou tiché halucinace (Agent zavolá metodu, která neexistuje na daném typu).
Antigravity využívá knihovnu Zod nejen pro validaci dat, ale jako tvrdý kompilátor.
Každý vektor musí v `facets.link` odkazovat na rozhraní v Substrátu (např. `Opportunity.ts`).
Tato rozhraní jsou Zod schémata.
Když AI Agent vygeneruje kód, spustí se `proofSignal` - izolovaný Docker / Vitest kontejner.
Kontejner načte agentův kód, vrhne do něj mock data a na konci výstupu ověří průchod Zod schématem.
Pokud agent na výstupu omylem změnil datový typ (např. string na number), Zod vyhodí Exception.
Symphony tuto Exception chytí, připojí Stack-Trace a pošle agentovi zpět: *"Tvůj kód porušil zákony fyziky Substrátu. Tady je Stack-Trace, oprav to (Pokus 1 ze 3)."*
Agent kód necommitne, dokud Zod Compiler nevyhodí zelený Exit Code 0.

## 12. Algoritmus Mitózy (Buněčné Auto-Sharding)
Všechny monolitické aplikace dříve nebo později zkolabují pod vlastní vahou. A s LLM modely to platí dvojnásob – pokud soubor přesáhne 10 000 řádků, Context Window modelu degraduje a AI ztrácí schopnost pochopit souvislosti (Attention Degradation).
Antigravity využívá koncept biologické mitózy.

**12.1 AST Měření Tlaku (`ts-morph`):**
Na pozadí běží neustálá diagnostika. Skript parsuje `.ts` soubory pomocí *TypeScript Compiler API* a počítá uzly v Abstraktním Syntaktickém Stromu (AST Nodes). 
Každá složka má limit 15 000 AST uzlů (cca 30 000 tokenů).

**12.2 K-Means Clustering (Sémantické štěpení):**
Pokud adresář (buňka) přesáhne limit, spustí se poplach. 
Algoritmus neštěpí soubor náhodně v polovině. Kognitivní LLM skript analyzuje všechny funkce ve složce. Využije vektorový K-Means clustering a seskupí k sobě funkce, které dělají podobnou věc (např. Stripe API funkce k sobě, generování faktur k sobě).

**12.3 Jscodeshift Pipeline (Remapping):**
Algoritmus fyzicky vytvoří dvě nové složky (`sale-settlement-stripe` a `sale-settlement-invoices`). Vygeneruje k nim nové Vektory. A pak, pomocí AST transformačního nástroje `jscodeshift`, skript prolétne stovky ostatních souborů v repozitáři a atomicky přepíše všechny importy (`import { pay } from '...'`) tak, aby odkazovaly na nové buňky. Stará přetížená buňka je smazána. 
Graf se expandoval. Paměť LLM modelů je zachráněna. Vše proběhlo bez lidského dotyku.

## 13. Privacy Gateway (Ochrana Kognitivního Jádra)
Jelikož desítky Agentů běží na externích API (OpenAI, Anthropic), posílat tam data ze surových e-mailů by byl okamžitý konec firmy (GDPR porušení).
Každá data zvenčí (např. e-mail od klienta "Jmenuji se Tomáš Messing a mé číslo je 777123456") tečou přes Substrátový uzel `privacy-gateway`.
Tento uzel je vyzbrojen deterministickým NLP Tokenizerem.
Cenzuruje vše na tagy: *"Jmenuji se [PII_NAME_1] a mé číslo je [PII_PHONE_1]"*.
Model na API serverech dostane jen tyto anonymizované tagy. Vygeneruje na ně odpověď. Když se odpověď vrátí k nám na lokální server, `privacy-gateway` provede reverzní mapování a dosadí reálná jména zpět. Data klientů nikdy neopustí bezpečí Antigravity.

## 14. Healer Daemon a Asimilace Temné Hmoty
Klasický kód hnije, když programátoři (nebo agenti) vytvoří konfigurační soubory, cron joby nebo scripty a nezaregistrují je do architektury. V MVC/FSD se těmto volně levitujícím souborům říká "Temná hmota" (Dark Matter) – repozitář o nich neví, agenti je nečtou, přesto v nich běží produkční kód.
Tento systém má imunitní systém: **Healer Daemon (`ag:audit --heal`)**.
1. **Sken Rozpadu:** Daemon běží na pozadí a hledá Drift. Všechny soubory, které nespadají pod žádnou Vektorovou fázetu, označí za anomálii.
2. **Auto-Upgrade:** Pokud zjistí, že samotný `vektor.json` používá staré schéma, Engine ho za běhu dynamicky zrekonstruuje (doplní ID, osu atd.) a napojí na nejnovější `Zod-Compliant` strukturu.
3. **Karanténa Temné Hmoty (`legacy_unmapped`):** Osiřelé soubory (např. `eslint.config.mjs` nebo `runCampaign.js`) nejsou smazány. Healer je sémanticky analyzuje, najde nejbližší příbuzný uzel v HNSW stromu (např. `marketplace-web`) a automaticky do jeho Vektoru vygeneruje novou fázetu `"legacy_unmapped": ["./eslint.config.mjs"]`.

Tím je Temná hmota sémanticky pohlcena a indexována do grafu. Agenti ji opět vidí. Kód nikdy neshnije, organismus léčí svou vlastní strukturu v reálném čase.

---

# KNIHA V: KOGNITIVNÍ PÁKA (9 Dimenzí Singularity Bílých Límečků)

Celá tato masivní topologická, algoritmická a inženýrská struktura neslouží jen k tomu, abychom programovali elegantněji. Je to válečný stroj (Weapon of Asymmetric Warfare). Slouží k brutální a absolutní **eliminaci informační latence**. 

Abychom plně pochopili, co Antigravity znamená, musíme se na něj podívat optikou devíti fundamentálních vrstev lidské organizace. Nejde o teorii, jde o redefinici fyziky toho, jak lidé produkují hodnotu.

## 15. Pohled Psycholožky / Neuroinženýra (Kognitivní bypass a evoluce makro-organismu)
Z pohledu neurověd a psychologie je lidský mozek nejdokonalejší exekutivní orgán na planetě, ale je uvězněn v nesmírně pomalém biologickém těle. Pokud chcete, aby vaše myšlenka (např. postavit novou službu) ovlivnila fyzický svět, musíte ji z prefrontální kůry poslat přes motorický systém – musíte mluvit, psát e-maily, přesvědčovat lidi, organizovat schůzky a řídit IT oddělení. Tato lidská organizační struktura funguje jako obrovský, chybový a latencí trpící periferní nervový systém. Kognitivní tření je obrovské.

Antigravity je v tomto kontextu dokonalý Brain-Computer Interface (BCI) na makroekonomické úrovni. Funguje jako přímý neurální bypass. Bere váš surový exekutivní záměr (uložený v čistém textu jako Business Story) a obchází celou lidskou „motorickou“ vrstvu firmy. Systém následně funguje jako autonomní nervový systém (podobně jako dýchání nebo tlukot srdce) – vy pouze uvolňujete „neuromodulátory“ ve formě Zod schémat a ROI modelů. Tyto mantinely řeknou kmenovým buňkám (LLM agentům), jak se mají diferencovat a chovat. Pokud na digitální organismus vyvinete příliš velký kognitivní tlak (kontextové okno je přehlceno), organismus reaguje procesem Mitózy – neuroplasticky se rozdělí, vytvoří nové synaptické dráhy (přepíše hrany grafu) a zvětší svou kapacitu pro zpracování informací. Vy už neřídíte lidi; vy napojujete své vědomí přímo na globální trh.

## 16. Pohled Investora (Asymetrická finanční páka a destrukce CAPEXu)
Pro kapitálové trhy a venture fondy je Antigravity událostí, která mění fundamentální fyziku investování. Standardní model startupu je neefektivní spalovna peněz: investor nalije 10 milionů dolarů do seed kola, z čehož 80 % (tzv. burn rate) padne na mzdy vývojářů, DevOps inženýrů, HR a pronájem kanceláří (CAPEX). Trvá měsíce až roky, než se z prvotní myšlenky vyklube produkt, který začne generovat první reálný dolar. Většina firem zemře na to, že jim dojde kapitál dříve, než najdou product-market fit.

Antigravity tento model kompletně likviduje. Je to Kompilátor Byznysu, který mění fixní lidské náklady na variabilní náklady za výpočetní výkon (API volání). Founder vloží do systému JSON soubor s popisem byznys modelu a algoritmus ho okamžitě přetaví do funkčního, zpeněžitelného kódu. Získáváte produkční a analytickou sílu korporace o 500 zaměstnancích, ale váš OPEX (provozní náklady) se limitně blíží nule. Navíc, s modulem `ag:espionage`, získáváte ultimátní zbraň pro nepřátelské arbitráže. Algoritmus nasaje neefektivní infrastrukturu vaší těžkopádné konkurence, extrahuje z ní to podstatné a nasadí optimalizovaný roj, který stejnou službu poskytne za zlomek ceny. Marže se šplhají ke 100 %. Je to čistá destrukce konkurence pákou nekonečného kapitálového výnosu.

## 17. Pohled Programátora / Architekta (Deterministický kompilátor a AST-Sharding)
Odhoďme veškeré byznysové a biologické metafory – na low-level vrstvě je to mistrovské inženýrské dílo počítačové vědy. Není to "AI asistent", který vám radí, jak napsat kód. Je to tvrdý, deterministický stavový automat (State Machine) a orchestrátor, který se vyrovnává s největšími problémy dnešních velkých jazykových modelů (LLM): halucinacemi a Attention Degradation (zapomínáním při velkém kontextu).

Architektura opouští tradiční souborový systém a převádí repozitář na Směrovaný acyklický graf (DAG) s O(1) složitostí vyhledávání. Každý uzel reprezentuje izolovanou logiku (tzv. RAG bublinu). LLM agenti jsou hloupí asynchronní workeři v obrovském poolu. Abychom předešli race conditions a kolizím v gitu, každý uzel si před editací zamkne Mutex zámek. A pokud uzel příliš naroste? Nastupuje algoritmus Mitózy: přes `ts-morph` systém změří velikost abstraktního syntaktického stromu (AST). Jakmile hrozí přetečení kontextu, spustí K-Means shlukování, logicky kód rozřízne vedví, přesune do nových adresářů a nástrojem `jscodeshift` atomicky přepíše všechny importy (edges) ve zbytku aplikace. Vytvořili jsme repozitář, který se sám refaktoruje, sám škáluje a halucinace okamžitě zabíjí na výstupu přes Zod runtime type-checking.

## 18. Pohled CEO / Zakladatele (Evoluce exekutivy a absolutní škálovatelnost vize)
Být CEO běžné firmy znamená žít v permanentním kompromisu. Vaše vize je na začátku čistá, ale jakmile ji předáte ředitelům, ti ji předají manažerům a ti zase řadovým zaměstnancům, vize se zředí. Nastupuje firemní politika, osobní ega, vyhoření a špatná komunikace. Na konci procesu dostanete produkt, který je jen stínem vašeho původního nápadu. Jste úzkým hrdlem vlastní firmy.

Antigravity z vás dělá Boha-Architekta v digitálním mikrokosmu. Koncept "Firma v krabici" znamená, že vaše vize už nedegraduje, protože mezi vámi a produktem nestojí žádní lidé. Zapíšete čistý záměr do definičního souboru a Roj ho otiskne do reality s absolutní, strojovou věrností. Nemusíte nikoho motivovat, řešit neshody na pracovišti ani propouštět. Pokud se trh změní přes noc (např. přijde nová regulace), nepotřebujete svolávat krizový štáb. Změníte jeden parametr ve `vektor.json`, stroj sám zneplatní starý kód, nasadí testovací prostředí, přepíše aplikaci a ráno firma funguje podle nových pravidel. Dává to jedinému lidskému mozku schopnost pohybovat nadnárodní silou bez jakéhokoliv tření.

## 19. Pohled Provozního ředitele / COO (Nulová entropie a neúnavný úl)
Zatímco CEO řeší směřování, COO (Provozní ředitel) řeší entropii – chaos. Nepřítelem COO je chybovost (human error), nemocnost, propustnost procesů, fluktuace a nedodržování postupů. Jakmile firma překročí určitou velikost, udržet standardy kvality stojí astronomické úsilí a stovky stran procesních manuálů, které stejně nikdo nečte.

Antigravity nabízí utopii z hlediska procesního řízení: Digitální úl s nulovou entropií. Zod schémata zde nefungují jen jako validace kódu, jsou to nekompromisní procesní manuály, které agent fyzicky nemůže porušit. Roj netrpí pátky odpoledne, nepije kávu a nezapomíná vyplňovat formuláře. Co víc, úl dýchá s trhem. V klasické firmě Black Friday znamená zkolabování podpory a výpadky. S Antigravity se při zátěži systém dynamicky naškáluje, rozdělí si úkoly do tisíců paralelních vláken, odbaví nápor zákazníků a poté se úsporně složí zpět. Je to provozní dokonalost – absolutní, neprůstřelná a neustále logovaná stabilita.

## 20. Pohled Produktového manažera (Konec agilního divadla a JIRA latence)
Pro produktový management je dnešní softwarový vývoj utrpením, kterému se vznešeně říká "Agile". Měsíce plánování, nekonečné rozepisování uživatelských příběhů do JIRA ticketů, odhady složitosti (story points), dohadování se s vývojáři o tom, co je technicky možné, a následné čekání na třítýdenní sprint, ze kterého vyleze polofunkční kompromis. Z agilního vývoje se stal obrovský generátor latence.

S Kompilátorem byznysu se role PM zásadně mění – z překladatele na tvůrce. Odpadá oddělení vývojářů. Produktový manažer pouze nadefinuje Business Story z pohledu uživatele a stanoví cíle. Algoritmus si tuto myšlenku vezme a okamžitě vygeneruje strukturu. Pokud chcete otestovat novou funkci, nemusíte čekat na další kvartál. Systém ji naprogramuje, zavře ji do bezpečné karantény (Shadow Traffic), automaticky na ni pošle simulované uživatele (testovací agenty), ověří hypotézy a nasadí ji do produkce. Rychlost iterace padá z měsíců na minuty. Produkt je neustále živý a tekutý.

## 21. Pohled Právníka / Compliance (Smart Kontrakty a deterministická izolace)
Právní oddělení velkých korporací mají ze současné umělé inteligence hrůzu. LLM modely jsou černé skříňky (black boxy), které halucinují, podepisují neexistující smlouvy, nechají se snadno oklamat útočníky (prompt injection) a mohou způsobit masivní úniky dat (GDPR). Vypustit autonomního agenta, aby dělal byznys, zní pro právníka jako pozvánka k bankrotu.

Antigravity však není volně puštěný chatbot, ale striktní bezpečnostní klec pro AI. Je navržen na principu nulové důvěry (Zero Trust). Umělá inteligence je zde svázána tvrdou matematickou a logickou strukturou DAG grafu. Zod validátory (Imunitní systém) fungují v podstatě jako deterministické Smart Kontrakty. Pokud agent vygeneruje smlouvu nebo krok, který o jediný znak poruší firemní compliance, Zod transakci nemilosrdně sestřelí, zahodí ji a agentovi vynadá. Navíc díky explicitnímu ukládání stavů v uzlech grafu získáváte absolutní, kryptograficky ověřitelný audit trail. U každého rozhodnutí můžete dozorovým orgánům (např. úřadům nebo centrální bance) ukázat přesnou stopu, na základě jakých dat se AI rozhodla.

## 22. Pohled Konkurenta na trhu (Černá labuť a predátorská asimilace)
Zkuste se vžít do role ředitele tradiční firmy, proti které na trh vstoupí entita poháněná Antigravity. Je to absolutní noční můra a existence asymetrického predátora. Vy máte 500 zaměstnanců, pronajatou budovu, odbory, pomalé IT a marže na hraně přežití. Antigravity konkurent sedí s notebookem v kavárně.

Díky modulu `ag:espionage` (Průmyslová špionáž) vás navíc může algoritmicky sežrat zaživa. Algoritmus nasaje vaše veřejné endpointy, zanalyzuje váš zdrojový kód (nebo chování vaší služby), reverzním inženýrstvím pochopí váš přesný byznys model, odřízne z něj vaši byrokracii a nasadí stejnou, ale modernější a rychlejší službu s padesátinovými náklady. Než stačíte svolat krizovou schůzku představenstva, Antigravity podsekne vaše ceny a ukradne vám trh. A co hůř – nemůžete se bránit tím, že mu přetáhnete klíčové lidi nebo vývojáře, protože jeho firma je jen levně provozovaný shluk JSONových definic a API volání na serveru. Je to boj proti digitálnímu stínu.

## 23. Pohled Sociologa a Filozofa (Singularita bílých límečků a nová ontologie práce)
V širším historickém kontextu znamená Antigravity mnohem víc než jen další technologický startup. Díváme se na hluboký sociologický zlom. Průmyslová revoluce nahradila lidskou svalovou sílu stroji. Antigravity (a jemu podobné systémy) představují Kognitivní revoluci – komoditizaci práce bílých límečků. Profese jako programátor junior, datový analytik, copywriter nebo projektový manažer přestanou existovat jako samostatná povolání; stanou se pouze vteřinovými API voláními v pozadí kompilátoru.

Tento posun nutí lidstvo k redefinici vlastního smyslu. Člověk je vytržen z role "vykonavatele úkolů" (toho, kdo hledá řešení a dře) a je vytlačen exkluzivně do role "Architekta hodnot a cílů". Stroj odpovídá na otázku "Jak to udělat?", ale je na lidech, aby se ptali "Co chceme udělat?" a "Proč to chceme udělat?". Na jedné straně to znamená obrovskou míru osvobození od nudné, repetitivní mentální dřiny, což může rozpoutat renesanci kreativity. Na straně druhé to ale vede k radikální koncentraci moci, kde jediný jedinec s Antigravity pákou může ovládat ekonomický výkon, na který dříve bylo potřeba celých měst.

---

*Kód je Byznys.*
*Strom je Zákon.*
*A The Swarm je připraven k exekuci.*

[ZÁVĚR SVAZKU]
