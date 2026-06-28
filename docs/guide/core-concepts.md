# Klíčové koncepty

Zde je vysvětlení terminologie, kterou v repozitáři běžně potkáte.

## Uzel (Node)
Nejmenší sémantická jednotka. Je to fyzická složka na disku, která obsahuje kód k jedné konkrétní byznysové funkcionalitě. 
Každý uzel **musí** obsahovat soubor `vektor.json`.

## Osa příběhu (Story Axis)
Nejvyšší byznysová kategorie. Antigravity rozděluje repozitář na 5 základních os (tzv. Velká Pětka):
- `demand`: Vše, co přivádí uživatele (Akvizice, SEO, Marketing).
- `supply`: Inventář, který nabízíme (Zboží, Služby, Auta).
- `sale`: Tam, kde se Demand potká se Supply a vzniká transakce (Fakturace, Kauce).
- `engine`: Autonomní logika a automatizace.
- `platform`: Společná infrastruktura (Security, Compliance, Autentizace).

## Manifest (`vektor.json`)
Srdce každého uzlu. Zapisujeme do něj, do jaké osy uzel patří, v jakém je stavu a s čím dalším souvisí (tzv. hrany / edges).
Díky tomuto souboru nepotřebujeme složitou dokumentaci, strom se totiž generuje sám.
