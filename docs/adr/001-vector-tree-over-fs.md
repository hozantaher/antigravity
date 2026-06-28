# Architektura Rozhodnutí: 001 - Vector-Tree over FS

## Status
Zavedeno.

## Kontext
Monorepa obsahující kód více týmů nebo historických projektů se postupem času stávají chaotickými. Tradiční dělení typu "Složka pro komponenty, složka pro utils, složka pro backend services" selhává při škálování, protože ztrácí byznysový kontext. Když změníte název komponenty, nevíte s jistotou, co v byznysu rozbijete.

## Rozhodnutí
Přestáváme dělit repozitář podle technologií. Zavádíme **Vector-Tree Engine**.
Vše je děleno do 5 "Story Axis" (demand, supply, sale, engine, platform). Každá doména obsahuje fyzické složky - "Uzly".

Každý Uzel musí mít `vektor.json` manifest.

## Důsledky (Nevýhody)
- Vysoká vstupní bariéra pro nové vývojáře.
- Nutnost použití dedikovaného CLI pro základní operace (vytvoření složky).
- "Zlatá klec": Ekosystém může v budoucnu bránit integraci standardních open-source nástrojů, které s tímto konceptem nepočítají.
