# Developer Workflow

Základní inženýrský postup v repozitáři Antigravity.

## Zákaz `mkdir`
Zapomeňte na ruční vytváření složek. Antigravity spoléhá na přesně mapovaný vektorový strom. Pokud vytvoříte složku ručně a zapomenete do ní vložit `vektor.json`, Cybernetic Governor váš kód odmítne (při commitu nebo buildu).

Vždy používejte CLI pro scaffolding.

## Typický průběh práce
1. Zjistím, že potřebuji vytvořit novou byznys logiku (např. generování faktur).
2. Rozhodnu se, do jaké osy patří (patří do `sale/checkout`).
3. Spustím CLI k vytvoření uzlu: `node dist/index.js create invoicing sale/checkout/invoicing`
4. CLI vygeneruje složky a připraví manifest.
5. Napíšu logiku do vygenerovaných složek.
6. Pomocí magických komentářů propojím uzel s externím frameworkovým kódem (pokud je potřeba).
7. Spustím `node dist/index.js audit --heal` ke kontrole driftu.
8. Commituji.
