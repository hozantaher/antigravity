# 6 Pilířů (The Six Pillars)

Antigravity Engine se skládá z 6 autonomních subsystémů. 

## 1. Unified Vector Engine (Read & Context)
Algoritmicky prohledává strukturu do šířky (Graph BFS). Zajišťuje, že pokud agent/vývojář řeší problém v uzlu A, engine mu automaticky zpřístupní kontext i pro uzel B, se kterým uzel A sousedí (podle definice hran ve `vektor.json`).

## 2. Cybernetic Governor (Drift Detection)
Váš hlídač a léčitel.
Skenuje repozitář a hledá "drift" - např. pokud jste smazali soubor, na který vede odkaz, nebo použili import mezi moduly, který není povolený v manifestu.
Pomocí příkazu `audit --heal` dokáže většinu těchto prohřešků sám detekovat a opravit.

## 3. Transactional Refactoring
Přejmenování složek přes `mv` způsobuje motýlí efekt rozbitých importů. Tento engine řeší refaktoring atomicky: v jedné transakci přejmenuje složku a automaticky přepíše veškeré reverzní vazby napříč celým projektem.

## 4. Genesis Scaffolder (Creation)
Generátor kódu napojený na `node dist/index.js create`. Z cesty odvodí byznys doménu, založí složky, vloží manifest a předpřipraví základní šablony (tzv. stubs). Tím vynucuje standardizaci.

## 5. Fuzzy Metadata Router (Search)
Ultra-rychlý sémantický vyhledávač, který funguje lokálně. Hledáte "vyúčtování"? Router prohledá tagy ve `vektor.json` a vrátí přesný uzel bez použití externích API nebo složitých ML modelů.

## 6. Autonomous Diary Manager
Zapisuje veškeré provedené změny (refaktoring, scaffolding) do souboru `diary.md`. Tím se tvoří trvalá operační paměť projektu, ze které se později automaticky generují changelogy a sémantické verze.
