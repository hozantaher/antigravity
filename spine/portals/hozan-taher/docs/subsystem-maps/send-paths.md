# Subsystem Map: Dual Send Path

**Status:** Aktivní  
**Datum:** 2026-05-06  
**Trigger:** Sprint H7 — potřeba zdokumentovat existenci dvou konkurenčních send cest před dalším vývojem  
**Citovaný HEAD SHA:** `66277810d01a74304aaf78abcc07a1027dba976a`

---

## Přehled

V systému existují dvě odlišné cesty pro odeslání e-mailů z kampaně. Obě čtou ze stejné tabulky `campaign_contacts`, obě odesílají přes anti-trace-relay, ale liší se ve zdroji šablony, způsobu spuštění a úrovni sekvence. Souběžné použití obou cest pro stejnou kampaň způsobí duplicitní doručení.

---

## Cesta A — Go daemon (scheduler)

**Soubor:** `features/outreach/campaigns/campaign/runner.go` (funkce `RunCampaign`, řádky 86–628; `NewRunner`, řádek 69)  
**Zdroj šablony:** soubory `.tmpl` na disku — čteny přes `content.Engine.Render()`, která volá `os.ReadFile(filepath.Join(templatesDir, name+".tmpl"))` (`features/outreach/campaigns/content/template.go`, řádky 85–86)  
**Spuštění:** automatické přes scheduler tick v Go orchestrátoru; kampaň musí mít status `running` nebo `active`  
**Sekvence:** plná podpora — víceúrovňová sekvence s `delay_days` mezi kroky, `current_step` tracking, `next_send_at` plánování  
**Mailbox pool:** čte ze `sending_config.mailbox_pool` v DB; round-robin distribuce  
**Audit log:** záznamy do `operator_audit_log` + slog s `op` polem

### Kdy použít cestu A

Produkční kampaně s plnou automatizovanou sekvencí (initial + followup_1 + followup_2). Scheduler běží 24/7 na Railway — operátor nesmí manuálně zasahovat do fronty, dokud kampaň běží.

---

## Cesta B — Node skript (operátorský)

**Soubor:** `features/platform/outreach-dashboard/campaign-send-batch.mjs` (řádky 1–202)  
**Zdroj šablony:** DB tabulka `email_templates` — čtena přes `SELECT subject, body FROM email_templates WHERE name = $1` (řádky 100–103)  
**Spuštění:** manuální operátorský příkaz z terminálu; kampaň může být ve stavu `draft`  
**Sekvence:** pouze první krok (`sequence_config[0]`); bez automatických follow-upů  
**Mailbox pool:** čte ze `sending_config.mailbox_pool` → dotazuje aktivní mailboxy → pre-probe proxy per mailbox  
**Audit log:** záznamy do `operator_audit_log` (řádky 178–185)

### Kdy použít cestu B

Ad-hoc ruční odeslání, rampování nové kampaně, situace kdy Go daemon není dostupný, nebo když obsah šablony byl upraven přímo v DB (bez nového deploy). Viz [`docs/playbooks/campaign-launch-runbook.md`](../playbooks/campaign-launch-runbook.md) pro kompletní postup.

---

## Kompatibilní matice

| Situace | Cesta A | Cesta B |
|---------|---------|---------|
| Produkční kampaň s automatickým follow-up | ✓ Správná volba | Pouze první krok, follow-up nevznikne |
| Ruční rampa nové kampaně | ✗ Vyžaduje `running` + spuštěný daemon | ✓ Správná volba |
| Obsah šablony upraven v DB bez deploy | ✗ Daemon čte `.tmpl` z disku | ✓ Čte přímo z DB |
| Go daemon není dostupný (Railway outage) | ✗ Nefunguje | ✓ Nezávislý na daemon |
| Plná sekvence s delay | ✓ | ✗ Pouze krok 0 |

---

## VAROVÁNÍ: Race condition při souběžném použití

Obě cesty sdílí frontu `campaign_contacts`. Pokud by Go daemon i Node skript běžely zároveň pro stejnou kampaň:

1. Oba procesy spustí `SELECT ... WHERE status = 'pending'` bez row-level lock.
2. Oba vidí stejné řádky jako pending.
3. Oba pošlou e-mail a označí `status = 'in_sequence'`.
4. Výsledek: duplicitní doručení jednomu příjemci.

**Operátor MUSÍ zajistit, že v daný okamžik pro danou kampaň běží pouze jedna cesta.**

Prakticky: při použití cesty B kampaň nesmí mít status `running` nebo `active` (daemon nepřevezme její kontakty pro plánování). Stav `draft` toto zaručuje.

### UPDATE 2026-06-22 — race je nyní strojově vynucen (migrace 152 `send_claims`)

Výše popsaný duplicitní-send scénář (kroky 1–4) je nyní **zablokován exactly-once
vrstvou**: obě cesty PŘED odesláním na relay atomicky nárokují
`(campaign_id, contact_id, step)` v tabulce `send_claims`
(UNIQUE constraint = mutex). První nárok vyhraje → odešle; druhá cesta dostane
`already_sent` / `in_flight_elsewhere` → **přeskočí** (žádné duplicitní doručení).
`send_events` má navíc partial-UNIQUE pojistku (`uq_send_events_sent_cstep`), takže
duplicitní `sent` řádek nemůže vzniknout ani kdyby brána selhala. Implementace:
`features/outreach/campaigns/sender/sendclaim.go` (Go) + `features/platform/outreach-dashboard/src/lib/sendClaim.js`
(Node twin) — viz [`anti-trace.md`](anti-trace.md) krok G9.5.

Doporučení „spusť jen jednu cestu" **stále platí** jako provozní hygiena (čistší
stav `campaign_contacts`, méně zbytečné práce), ale duplicitní *doručení* už není
závislé na operátorské disciplíně. Zbytkové okno: pád procesu mezi relay-202 a
lokálním confirm — uzavřel by jen Idempotency-Key v relay (odloženo).

---

## Drift riziko: rozdílné zdroje šablon

Cesta A čte z `.tmpl` souborů deployovaných s kódem (`features/outreach/campaigns/templates/`). Cesta B čte z DB tabulky `email_templates`.

Pokud operátor upraví šablonu v DB a nezajistí synchronizaci `.tmpl` souboru (PR + redeploy), Go daemon bude odesílat starší verzi obsahu. Platí i obráceně: nový `.tmpl` deploy bez UPDATE v DB způsobí, že Node skript pošle starší DB verzi.

**Doporučení:** Každá změna obsahu šablony musí aktualizovat oba zdroje atomicky — DB UPDATE + PR s `.tmpl` změnou nebo přechod na jednotný zdroj pravdy (iniciativa Sprint H1).

---

## Cesta C — operátorská odpověď / přeposlání (`manual_reply_outbox`)

Mimo kampaňové cesty A/B existuje **operátorem iniciovaný transakční send** z dashboardu (Odpovědi). Operátor buď **odpoví** odesílateli (ReplyComposer → `POST /api/replies/:id/reply`), nebo **přepošle** zprávu třetí straně (ForwardComposer → `POST /api/replies/:id/forward`, např. předání hot-leadu dealerovi). Obojí zapisuje řádek do `manual_reply_outbox`; **nestaví nový relay klient.**

Rozdíl reply vs. forward je daný sloupci (migrace 175):

| Sloupec (`manual_reply_outbox`) | Reply | Forward |
|---|---|---|
| `kind` | `'reply'` | `'forward'` |
| `forward_to` | NULL → příjemce = `reply_inbox.from_email` | adresa příjemce (override) |
| `from_mailbox_id` | NULL → schránka = `reply_inbox.mailbox_id` | zvolená/odvozená schránka |
| `subject_override` | NULL → „Re: …" | „Fwd: …" (skládá BFF route) |
| threading (In-Reply-To/References) | ano | **ne** (nová zpráva 3. straně) |
| `outreach_messages` insert po odeslání | ano (patří do threadu) | **ne** |

Dispatcher dělá `recipient = COALESCE(forward_to, from_email)` a schránku `COALESCE(from_mailbox_id, reply_inbox.mailbox_id)`, pak `POST /v1/submit` (stejný relay jako A/B). Tělo + „Fwd:" předmět skládá BFF route při enqueue, takže dispatcher zůstává hloupý odesílatel.

### Drift riziko: duální runner (kritické)

Stejně jako A/B i cesta C běží ve **dvou identických runnerech**:
- Go cron `services/orchestrator/cmd/outreach/cron_outbound_reply.go` — **24/7 produkční** (Z3).
- BFF cron `apps/outreach-dashboard/src/crons/runOutboundReplyCron.js` — běží jen když je operátorův Mac zapnutý.

**Obě SQL projekce musí zůstat bit-for-bit shodné.** Kdyby jen jeden runner znal `forward_to`, druhý by `forward` řádek odeslal na `from_email` (původní odesílatel) — únik dat + interních poznámek zpět leadovi. Každá změna projekce/recipient logiky musí měnit oba runnery + oba testy (`cron_outbound_reply_test.go` + JS) v jednom PR.

---

## Downstream reference

- **Relay pipeline:** obě cesty odesílají přes `POST /v1/submit` na anti-trace-relay. Celý 42-krokový pipeline je popsán v [`anti-trace.md`](anti-trace.md).
- **Odpovědi od příjemců:** zpracovávány nezávisle přes IMAP inbound pipeline — [`imap-inbound.md`](imap-inbound.md).
- **Renderování šablon (cesta A):** `content.Engine.Render()` + humanize engine — [`content-render.md`](content-render.md).
