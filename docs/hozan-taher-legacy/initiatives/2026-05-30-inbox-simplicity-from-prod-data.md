# Zjednodušení podle reálných produkčních dat

- **Status:** Active
- **Datum:** 2026-05-30
- **Trigger:** Standing directive — sleduj real-time prod data, generuj stories, cíl jednoduchost ("nepřidávej, vylepšuj, zjednodušuj"). Expand fáze proběhla čtením PROD DB (junction.proxy.rlwy.net / outreach).

## Co reálná data říkají (expand)

Snímek PROD k 2026-05-30 (read-only SELECT):

| Signál | Číslo | Co to znamená |
|---|---|---|
| reply_inbox positive **unhandled** | **52** | hot leads (firma chce prodat techniku) leží netknuté |
| unmatched_inbound **pending** | **118** | orphan odpovědi bez triáže, nejstarší **19 dní** (2026-05-11) |
| campaigns total / **reálné** | 226 / **1** | 225 má prázdný status, 0 created_at, 0 sends, 166 jmenem "test" → junk |
| send_events posledních 14 dní | **0** | odesílání vypnuté (DISABLE_CAMPAIGN_DAEMON=1) |
| contacts | 405 591 | obrovský prospect pool |
| vehicles | **0** | feature v primary nav bez jediného záznamu |
| mailboxes active (production) | 3 | reální odesílatelé |

Závěr: operátorovo jádro práce = **triáž příchozích hot leadů**, a ta má rostoucí backlog. Zároveň UI tone leady "topí" v šumu (226 kampaní, prázdná vozidla).

## Stories (contract)

### S1 — Hot-lead triage je střed gravitace ✅ HOTOVO (2026-05-30)
**Proč:** 52 unhandled positive + 118 pending unmatched (19 d staré). To je byznys (Garaaage výkup techniky).
**Jak (vylepšeno, ne přidáno):** `/api/dashboard/summary` nově vrací `positive_unhandled`; Home karta "Nezpracované odpovědi" zobrazí nepřehlédnutelný řádek "🔥 N hot leadů čeká" (zelený, urgentní) s jedním klikem na `/replies?classification=positive&handled=false`. Skryje se když 0.
**Ověřeno:** BFF curl vrací `positive_unhandled: 52` (PROD); 2 unit testy (zobrazí při >0 + deep-link, skryje při 0); build green. *(Živé Playwright ověření blokováno headless-auth — X-API-Key gate; server + client wiring potvrzeny jinak.)*
**Zbývá:** ekvivalent na samotné /replies stránce (řazení/zvýraznění unhandled-positive) — kandidát na další průlet.

### S2 — Odšumění seznamu kampaní ✅ HOTOVO (2026-05-30)
**Proč:** 225 z 226 kampaní = prázdný status / 0 created_at / 0 sends = legacy junk; topí jednu reálnou kampaň.
**Jak:** `/campaigns` default skrývá nekonfigurované (blank/null status); chip "Nekonfigurované (N)" je odhalí. Žádné mazání PROD dat.
**Ověřeno živě:** default 226 → **1** řádek; chip "Nekonfigurované 225" → klik odhalí. Unit testy + build green.

### S3 — Prázdná vozidla v primary nav
**Proč:** vehicles = 0 řádků, ale `/vehicles` je v primary nav (denní slot). Prázdná stránka = "FE není 100% funkční" dojem.
**Jak (volba na operátorovi):** buď (a) silný empty-state s CTA "zachyť první deal z odpovědi", (b) seed demo dat pro testovatelnost, nebo (c) přesun z primary nav do Setup dokud nejsou dealy. Doporučení: (a) + případně (c) — žádné nové featury.

## Chybějící testovací data (seeds)
- **vehicles**: 0 řádků → smoke spec (`vehicles-detail.smoke.spec.ts`) jede jen na stubu; pro lokální demo chybí seed. Kandidát na `tests/_fixtures/seeds/`.
- **reply_inbox positive-unhandled**: pro lokální vývoj S1 se hodí seed s ~10 unhandled positive.

## Sprint pořadí
1. **S2** (hotovo)
2. **S1** — hot-lead signál na Home (hotovo)
3. **S3** — vehicles empty-state (hotovo: stat-strip skryt když 0, dead checkbox column smazán)
4. seeds pro S1/S3 lokální vývoj

## Verified backlog z 30-agent průletu (2026-05-30, iter2)

**Produktové rozhodnutí (čeká na operátora — data silně podporují):**
- **Default sort unmatched tabu = nejstarší první** (67 položek >7 dní). Verifieři jednomyslní: FIFO clearing chce ASC, ale je to změna chování → potvrdit. Soubory: `replies.js:86` + `useRepliesUrlState.js:42`.
- **Hot-lead default sort** na /replies (unhandled tab → positive první). Bezpečnější varianta: deep-link z Home nese `&sort=classification&dir=asc`.

**Safe follow-up (vyžaduje péči/testy):**
- **Aging badge** v unmatched řádku pro >7d (reuse `AgeChip`, ne nová funkce). Biggest backlog signál.
- **RepliesChat `useReplyCompose(selectedId)`** — draft persistence rozbitá; pozor na koordinaci s reset-on-switch effectem (restore vs reset se perou) → potřebuje testy.
- **CRM sync gap**: `crmMatchStatus.js` endpointy (`/api/crm/match-status`, `/backfill-run`) NEjsou mountnuté + bez UI; jen 0.5% kontaktů linkováno. Autonomní `runCrmBackfillCron` už syncuje → endpoint je buď dead-code, nebo chybí "Sync CRM" UI. Rozhodnout: autonomní-only (smazat orphan) vs operátorský button.
- **CampaignDetail `launchIntent`** vždy 'resume' → dead else branch + unused state; smazat JEN pokud send-batch definitivně archivován (produktová nejednoznačnost).

**Low-risk hygiene (dedup):** sdílený `clampInt`/`parseIntParam` (45+ výskytů), `formatNumber`/`formatDateTime` (30+ `toLocaleString('cs-CZ')`), Home inline-style konstanty.
