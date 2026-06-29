# Sprint KT-A13 — Když operátor otevře odpověď, hned vidí ze které kampaně přišla a co s ní udělat

> **Status:** Design draft 2026-04-30. Kód v tomto sprintu nevzniká, jen plán. Předchůdce: KT-A11 (CampaignDetail tabs), KT-A12 (UI redesign land). GH issue [#307](https://github.com/messingdev/hozan-taher/issues/307).

---

## 1. Aktuální stav

ThreadDetail je dnes obrazovka, kterou operátor otevře, když chce přečíst příchozí odpověď v inboxu. URL `/replies/:id`, soubor `features/platform/outreach-dashboard/src/pages/ThreadDetail.jsx`. Komponenta se chová správně po stránce schopnosti načíst data — primární fetch `/api/replies/:id` udržuje 4-stavovou logiku (`loading | ok | error | not-found`), sekundární fetche `/api/threads/:id/messages` a `/api/threads/:id/context` degradují gracefully. Operátor vidí timeline zpráv, klasifikační badge (Zájem / Odmítnutí / Auto-reply / Neznámý), formulář pro odpověď s přílohami a 5 akčních tlačítek nad timeline (`Zájem`, `Není zájem`, `Otázka`, `Unsubscribe`, `Vyřízeno`).

Tlačítka **fungují**, jak issue očekává — `handleClassify(classification, label)` zavolá `PATCH /api/replies/:id/classify` s tělem `{classification: 'positive'|'negative'|'question'|'unsubscribe'}`. `Vyřízeno` jde přes `handleMarkHandled` na `PATCH /api/replies/:id` s `{handled: true}`. Toast feedback funguje, optimistic update klasifikace v reply state existuje. **Co dnes chybí, je dvojí kontext:**

**Chybí campaign context v hlavičce.** Header v `PageBackHead` vykresluje `subtitle` jako spojení `from_email · subject · campaign_name`. Toto je už dnes — ale **bez odkazu na CampaignDetail**. Operátor vidí název kampaně jako prostý text. Pokud chce kampaň otevřít, musí jít přes sidebar → Kampaně → najít v seznamu, případně Cmd+K. Pravý postranní panel (`context.campaign`) má sice link „Otevřít kampaň“, ale ten visí v sidebar složce, kterou si operátor zobrazí jen občas. Header — to nejviditelnější místo — drill-in nemá.

**Chybí explicitní „Z kampaně:“ block.** Issue požaduje vlastní header/blok ve smyslu „Z kampaně: <name>“ s odkazem. Dnes je to v subtitle vedle subject pomlčkou, což je vizuálně podřízené a operátor to přehlédne.

**Unsubscribe tlačítko nezapisuje do suppression listu jako separate write.** Aktuální `handleClassify('unsubscribe', ...)` zavolá `/api/replies/:id/classify`, server v Go strana sama (přes existující reply classification flow) nemusí garantovat zápis do `suppression_list` tabulky. Memory `project_two_suppression_tables.md` říká, že máme dvě suppression tabulky (`outreach_suppressions` a `suppression_list`) a UNION při každém čtení. Pokud klasifikace `unsubscribe` zapíše jen do `outreach_suppressions` přes existující classifier, ale ne do `suppression_list`, UNION stejně chytne — ale to je side-effect, ne zaručený kontrakt. Issue říká explicitně „Unsubscribe button INSERT do `suppression_list`“, takže UI strana musí mít explicitní endpoint, který do `suppression_list` zapíše bez závislosti na tom, co dělá classifier daemon.

**Dashboard widgety drill-in chybí.** V `2026-04-28-operator-flow-architecture.md` S5 sprint plánuje widgety na `Dashboard.jsx` se třemi drill-in linky (`X nových odpovědí` → `/replies?filter=unhandled`, `Y schránek problém` → `/mailboxes?filter=health=warn,err`, `Z aktivních kampaní` → `/campaigns?status=running`). V repu však **soubor `Dashboard.jsx` není v `src/pages/`**. Co dnes funguje jako landing page, vypadá to být `Inbox.jsx` (`PageStatStrip` + `PageStat` widgety s počty replies podle klasifikace). `Replies.jsx` už podporuje URL-driven filtry (komentář `// F2a — URL-driven filters so dashboard / campaign drill-ins prefilter`), takže linky z Inboxu na `/replies?handled=false` by měly fungovat. Ale **PageStat na Inbox.jsx není dnes klikatelný element s Link wrapperem** — je to display-only komponenta. Operátor vidí číslo „5 nezpracovaných“, ale klik na něj se nikam nevezme. To samé pro Mailboxes a Campaigns metriky, kdekoliv jsou na landing.

Existuje výjimka — `Replies.jsx` sám má řádek 322 s komentářem `F-S3 — drill-in: each classification stat is a button`, takže uvnitř Replies stránky **klasifikační statky už drill-in mají** (klik na „Zájem“ stat změní filter na positive). Ale to je drill-in **uvnitř Replies stránky**, nikoliv **z dashboardu/landingu na Replies stránku**. To je rozdíl, který KT-A13 musí dodat.

## 2. Proč tento sprint

Reálný scénář, který sprint řeší:

> Úterý 8:30 ráno, operátor otevře app po noci. Vidí hlavní landing — 12 nových replies, 2 schránky se zlobí, 4 kampaně běží. Klikne na „12 nových replies“. Dnes: nic se nestane (PageStat je display-only). Musí jít do sidebaru → Replies → najet na „Nezpracované“ chip. Po KT-A13: klik na widget jde rovnou na `/replies?filter=unhandled`, seznam je už předfiltrovaný. Operátor otevře první reply — `/replies/abc123` → ThreadDetail.
>
> ThreadDetail dnes ukazuje subject „Re: Vykoupíme Vaši techniku“ a vedle pomlčkou „Výkup techniky 001“. Operátor neví, jestli to je první kampaň, nebo druhá, ani v jaké fázi je. Aby to zjistil, musí jít do sidebaru → Kampaně → najít „Výkup techniky 001“ → otevřít detail. To jsou 4 kliky a 30 sekund navíc. Pokud má 25 replies za den, ztrácí 12 minut denně jen tahle hra.
>
> Po KT-A13: header ThreadDetail má řádek **„Z kampaně: Výkup techniky 001 →“**, kde šipka je odkaz na `/campaigns/<campaign-id>`. Jeden klik a operátor je v CampaignDetail. Plus akční tlačítka (Zájem / Není zájem / Otázka / Unsubscribe / Vyřízeno) jsou hned dostupná, takže operátor klasifikuje jedním kliknutím a jde na další reply.

Cíl tohoto sprintu **není** přidat nový mailový engine ani změnit klasifikační logiku. Cíl je:

1. ThreadDetail header zviditelní campaign context jako klikatelný blok „Z kampaně: <name> →“ vedoucí na CampaignDetail.
2. Akční tlačítka (`Zájem`, `Není zájem`, `Otázka`, `Unsubscribe`, `Vyřízeno`) zachovají dnešní funkčnost ale přidají explicitní kontrakt pro `Unsubscribe` na zápis do `suppression_list` (nezávislý na classifier daemonu).
3. Landing dashboard widgety dostanou drill-in linky se zachovaným zbytek UX (čísla zůstávají, klik je nový element).

## 3. Návrh

Návrh stojí na třech změnách: header context block, unsubscribe write contract, dashboard drill-in.

### 3.1 Header „Z kampaně:“ block

V `ThreadDetail.jsx` v rendering větvi (po `if (replyStatus === 'loading') return ...`) **mezi `PageBackHead` a meta box** vložíme nový blok:

```text
┌─────────────────────────────────────────────────┐
│  Z kampaně: Výkup techniky 001  →                │
└─────────────────────────────────────────────────┘
```

Vizuální styl: `background: T.surface2`, `padding: '12px 20px'`, `borderRadius: 8`, `fontSize: 14`. Text „Z kampaně:“ je `color: T.muted`, název kampaně je `color: T.text` `fontWeight: 600`, šipka „→“ je odkaz `<Link to={'/campaigns/' + reply.campaign_id}>` se `display: inline-flex; align-items: center; gap: 4`. Celý řádek je clickable jako jeden element (klik kdekoliv = navigace).

Data zdroj: `reply.campaign_id` musí přijít z `/api/replies/:id`. Dnes ten endpoint vrací `reply.campaign_name` (server.js řádek 5692 dělá `cm.name AS campaign_name`), takže přidáme symetrický `cm.id AS campaign_id` do existujícího SELECT a frontend pole jen referencuje. Žádný nový endpoint.

Co když `reply.campaign_id == null`? Stane se to pro replies, které přišly mimo kampaňový kontext (manuálně přeposlané, testovací schránky bez kampaně). V tom případě blok nezobrazujeme vůbec (`{reply.campaign_id && <Link...>}`). Header zůstane jak dnes.

Sidebar `context.campaign` block s detaily (status, sent, replied, link „Otevřít kampaň“) zůstává — je doplňkový. Header link je primární vstup, sidebar je sekundární s metadaty.

### 3.2 Akční tlačítka — kontrakty

Tlačítka už dnes existují v `data-testid="classify-actions"` divu. Logika `handleClassify(classification, label)` zůstává pro **Zájem / Není zájem / Otázka**. Toto issue nemění.

Pro **Unsubscribe** dnes `handleClassify('unsubscribe', 'Přidáno na suppression')` zavolá `/api/replies/:id/classify`. KT-A13 přidá explicitní follow-up volání: po úspěšné klasifikaci server BFF rovněž zavolá `POST /api/suppressions` s tělem `{email: reply.from_email, reason: 'unsubscribe_reply', campaign_id: reply.campaign_id, source: 'thread_detail'}`. Tento endpoint má atomický INSERT do **`suppression_list`** tabulky (nezávislý na `outreach_suppressions`, který spravuje classifier daemon).

Implementace na BFF straně: `app.post('/api/suppressions', ...)` v `features/platform/outreach-dashboard/server.js`. Body validation: email povinný, reason enum (`unsubscribe_reply`, `bounce_hard`, `manual`). SQL: `INSERT INTO suppression_list (email, reason, campaign_id, source, created_at) VALUES ($1, $2, $3, $4, NOW()) ON CONFLICT (email) DO UPDATE SET reason = EXCLUDED.reason, source = EXCLUDED.source, updated_at = NOW()`. Tím si garantujeme, že kliknutí na Unsubscribe v UI **vždy** zápis udělá, i kdyby Go classifier byl mimo provoz.

Co se na frontendu změní: `handleUnsubscribe()` — nová funkce, která zavolá nejprve `/classify` a po úspěchu druhý `POST /suppressions`. Při failure druhého volání (db down) toast „Klasifikace uložena, ale suppression list nezapsán — zkuste znovu“. Uživatel pak má možnost kliknout znovu, nebo manuálně přidat přes /mailboxes UI.

Pro **Vyřízeno** zůstává `handleMarkHandled` jak dnes — žádná změna.

### 3.3 Endpoint `/api/replies/:id/context` — zachovat, rozšířit

Dnes `/api/threads/:id/context` (note: thread ID = reply ID v aktuální implementaci) vrací `{company, campaign, classification}`. Issue #307 píše „GET /api/replies/:id/context → {campaign, original_message, contact}“. Aktuální struktura má `company` místo `contact` a chybí `original_message`. KT-A13 doplní:

- Endpoint cesta sjednotit na `/api/replies/:id/context` (nebo udržet `/api/threads/:id/context` a alias). Pro konzistenci s issue přidám **nový alias `/api/replies/:id/context`**, který interně volá to samé co existující threads endpoint. Frontend pak přejde na replies cestu.
- Response body rozšířit o `original_message: { sent_at, subject, body_preview }` — je to první outbound zpráva v threadu, kterou kampaň poslala. Operátor vidí v sidebar „Co jsme jim poslali“ a může rychle pochopit kontext bez scrollu timeline.
- Alias `contact` na `company` pro budoucí semantiku — `contact` je v B2B kontextu spíš osoba (jméno, email), `company` je organizace (IČO, sídlo). Pro tento sprint zachovat oba klíče v response (`{contact: company, company: company}`) a v dalším sprintu přejmenovat čistě.

### 3.4 Dashboard widgety drill-in

Issue specifikuje:

```text
"X new replies"          → /replies?filter=unhandled
"Y schránek problém"     → /mailboxes?filter=health=warn,err
"Z aktivních kampaní"    → /campaigns?status=running
```

V kódu dnes není `Dashboard.jsx`. Landing role plní `Inbox.jsx`, který už má `PageStatStrip` widgety. KT-A13 **rozšíří `Inbox.jsx`** (ne nový soubor): existující `PageStat` komponenty se obalí do `<Link to={...}>` wrapperu. `PageStat` má dnes signature `<PageStat num={...} label={...} />` — přidáme volitelný prop `to` a uvnitř komponenty pokud `to` je nastavené, vykreslí celý stat jako `<Link to={to}>` wrapper (`text-decoration: none; color: inherit`). Tím se stat stává klikatelný, ale vizuálně se nemění.

Tři widgety:

- **„Nové odpovědi“** — `<PageStat to="/replies?handled=false" num={stats.unhandled} label="Nezpracované" />`. Odkaz `?handled=false` matches existing Replies URL filter logic.
- **„Schránky problém“** — `<PageStat to="/mailboxes?filter=health=warn,err" num={mailboxStats.problem} label="Schránek problém" />`. Vyžaduje nový stat fetch v Inbox (dnes Inbox čte jen reply stats, ne mailbox health). Buď nový endpoint `/api/mailboxes/health-summary` nebo agregace z existujícího `/api/mailboxes` na frontend straně. Doporučuji nový endpoint (server-side count, jeden network round-trip).
- **„Aktivní kampaně“** — `<PageStat to="/campaigns?status=running" num={campaignStats.running} label="Aktivních kampaní" />`. Nový endpoint `/api/campaigns/summary` nebo agregace z existujícího `/api/campaigns`. Doporučuji frontend agregaci, kampaní bývá málo (≤50).

Mailboxes URL filter `?filter=health=warn,err` musí být v `Mailboxes.jsx` URL-driven prefiltr — dnes Mailboxes má svou tabulku s health column ale URL filter parsing nemá. KT-A13 přidá URL parsing podobně jako Replies má (`useSearchParams`, `if (searchParams.get('filter') === 'health=warn,err') setHealthFilter(['warn', 'err'])`).

Campaigns URL filter `?status=running` — Campaigns.jsx zkontrolovat, dle screenshotu z `2026-04-28-operator-flow-architecture.md` S5.3 toto má fungovat. Pokud ne, přidat parser.

## 4. Acceptance kritéria

- [ ] **Header „Z kampaně:“ block existuje** — mezi `PageBackHead` a meta box je nový clickable řádek `Z kampaně: <name> →`, klik vede na `/campaigns/<reply.campaign_id>`.
- [ ] **Block se nezobrazí pro replies bez `campaign_id`** — pokud `reply.campaign_id == null`, blok není v DOMu (žádný prázdný „Z kampaně: undefined“).
- [ ] **Endpoint `/api/replies/:id` vrací `campaign_id`** — server.js SQL doplněn o `cm.id AS campaign_id`, response body obsahuje pole.
- [ ] **Akce buttons fungují stejně jako dnes** — `Zájem`, `Není zájem`, `Otázka`, `Vyřízeno` zachovají existing `handleClassify` / `handleMarkHandled` flow, žádný regress.
- [ ] **Unsubscribe button explicitně INSERT do `suppression_list`** — po úspěšné klasifikaci `unsubscribe` se zavolá `POST /api/suppressions` s `{email, reason: 'unsubscribe_reply', campaign_id, source: 'thread_detail'}`. SQL `INSERT ... ON CONFLICT DO UPDATE`.
- [ ] **`POST /api/suppressions` endpoint existuje na BFF** — body validation (email povinný, reason enum), idempotent ON CONFLICT, audit log entry přes `audit.Log()`.
- [ ] **Při failure suppression INSERT zobrazí non-fatal toast** — operátor vidí „Klasifikace uložena, ale suppression list nezapsán — zkuste znovu“, klasifikace zůstává.
- [ ] **Endpoint `/api/replies/:id/context` (alias) existuje** — vrací stejnou strukturu jako `/api/threads/:id/context` plus `original_message: { sent_at, subject, body_preview }`.
- [ ] **`PageStat` komponenta přijímá volitelný `to` prop** — pokud zadán, celý stat je `<Link to={...}>` wrapper s `text-decoration: none; color: inherit`.
- [ ] **Inbox.jsx widget „Nezpracované“ je klikatelný** — `to="/replies?handled=false"` směřuje na předfiltrovaný Replies seznam.
- [ ] **Inbox.jsx widget „Schránky problém“** — nový stat čte z `/api/mailboxes/health-summary`, link `to="/mailboxes?filter=health=warn,err"`.
- [ ] **Inbox.jsx widget „Aktivní kampaně“** — agregace z `/api/campaigns`, link `to="/campaigns?status=running"`.
- [ ] **Mailboxes.jsx URL filter `?filter=health=warn,err` funguje** — předfiltruje seznam na health = warn nebo err.
- [ ] **E2E test (Playwright) „operator flow“** — otevři `/`, klikni „Nezpracované“ stat, ověř `/replies?handled=false`, klikni první reply, ověř „Z kampaně:“ link, klikni link, ověř `/campaigns/<id>`. Trailer `Needs-Tests: ThreadDetail context drill-in flow` → KT-B14 sprint.

## 5. Změněné soubory

`features/platform/outreach-dashboard/src/pages/ThreadDetail.jsx` — přidat header „Z kampaně:“ block po `PageBackHead`. `handleUnsubscribe` nová funkce volá classify + suppressions sequentially. Zachovat existující `handleClassify` cesta pro Zájem/Není zájem/Otázka. Subtitle v `PageBackHead` zjednodušit (odebrat `campaign_name`, je to teď v dedicated bloku).

`features/platform/outreach-dashboard/src/pages/Inbox.jsx` — `PageStat` widgety obalit `to` propem. Přidat fetch na `/api/mailboxes/health-summary` a `/api/campaigns` (s agregací running). Ošetřit loading state widgetů (zatím `num="…"`).

`features/platform/outreach-dashboard/src/pages/Mailboxes.jsx` — `useSearchParams()` parser pro `?filter=health=warn,err`. Pokud parametr přítomen, prefilter healthFilter state na `['warn', 'err']`.

`features/platform/outreach-dashboard/src/pages/Campaigns.jsx` — ověřit že `?status=running` URL parser funguje. Pokud ne, přidat.

`features/platform/outreach-dashboard/src/components/page/PageStatStrip.jsx` — `PageStat` komponentě přidat volitelný `to` prop. Pokud zadán, render jako `<Link to={to}>` wrapper kolem existujícího markupu, `text-decoration: none; color: inherit`. Add `aria-label` na link aby screen-reader věděl „klikni pro detail“.

`features/platform/outreach-dashboard/server.js` — přidat `app.post('/api/suppressions', ...)` endpoint s body validation a SQL INSERT ... ON CONFLICT do `suppression_list`. Přidat `app.get('/api/replies/:id/context', ...)` alias na existing threads/context. Rozšířit existing context endpoint o `original_message` field (SELECT first outbound message v threadu). Změnit `/api/replies/:id` SELECT o `cm.id AS campaign_id`. Add `app.get('/api/mailboxes/health-summary', ...)` endpoint — `SELECT COUNT(*) FILTER (WHERE health IN ('warn', 'err')) AS problem, COUNT(*) AS total FROM outreach_mailboxes`.

`features/platform/outreach-dashboard/tests/contract/suppressions-post.test.js` — nový contract test: POST /suppressions s validním body uspěje, idempotency (druhý INSERT s existujícím email ON CONFLICT updates), invalid reason vrátí 400, missing email 400, audit log entry vznikne.

`features/platform/outreach-dashboard/tests/unit/pages/ThreadDetail.test.jsx` — přidat test cases: header „Z kampaně:“ link is rendered with correct campaign_id, blok není v DOMu pokud `campaign_id == null`, klik na Unsubscribe volá oba endpoints sequentially, failure druhého endpointu zobrazí non-fatal toast.

`features/platform/outreach-dashboard/tests/unit/pages/Inbox.test.jsx` — přidat test cases: `PageStat` `to` prop wraps content v Link, klik na widget naviguje na expected path, loading state zobrazí placeholder.

## 6. Otázky pro orchestrátora

1. **Endpoint cesta — `/api/replies/:id/context` vs `/api/threads/:id/context`?** Issue #307 říká `/api/replies/:id/context`. Existující kód má `/api/threads/:id/context`. Frontend dnes volá threads endpoint. Doporučuji **přidat replies alias** a v dalším sprintu deprecate threads cestu. Souhlas?

2. **Header block — design tokens.** Vizuální specifikace v sekci 3.1 je popis (background T.surface2, padding 12/20). Design rules globální říkají „avoid template-looking UI“ a „intentional rhythm in spacing“. Header block má proto být subtle ne výrazný — nechat na designer/operator screenshot review po implementaci, nebo přijmout default jak v draftu?

3. **`original_message` v context endpointu — co konkrétně vrátit?** Návrh: `{sent_at, subject, body_preview: first 300 chars}`. Alternativa: full body včetně HTML (operátor vidí vlastní template). Druhá varianta je užitečnější ale větší payload. Doporučuji preview 300 znaků pro context sidebar; full body operátor uvidí v message timeline jako outbound bubble (už dnes).

4. **Idempotency `POST /api/suppressions`.** Issue říká „INSERT do suppression_list“. ON CONFLICT DO UPDATE updates `reason`/`updated_at`. Alternativa: ON CONFLICT DO NOTHING (idempotent ale neaktualizuje reason pokud se mění). Doporučuji UPDATE (operátor mohl klasifikovat dříve manual, teď je reply unsubscribe — reason má reflect aktuální event).

5. **`PageStat` `to` prop signature — string nebo objekt?** React Router 7 `<Link to={...}>` přijímá oboje (string `"/replies?handled=false"` i objekt `{ pathname: '/replies', search: '?handled=false' }`). String je jednodušší, objekt je čistší. Pro tento sprint **string** stačí — search params jsou krátké a explicitní.

6. **Klik na PageStat — z mobile UX hlediska.** Mobile responsive je out of scope iniciativy `2026-04-28-operator-flow-architecture.md` line 281. Ale klik na celý stat box (cca 80×60 px) je touch-friendly. Žádné touch-target adjustment není potřeba. Souhlas?

7. **Mailbox health summary endpoint — exists?** Server.js search nenašel `health-summary`. Pokud existuje pod jiným jménem (např. `/api/mailboxes/stats`), použít existující. Pokud ne, přidat nový. Doporučuji nejdřív grep během implementace, pokud nic, přidat nový endpoint.

8. **Campaign-id v `reply` row — co když kampaň byla smazána?** Pokud `cm.id IS NULL` po LEFT JOIN, `campaign_id` v response je null a header block se neobjevuje (per acceptance kritérium). Ale `campaign_name` může z historického logu být zachován (např. `outreach_replies.campaign_name_snapshot` text column). Pokud taková snapshot column existuje, header block by se mohl zobrazit jako **disabled text** „Z kampaně: <name> (smazána)“ bez linku. Doporučuji **pro tento sprint nesnažit se** — pokud campaign neexistuje, blok není. Smazání kampaně je edge case a explicitní deprecation operátor uvidí v Campaigns archive view.
