# Email ↔ systém: data mining a hardening komunikace

> **Status:** Active
> **Datum:** 2026-06-01
> **Trigger:** Operátor — "potřebujeme provést hardening a data mining mezi emaily
> a systémem, vytěžit mnohem více a vystavět mnohem robustnější komunikaci."

## Proč

Dnes inbound email **uložíme, ale netěžíme**. Z odpovědi vytáhneme klasifikaci
(keyword + LLM `pre_classification`), přílohy (bajty u matched), bounce metadata
a atribuci (contact/campaign/mailbox). **Tělo zprávy ale leží v `reply_inbox.body_text`
jako surový text** — žádné entity z něj nevytahujeme. Přitom celý byznys je
**výkup techniky, kde deal řeší operátor telefonem** (memory
`project_vehicle_auction_intake`). Telefon, cena, specifikace stroje a lokalita
jsou v těch emailech — jen je nečteme strojově.

Druhá osa: **robustnost ingestu.** Pipeline je solidní (idempotence, dedup,
quoted-reply strip na BFF straně), ale má díry, které tiše degradují kvalitu —
prázdné tělo bez HTML→text fallbacku, poškozený charset bez signálu, bounce na
alias adrese co nesuppressne kontakt.

## Co dnes vytěžíme (baseline)

| Signál | Kde uložen |
|---|---|
| Klasifikace (keyword) | `outreach_messages.sentiment` / operator `reply_inbox.classification` |
| Intent + confidence (LLM Haiku, AC8) | `reply_inbox.pre_classification` jsonb |
| Přílohy (metadata + bajty u matched) | `reply_inbox.attachments_meta` + `reply_inbox_attachments` |
| Bounce (DSN parse) | `outreach_messages.bounced_at` + contact `bounce_hold` |
| Atribuce (4-rung ladder) | `reply_inbox.contact_id/campaign_id/mailbox_id` |
| Tělo (plain + HTML) | `reply_inbox.body_text/body_html` — **surové, netěžené** |

Vozidlo se z emailu **neauto-extrahuje** — operátor ho zakládá ručně z dashboardu.

## GAPS — co těžit navíc (data mining)

Seřazeno podle hodnota/úsilí pro výkup techniky.

### Sprint M1 — rychlé deterministické signály (regex, S)
Vytáhnout z `reply_inbox.body_text` (po stripnutí quoted textu):
1. **Telefonní čísla** (CZ formáty: `+420`, `0xx`, mezery/pomlčky). **Nejvyšší
   hodnota** — operátor potřebuje zavolat; telefon je v podpisu/těle. *(story M1.1)*
2. **Ceny v CZK** ("cena ...", "za ... Kč", číslo + Kč/CZK). Anchoring pro
   vyjednávání. *(M1.2)*
3. **Lokalita / město / kraj** (CZ místní jména + ARES obce). Logistika svozu. *(M1.3)*
4. **Urgence + žádost o callback** ("zavolejte", "do konce týdne", "spěchá").
   Priorita ve frontě. *(M1.4)*

Uložení: lehký `reply_inbox.mined` jsonb + `mined_at`; doména je relativní/rozšiřitelná.

### Sprint M2 — podpis a obohacení kontaktu (M)
5. **Parsing podpisu**: jméno, funkce/titul, mobil, alternativní e-mail, firma,
   adresa, IČO/DIČ. *(M2.1)*
6. **Obohacení kontaktu z odpovědi**: vytěžený telefon → `contacts.phone`
   (dnes sloupec chybí), funkce → seniorita rozhodovatele. *(M2.2)*
7. **Entity-linking**: `reply_inbox` ↔ `vehicle` ↔ `crm_clients` (dnes jen
   přes email; doplnit přes telefon/IČO/firmu). *(M2.3)*

### Sprint M3 — strojové specifikace a fotky (M/L)
8. **Specifikace stroje z těla**: značka, model, rok výroby, motohodiny, stav. *(M3.1)*
9. **Foto-inteligence**: kvalita, ukazuje stroj?, viditelné poškození (vision). *(M3.2)*
10. **OCR dokumentů** (faktury/STK/VIN z PDF/obrázků). *(M3.3 — odloženo)*

## EDGE CASES — hardening ingestu

Seřazeno podle závažnosti (data-loss / mis-classification první).

### Sprint H1 — kvalita klasifikace (HIGH)
- **H1.1 body_len=0 bez HTML→text fallbacku.** Když plain tělo prázdné ale
  HTML existuje, klasifikátor vidí prázdno → mis-classify na neutral, hot lead
  zmizí. Fix: HTML→text fallback v MIME parseru / na vstupu klasifikátoru.
- **H1.2 poškozený charset bez signálu.** Best-effort transkódování existuje,
  ale není `corrupted_charset` flag → operátor nepozná mojibake. Fix: detekce +
  flag v klasifikaci.
- **H1.3 bounce na alias adrese.** DSN recipient `foo+alias@d.cz` nematchne
  `foo@d.cz` → kontakt se nesuppressne, verify loop pálí na mrtvou adresu. Fix:
  fuzzy email match (strip +alias) jako poslední rung.

### Sprint H2 — viditelnost a edge coverage (MEDIUM)
- **H2.1 OOO ve forwardu** ("FW: Nepřítomnost" + tělo reálné odpovědi) — subject-
  only check nestačí.
- **H2.2 AC8 async UPDATE fail bez audit stopy** — operátor nepozná "nezkusilo se"
  (NULL) od "zkusilo, DB selhalo" (taky NULL).
- **H2.3 multi-reply ve vlákně** — ověřit determinismus "poslední akce vyhrává" testem.

### Už ošetřeno (neřešit bez incidentu)
Idempotence (LRU + schema 3-tuple dedup), quoted-reply strip (BFF), zero-byte
přílohy (skip + metadata), UID watermark (UIDVALIDITY reset + idempotent re-fetch),
secretary reply (In-Reply-To ladder + ICO-unique domain fallback).

## Pořadí prací

1. **M1.1 telefon mining** — první slice (nejvyšší hodnota, operátor volá). Shipnuto v tomto bloku.
2. M1.2–M1.4 ceny/lokalita/urgence — dotáhnout deterministický extractor.
3. H1.1 + H1.3 — hardening klasifikace (nejdřív měřit dopad na reálných datech).
4. M2 podpis + obohacení kontaktu.
5. M3 specs + vision.

Edge cases mají regresní/property testy; data-mining extraktory mají unit testy
nad reálnými vzorky (žádné fabrikované — memory `feedback_no_fabricated_test_data`).
