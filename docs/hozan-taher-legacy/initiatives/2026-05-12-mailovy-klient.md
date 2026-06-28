# Mailový klient v dashboardu

**Status:** Active
**Datum:** 2026-05-12
**Trigger:** Operátor potřebuje v dashboardu fungovat s e-maily jako v plnohodnotném mailovém klientovi — vidět příchozí zprávy ve vláknech, mít je svázané s firmou/kontaktem, odpovídat na ně včetně příloh a obrázků.

## Cíl

Dashboard se má chovat jako mailový klient. Operátor klikne na **Odpovědi**, uvidí všechny příchozí zprávy seskupené do vláken s tím kontaktem a firmou. Klikne na vlákno, vidí celou historii (naše odeslané zprávy plus odpovědi) včetně příloh — obrázky inline, ostatní soubory ke stažení. Odpoví v textovém poli, případně připne 1-3 obrázky nebo dokumenty. Odpověď se odešle přes náš anti-trace relay ze stejné schránky která původně psala, a do vlákna se okamžitě přidá jako naše odchozí zpráva.

## Stav před zahájením

Většina infrastruktury už **existuje a je zapojená** — jen některé spoje chybí. Konkrétně:

- **Frontend `/replies` a `/replies/:id`** jsou hotové, včetně lightboxu pro obrázky, AttachmentStrip komponenty a formuláře s multipart upload.
- **Relay** umí stáhnout headery zpráv (endpoint `/v1/imap-fetch` byl právě nasazen). Neumí ještě vrátit celý text + přílohy.
- **Orchestrátor** má kompletní pipelinu pro zpracování příchozí zprávy (`thread.InboundProcessor.ProcessReply`) — matchuje na vlákno, ukládá do `outreach_messages` + `message_attachments`, klasifikuje, řeší bounce, suppression, lead detection. **Není ale spojená s IMAP fetch** — orchestrátor má vlastní IMAP poller, ale ten je vypnutý a stejně by narazil na stejný cross-service problém jako BFF.
- **Reply send endpoint** v orchestrátoru `POST /api/replies/:id/reply` přijímá text odpovědi, vloží ji do `manual_reply_outbox`, označí původní reply jako vyřízenou — ale **nereálně neodesílá** přes relay.
- **Attachment streaming** `GET /api/attachments/:id/blob` z BFF funguje a UI ho čte.

## Sprint 1 — Vyzvedávání mailů do vláken

**Cíl sprintu:** Když přijde nový mail do schránky, automaticky se do 5 minut objeví v `/replies` jako součást vlákna s daným kontaktem, včetně všech příloh.

### Úkol 1.1 — Relay umí vrátit celý mail, ne jen hlavičky

Endpoint `/v1/imap-fetch` aktuálně vrací jen `From/To/Subject/Date/Message-ID/In-Reply-To/References`. Rozšíříme ho o volitelný parameter `include_body`. Když ho caller pošle, relay přidá pro každou zprávu celý raw RFC 5322 obsah (text plus přílohy). Použije se stejná IMAP konexe a stejný wgsocks tunel, jen místo `BODY.PEEK[HEADER.FIELDS (...)]` zavoláme `BODY.PEEK[]`. Vrácení celé zprávy včetně příloh u Seznamu obvykle vyjde na nějakých 50-500 KB na zprávu, takže limit zprávy 200 by se měl snížit na 30 aby HTTP odpověd nepřesáhla rozumnou velikost.

### Úkol 1.2 — Orchestrátor přijímá příchozí mail přes HTTP

Přidáme do orchestrátoru handler `POST /api/inbound` který přijme raw RFC 5322 bajty a metadata (která schránka ho dostala, kdy přišel) a interně zavolá `processor.ProcessReply`. Ten už umí všechno ostatní — naparsuje MIME, najde vlákno přes Message-ID nebo email, uloží zprávu i s přílohami do databáze, klasifikuje, případně přidá do suppression listu nebo označí kontakt jako lead. Endpoint musí být zaheslovaný (`X-API-Key` stejně jako ostatní orchestrátorové endpointy).

### Úkol 1.3 — BFF poslouchá relay a předává orchestrátoru

BFF cron `runImapPollCron` aktuálně volá relay `/v1/imap-fetch` a sám si dělá lightweight pairing do `reply_inbox` (jen headery, žádné přílohy). Místo toho po fetchnutí každou zprávu (raw bajty) přepošle do orchestrátoru přes `POST /api/inbound`. Tím se kompletní zpracování přesune do orchestrátoru kde už k tomu má všechno potřebné. Volání orchestrátoru přes existující `GO_SERVER_URL` + `OUTREACH_API_KEY` env vars. Existující `reply_inbox` INSERT zůstane jako fallback pro backward compatibility (zatímco se laděje), ale `outreach_messages` se začnou plnit.

### Úkol 1.4 — Nasazení a ověření

Nasadit relay a orchestrátor (BFF až po předchozích dvou). Otevřít `/replies`, zkontrolovat že se začnou objevovat zprávy z testu. Poslat si testovací mail s obrázkem v příloze a ověřit že:

- mail se objeví v `/replies` během 5 minut,
- klik na něj otevře `/replies/:id` s thread historií,
- obrázek se renderuje inline,
- ostatní přílohy mají download tlačítko.

## Sprint 2 — Odpovídání přes relay

**Cíl sprintu:** Operátor napíše odpověď, klikne Odeslat, a zpráva reálně dorazí příjemci ze správné schránky.

### Úkol 2.1 — Manual reply outbox processor

Vytvořit cron job nebo worker který každých pár minut (nebo immediately on insert přes PG NOTIFY) přečte nové řádky v `manual_reply_outbox`, sestaví je do MIME zprávy se správnými hlavičkami (zejména `In-Reply-To` a `References` aby Seznam navázal vlákno), a odešle je přes existující `relay/v1/submit` endpoint. Po úspěšném odeslání zapíše záznam do `outreach_messages` jako odchozí zprávu vázanou na stejné vlákno a označí outbox řádek jako odeslaný.

### Úkol 2.2 — Reply send akceptuje multipart s přílohami

Aktualní orchestrátor handler `POST /api/replies/:id/reply` přijímá jen JSON s tělem. UI ale posílá `multipart/form-data` s polem `body` a `files` (1-3 soubory). Handler je potřeba upgrade aby parsoval multipart, uložil soubory do `message_attachments` (s `direction='outbound'`, link na manual_reply_outbox) a předal je do MIME stavby v processoru. Limit velikosti 10 MB per attachment per migration 013.

### Úkol 2.3 — Ověření end-to-end

Z `/replies/:id` napsat odpověď s jedním JPEG obrázkem. Ověřit:

- na příjemcově straně mail dorazí se správnou subject hlavičkou (zachová "Re: ..." threading),
- inline obrázek je viditelný (ne jako attachment download),
- naše odchozí zpráva se přidá do vlákna v UI okamžitě po odeslání,
- `send_events` má nový řádek s linkem na campaign + contact,
- relay logy ukazují `outbound_smtp_delivered`.

## Sprint 3 — Doladění UI a operátorský komfort

**Cíl sprintu:** Použití jako reálný mailový klient bez frustrace.

### Úkol 3.1 — Drag-and-drop a paste přílohy

UI v ThreadDetail aktuálně používá `<input type="file">` button. Doplnit drag-and-drop zóny přes celý reply formulář a podporu Ctrl+V paste (typicky pro screenshoty ze schránky). Validace na klientu — max 3 soubory, max 10 MB každý, typy podle whitelistu (jpg, png, gif, webp, pdf, doc, docx, xlsx).

### Úkol 3.2 — Indikace nezpracovaných odpovědí

V navigačním menu vedle "Odpovědi" doplnit badge s počtem `handled=false` řádků v `reply_inbox`. Aktualizovat přes existující SSE `/api/threads/stream` event source. Audio/visual notifikace při příchodu (volitelně, gated env var).

### Úkol 3.3 — Filtry a vyhledávání

Existující tab strip v `/replies` (all / unhandled / positive / negative / auto_reply) doplnit o:

- vyhledávání podle obsahu (subject + tělo),
- filtr podle firmy (autocomplete),
- filtr podle data (last 24h / 7d / 30d / custom range).

### Úkol 3.4 — Klávesové zkratky

`j/k` navigace mezi vlákny, `r` otevři reply formulář, `Cmd+Enter` odešli, `Esc` zavři vlákno, `a` mark as handled. Konvence stejná jako Gmail / Superhuman pro známou ergonomii.

## Mimo skope

Tato iniciativa se **nezabývá**:

- Reorganizací stávajících tabulek `reply_inbox` vs `outreach_messages` (oboje zůstává; nový tok plní hlavně `outreach_messages` ale starý fallback běží dál).
- Multi-tenant izolací — pořád jeden operátor.
- AI suggestion pipelinou (`ai_suggestion_audit` zůstává jak je, klasifikátor běží separátně).
- Komplexními HTML editorem pro odpovědi — operátor píše plain text, případně s jednoduchými attachements.

## Rizika

- **Velikost raw bajtů přes HTTP.** Mail s 10 MB přílohou znamená 10 MB v HTTP odpovědi z relay do BFF, pak 10 MB v HTTP requestu z BFF do orchestrátoru. Při 50 zprávách za poll tick to je až 500 MB transferu. Mitigace: limit per poll snížit na 20-30 zpráv s nezpracovanou raw vahou (nikoli počtem), případně přílohy fetchovat jen on-demand když operátor klikne na zprávu.
- **MIME parsing edge cases.** Mail klienti generují kreativní MIME struktury. Existující `mime.Parse` v orchestrátoru má testy, ale produkční mail provideři občas překvapí (zejména forwardy s nestnutými multipart částmi). Mitigace: spadlé parsy logujem do `unmatched_inbound` s raw bytes, operátor je vidí v separátním filtru.
- **Reply threading u Seznamu.** Když odpovídáme, musíme zachovat `In-Reply-To` a `References` hlavičky aby Seznam (a další servery) navázaly vlákno. Existující `mime.Parse` tyto hlavičky extrahuje při příchodu; reply builder je musí zase použít. Test: poslat reply, otevřít webmail Seznamu, ověřit že je seskupený s původní zprávou.
- **Cross-service architektura.** Stejný princip jako u `/v1/imap-fetch` — orchestrátor je v jiném Railway kontejneru než relay, takže veškerá komunikace přes HTTP, nikoli sockety. To je ale benefit (čistá izolace), ne problém.

## Pořadí prací

1. Sprint 1 (úkoly 1.1 → 1.4) — odemkne `/replies` UI s real daty. **Toto je kritická cesta.**
2. Sprint 2 (úkoly 2.1 → 2.3) — operátor může odpovídat. Bez tohoto je dashboard read-only mail klient.
3. Sprint 3 podle priority operátora — komfort, ne blocker.
