# Úvod do Antigravity

Antigravity není framework. Je to **Vector-Tree Engine**, nový způsob uvažování o tom, jak strukturujeme kód. 

Místo tradičního technického dělení (složky jako `components`, `controllers`, `services`) Antigravity převádí kódovou základnu do sémantické vektorové databáze, která přesně mapuje byznysové procesy (Velkou Pětku: `demand`, `supply`, `sale`, `engine`, `platform`).

## Problém, který řešíme
Tradiční monorepa s MVC / FSD strukturami se často stávají nezvladatelnými špagetami. Přesun složek rozbíjí importy, dokumentace zastarává a umělá inteligence (LLM) nerozumí byznysovému kontextu, protože složka `src/components/Button.tsx` jí neřekne nic o tom, k jakému byznysovému procesu dané tlačítko patří.

## Řešení: Vector-Tree
Každá složka v repozitáři (nazývaná **Uzel** / Node) má u sebe manifest `vektor.json`. Tento manifest spojuje lokální kód se vzdáleným kódem a vytváří tak plně provázaný graf, kterému rozumí člověk i stroj.
