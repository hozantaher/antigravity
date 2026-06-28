# Začínáme (Getting Started)

Tato sekce vám pomůže rozjet projekt lokálně a seznámí vás se základními pravidly hry.

## Prerekvizity
- Node.js (v20+)
- npm

## Instalace

```bash
# Instalace závislostí
npm install

# Zkompilování projektu a kontrola architektonického driftu
npm run build
```

## Základní pravidla

Než začnete psát kód, zapamatujte si tato dvě svatá pravidla:

1. **Zákaz používání `mkdir`** - Nové složky se vytváří výhradně přes Antigravity CLI.
2. **Kód patří do Uzlů (Nodes)** - Byznys logika neleží v abstraktních technických složkách, ale přímo pod byznysovou osou (např. `spine/sale/checkout`).

Přejděte do sekce [Developer Workflow](/developer/workflow) pro praktickou ukázku, jak vyrobit první funkci.
