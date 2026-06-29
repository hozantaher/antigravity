# Antigravity Vector-Tree (Deep Inventory)

Tento dokument zachycuje "Expanded Deep Inventory" – detailní rozpad sémantických vrstev (Core, Body, Brain, Hands) do struktury fyzických uzlů (složek). Slouží jako referenční mapa pro orientaci v rozsáhlém byznysovém enginu.

```text
Antigravity Vector-Tree [Expanded Deep Inventory]
│
├── 🏛️ CORE (Zákon a Ochrana)
│   └── spine/domain/core-types
│       ├── schemas.ts         [ Zod Runtime Validátory ]
│       └── interfaces.ts      [ Generované TypeScript typy ]
│
├── 🌍 BODY (I/O a Tržiště)
│   ├── frontiers (Sběrače z cizích webů)
│   │   ├── scraper-mobile-de
│   │   ├── scraper-mascus-cz
│   │   ├── scraper-autoline
│   │   ├── scraper-firmy-cz
│   │   ├── scraper-judikaty
│   │   └── scraper-esbirka
│   │
│   ├── spine/supply (Nabídka a Katalog)
│   │   ├── auction-items      [ Výkladní skříň ]
│   │   ├── bidding            [ Mechanika dražby a soft-close ]
│   │   ├── media-upload       [ Fotky a 360° ]
│   │   └── vehicle-vin        [ Dekódování techničáku ]
│   │
│   ├── spine/demand (Poptávka a Retence)
│   │   ├── search             [ Facetované vyhledávání a diakritika ]
│   │   ├── recommendation     [ CTR scoring a Fallback rail ]
│   │   ├── saved-search       [ Cron a CAS zámky pro alerty ]
│   │   ├── messaging          [ Veřejné Q&A inzerátů ]
│   │   ├── ratings-reviews    [ Post-sale hodnocení ]
│   │   └── newsletter-email   [ Kurátorská e-mailová retence ]
│   │
│   └── apps (Klientské GUI)
│       ├── marketplace-web    [ Frontend pro kupce ]
│       └── operator-console   [ Frontend pro back-office ]
│
├── 🧠 BRAIN (Abstrakce, Učení a Rozhodování)
│   ├── spine/engine/learn (Učení a abstrakce)
│   │   ├── html-cleaner       [ Odstranění šumu a reklamy z DOMu ]
│   │   ├── llm-connector      [ API pro telepatické volání modelů ]
│   │   └── zod-guard          [ Stráž před LLM halucinacemi ]
│   │
│   ├── spine/engine/automation (Paměť a Workeři)
│   │   ├── rule-registry      [ Uložená vygenerovaná AST pravidla ]
│   │   ├── symphony-queue     [ Hlavní asynchronní Redis fronta ]
│   │   └── worker             [ Samotný běžící proces ]
│   │
│   ├── spine/engine/intelligence (Arbitráž)
│   │   ├── arbitrage-miner    [ Skórování a odhalování "ležáků" ]
│   │   │   └── cross-border   [ Clo, kurz a přeshraniční kalkulace ]
│   │   ├── parser-compiler    [ Generátor selektorů z HTML ]
│   │   └── relay
│   │       ├── provider-router[ Výběr nejlepšího modelu ]
│   │       └── rate-limiter   [ Záchranná brzda rozpočtu ]
│   │
│   ├── spine/acquisition (Hledání leadů)
│   │   ├── classify-icp       [ Skórování přes NACE a velikost ]
│   │   ├── firmy-cz           [ Normalizace dat z tržišť ]
│   │   ├── ares-source        [ Zdroje pravdy z úřadů ]
│   │   └── email-validation   [ Pětifázový filtr mrtvých adres ]
│   │
│   └── spine/inbound (Třídění příchozích reakcí)
│       ├── imap-poll          [ Tichý sběr pošty ]
│       ├── reply-classify     [ LLM detekce (zájem vs. auto-reply) ]
│       ├── thread-match       [ Napárování na vlákno klienta ]
│       └── bounce-detect      [ Zachycení MAILER-DAEMON výjimek ]
│
└── 🦾 HANDS (Exekuce, Zápis a Peníze)
    ├── spine/engine/drive (Automatické transakce mimo systém)
    │   └── shadow-broker      [ Stínové zakládání inzerátů a nabídek ]
    │
    ├── spine/outreach (Cold Mailing)
    │   ├── campaign-scheduler [ Tikot podle pracovní doby a zón ]
    │   ├── content-render     [ Spintax a personalizace ]
    │   ├── anti-trace         [ Mullvad egress, jitter, šifra ]
    │   ├── warmup             [ IP zahřívání pro doručitelnost ]
    │   └── send-dedup         [ CAS pojistka proti double-sendu ]
    │
    ├── spine/sale (Zúčtování peněz)
    │   ├── deposit-billing    [ Vratné kauce pro přístup do ringu ]
    │   ├── sale-settlement    [ Finální zúčtování a doplacení ]
    │   ├── invoicing          [ Proformy a daňové doklady ]
    │   └── disputes-complaints[ Řešení sporů ]
    │
    ├── spine/compliance (Právní exekuce)
    │   ├── audit-log          [ Neodstranitelná stopa u transakcí ]
    │   ├── dsr                [ Atomický PII výmaz napříč DB ]
    │   ├── suppression        [ Blacklist domén a adres ]
    │   └── unsub-token        [ HMAC podpis pro one-click odhlášení ]
    │
    └── spine/platform (Infra exekuce a údržba)
        ├── admin, api-tokens, mcp, notifications, worker-pdf, atd.
```

### Přínos této organizace
1. **Předvídatelnost:** Kognitivní uzly (Brain) jsou striktně izolovány od fyzické exekuce na Stripe/IMAP (Hands).
2. **Snadný Onboarding:** Nový scraper nebo API brána vždy míří do `frontiers`, nikoliv do jádra logiky.
3. **Asymetrické Škálování:** Engine umožňuje napárovat desítky tupých `frontiers` na jeden výkonný `arbitrage-miner` mozek.
