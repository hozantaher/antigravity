# 📖 Slovník Pojmů (Glossary)

Tento dokument je automaticky generován z `@terminology` tagů v TSDoc komentářích.

### ArbitrageOpportunity
Reprezentuje nalezenou příležitost na trhu (inzerát), kde  odhadovaná hodnota od LLM je výrazně vyšší než nabízená cena.

*Odkazy (Zdroj pravdy):*
- `spine/domain/core-types/schemas.ts`

---

### DeltaEngine
Modul, který na úrovni Kognitivní a Fyzické vrstvy zahazuje data, která již byla zpracována, nebo posílá dál inzeráty s dynamicky se měnící cenou (zlevnění). Odlehčuje LLM frontu.

*Odkazy (Zdroj pravdy):*
- `spine/demand/acquisition/deep-inventory/delta-engine.ts`

---

### SelfHealingEngine
Kognitivní mechanismus schopný samostatně číst rozbité zdrojové HTML cizích inzertních portálů, osekat ho od šumu a využít LLM k rekonstrukci či vytěžení dat (a tím automaticky opravit scraper).

*Odkazy (Zdroj pravdy):*
- `spine/engine/learn/self-healing.ts`

---

### ShadowDraft
Rozpracovaný, neviditelný návrh inzerátu vytvořený naší Levou hemisférou. Prodejce ho uvidí až po kliknutí na Magic Link.

*Odkazy (Zdroj pravdy):*
- `spine/domain/core-types/schemas.ts`

---

