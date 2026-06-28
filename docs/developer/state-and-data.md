# State & Data (Kritický bod)

Vektorový strom skvěle funguje na organizaci kódu a logiky. Ale co databáze? Jak si povídají různé uzly mezi sebou, když mají být izolované?

## Řešení datové persistence
Tento dokument v současné fázi migrace představuje jeden z nejdůležitějších **otevřených problémů**. 

Zatímco UI komponenty jsou krásně sémanticky umístěny, databázová vrstva se v typické architektuře chová globálně (např. jedno velké Prisma schéma). 

*Tato stránka bude sloužit jako standard pro práci se sdíleným stavem a ORM, hned jak se tým (nebo architekt) shodne na standardizaci migrací v Antigravity enginu.*
