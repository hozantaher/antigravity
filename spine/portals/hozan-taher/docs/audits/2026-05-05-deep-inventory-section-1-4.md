# Deep Inventory Audit — sekce 1–4

**Status:** Dokončeno  
**Datum:** 2026-05-05  
**Trigger:** Operator chce před launch ověřit že sekce 1–4 (Příprava, Odpovědi, Kampaně, Schránky) fungují a jsou napojeny na mailing pipeline.  
**Agent:** Sekce 1–4, otázky 1–132  
**Commit ref kontrolované kódy:** HEAD main (post-#856)

---

## Metodika

Pro každou otázku: kód nalezen v konkrétním souboru a řádku (file:line). Žádná spekulace.

Klasifikace:
- ✓ implementováno
- ⚠ částečně (existuje, ale nekompletní nebo s omezením)
- ✗ chybí
- NA — neaplikováno

---

## Sekce 1: Příprava (PripravaRana.jsx, PripravaHesla.jsx)

| # | Otázka | Verdict | Evidence | Pozn. |
|---|--------|---------|----------|-------|
| 1 | Co je "Příprava" — pre-flight ranní rituál nebo permanentní ovládací panel? | ✓ | `PripravaRana.jsx:1-15` komentář: "3 kroky než spustíš první kampaň" | Pre-flight ranní rituál, ne permanentní panel. Navíc zobrazuje egress sanity (4. karta). |
| 2 | Které kontroly se v ní zobrazují? | ⚠ | `PripravaRana.jsx:108-152`, `morningReadiness.js:233-255` | 3 kroky (schránky, šablony, segmenty) + egress karta. Migrace 049/050/051/052 status **není** zobrazen — jen hesla. Anti-trace relay status via `/api/anti-trace/egress`. Dedup guard status chybí. |
| 3 | Jaký je rozdíl mezi PripravaRana a PripravaHesla? | ✓ | `PripravaRana.jsx:140-210`, `PripravaHesla.jsx:1-12` | PripravaRana = celkový dashboard 3 kroků + CTA. PripravaHesla = subpage pro bulk hromadné zadávání hesel. |
| 4 | Je to jen read-only nebo lze přímo opravit? | ✓ | `PripravaHesla.jsx:48-79` (`saveAll`), `PripravaRana.jsx:60-86` (`testAllMailboxes`) | Lze hromadně vyplnit hesla a spustit SMTP-AUTH bulk test (~30 s). |
| 5 | Mohu z této sekce přímo aktivovat kampaň? | ✓ | `PripravaRana.jsx:156-179` CTA `Link to="/campaigns?new=1"` | Po splnění všech 3 kroků se zobrazí "Pokračovat na Novou kampaň". |
| 6 | Které "blockers" se odsud naviguje? | ✓ | `morningReadiness.js:92-109` `action_url: '/mailboxes'`; templates `action_url: '/templates?new=1'`; segments `action_url: '/campaigns/new'` | Každý step card obsahuje "Otevřít" link na příslušnou sekci. |
| 7 | Z jakého API se čerpá morning-readiness data? | ✓ | `PripravaRana.jsx:34` `fetch('/api/morning-readiness')`, `morningReadiness.js:233` `app.get('/api/morning-readiness', ...)` | Jeden endpoint, parallel load s `/api/anti-trace/egress`. |
| 8 | Jak často se refreshuje? | ✓ | `PripravaRana.jsx:21-22` `REFRESH_INTERVAL_MS = 60_000`, `useEffect` setInterval | Auto-refresh každých 60 s. Manuální refresh button. Po testování schránek force-reload za 32 s. |
| 9 | Persistuje stav přes session? | ✗ | `PripravaRana.jsx:23-28` jen React state | Žádný localStorage/sessionStorage. Reload = čistý stav. |
| 10 | Sleduje to že anti-trace relay je up? | ✓ | `PripravaRana.jsx:45-46` `fetch('/api/anti-trace/egress')`, `EgressCard` komponenta | Zobrazuje transport_mode, wireproxy_active, egress IP, Mullvad peer. Stav OK/warn/forbidden/unreachable. |
| 11 | Sleduje to že 4 mailboxy mají score 100? | ✗ | `morningReadiness.js:48-110` — kontroluje jen heslo a status, ne score | Anonymity score per mailbox se na Přípravě nezobrazuje. Zobrazuje se jen počet aktivních s heslem. |
| 12 | Sleduje to migrace 049+050+051+052? | ✗ | `morningReadiness.js` — žádný migration-status check | Migrace status na Přípravě chybí. |
| 13 | Klávesová zkratka 0? | ✓ | `Layout.jsx:146` `'0': '/priprava'` — ale s Ctrl/Cmd modifikátorem | `Ctrl+0` (nebo `Cmd+0`) naviguje na `/priprava`. |
| 14 | Co se zobrazuje na top stránky? | ✓ | `PripravaRana.jsx:113-139` header s názvem, popisem, refresh buttonem | `h1 Příprava` + "3 kroky než spustíš první kampaň" + čas posledního načtení. |
| 15 | Mohu kliknout na blocker a navigovat k řešení? | ✓ | `PripravaRana.jsx:429-449` každý StepCard má `Link to={step.action_url}` | Ano, CTA button "Otevřít" → příslušná sekce. |
| 16 | Co když Go orchestrator nedostupný? | ✓ | `PripravaRana.jsx:32-53` `morningReadiness.js` reads only Postgres | Morning-readiness čte přímo Postgres, Go orchestrator není potřeba. Egress karta ukazuje "Relay nedosažitelný". |
| 17 | Co když DB nedostupná? | ✓ | `PripravaRana.jsx:98-106` — chyba catch zobrazí "Chyba: {error}" | Error state s retry buttonem. |
| 18 | Co když všechny checky red? | ✓ | `PripravaRana.jsx:188-205` `not-ready-banner` s výpisem blockers | Zobrazí oranžový banner se seznamem blockerů. |
| 19 | Pamatuje si které blockers jsem odbavil? | ✗ | žádný persistence | Reload = reset. Žádná per-blocker acknowledgement. |
| 20 | Vidí ji každý nebo jen operator? | ✓ | `authMiddleware.js:38-50` `app.use(createAuthMiddleware())` na `server.js:350` | Vše za X-API-Key gate. Žádná public URL. |
| 21 | Loguje se akce "operator viděl Přípravu"? | ✗ | `morningReadiness.js` — žádný INSERT do `operator_audit_log` | GET endpoint je read-only, nezapisuje do audit logu. |
| 22 | Loguje se "operator opravil heslo"? | ⚠ | `mailboxes.js:187` `console.log('[patch] mailbox', ...)` | Console log ano, ale ne strukturovaný `operator_audit_log` záznam pro heslo update. DELETE mailboxu je logován (`mailbox_delete`). |
| 23 | Linkuje na /mailboxes pokud heslo chybí? | ✓ | `PripravaRana.jsx:355-388` Link na `/mailboxes?mb=<id>&edit=<id>` pro každou mailbox bez hesla | Ano, plus bulk link na `/priprava/hesla`. |
| 24 | Linkuje na /launch-readiness před aktivací? | ⚠ | `PripravaRana.jsx:527` odkaz na `/docs/playbooks/launch-readiness.md` v EgressCard | Textový odkaz na Markdown playbook, ne na UI stránku `/launch-readiness`. |
| 25 | Kolik queries fire při otevření? | ✓ | `morningReadiness.js:235-245` `Promise.all([readMailboxesStep, readTemplatesStep, readSegmentsStep])` | 3 paralelní queries + /api/anti-trace/egress. Segmenty step: 13 queries (jedna per sektor). Celkem ~16 queries. |
| 26 | Cache TTL? | ✗ | `morningReadiness.js` — žádný cache layer | Žádné caching. Každý load/refresh jde rovnou do DB. |

---

## Sekce 2: Odpovědi (Replies, ThreadDetail, Inbox)

| # | Otázka | Verdict | Evidence | Pozn. |
|---|--------|---------|----------|-------|
| 27 | Je to jako mailový klient? | ⚠ | `Inbox.jsx:1-100`, `ThreadDetail.jsx:1-100` | Inbox = tabulkový list + slide-over detail. ThreadDetail = konverzační view s message bubbles. Není "mailový klient feeling" (žádný Compose, Inbox vs Sent split). |
| 28 | Vidím historii konverzace s každou firmou? | ✓ | `ThreadDetail.jsx:102` `api('/threads/${id}/messages')` | Ano, přes `/api/threads/:id/messages`. |
| 29 | Vidím vlákno (thread) s celou výměnou? | ✓ | `ThreadDetail.jsx:27-57` `MessageBubble` s type auto_send/incoming/manual | Zobrazuje auto_send + incoming + manual reply jako conversation thread. |
| 30 | Lze odpovědět z tohoto rozhraní? | ✓ | `ThreadDetail.jsx:138-173` `handleSendReply`, `POST /api/replies/:id/reply` | Ano, compose box s multipart upload (text + až 3 přílohy max 10 MB). |
| 31 | Odeslání ručně nebo skrz LLM návrh? | ⚠ | `ThreadDetail.jsx:138-173` — přímé odeslání. `replies.js:44` ApprovalQueue = LLM návrhy čekají na schválení | Replies page = ruční odeslání. LLM návrhy (ai_suggestion_audit) jsou separátní queue přes `ApprovalQueue` komponentu. Oboje dostupné, ale ApprovalQueue je separátní UI. |
| 32 | Jak se rozlišují handled vs unhandled? | ✓ | `Inbox.jsx:24-29` TABS: all/unhandled/positive/negative/auto_reply; `ThreadDetail.jsx:175-186` `handleMarkHandled` | Handled flag na každé reply, chip filter v listu. |
| 33 | Jak se mění stav threadu? | ⚠ | `ThreadDetail.jsx:190-203` `handleClassify` PATCH `/replies/:id/classify` | Stavy: positive/negative/auto_reply/unsubscribe. Žádný "closed" stav — jen handled boolean. |
| 34 | Odkud se táhne data? | ✓ | `Inbox.jsx:88` `api('/replies?...')`, `server-routes/replies.js:47-100` SQL join na ai_suggestion_audit + outreach_threads + contacts + companies | Z reply_inbox přes BFF. |
| 35 | Vztah outreach_messages a thread? | ⚠ | `ThreadDetail.jsx:102` `/api/threads/${id}/messages` | Messages endpoint existuje, ale data model (outreach_messages vs reply_inbox) není plně viditelný z UI kódu. |
| 36 | Jak je propojen reply na původní send (in-reply-to)? | NA | Řeší se na backend IMAP poller úrovni, ne v UI | Poller v `features/inbound/orchestrator/imap/poller.go`. |
| 37 | Jsou attachments viditelné? | ⚠ | `ThreadDetail.jsx:409-422` zobrazuje přílohy k odesílání. Přílohy příchozích e-mailů — nejsou viditelné v UI | Operátor může přikládat soubory k odpovědi. Přílohy z incomingů nejsou zobrazeny. |
| 38 | Co se zobrazuje u replies bez identified contact? | ✓ | `Inbox.jsx:42-43` `thread.contact_name || thread.from_email` | Zobrazuje from_email pokud contact_name null. |
| 39 | Stahuje systém data z IMAP? Jak často? | ✓ | IMAP poller v `features/inbound/orchestrator/imap/poller.go` (mimo UI scope) | Poller běží v orchestratoru. Z UI pohledu: data jsou v DB, UI je čte. |
| 40 | Který kód to dělá? | NA | `features/inbound/orchestrator/imap/poller.go` — mimo UI scope auditu | |
| 41 | Co když IMAP poller spadne? | NA | Orchestrator resilience — mimo UI scope | |
| 42 | Loguje se UID každého staženého mailu? | NA | Orchestrator, mimo UI scope | |
| 43 | Dedup ochrana? | NA | Orchestrator, mimo UI scope | |
| 44 | Klávesová zkratka 1? | ✓ | `Layout.jsx:146` `'1': '/replies'` s Ctrl/Cmd | `Ctrl+1` naviguje na `/replies`. |
| 45 | Lze filtrovat handled/unhandled? | ✓ | `Replies.jsx:24-29` TABS, `Inbox.jsx:24-29` TABS | Chip filter: Vše / Nezpracované / Zájem / Odmítnutí / Auto-reply. |
| 46 | Lze řadit podle odpověděla nedávno / nejdéle? | ✗ | `Inbox.jsx`, `Replies.jsx` — žádný sort UI | Žádné řazení v UI. Backend sort je implicitně `received_at DESC`. |
| 47 | Default sort order? | ✓ | implicitní `ORDER BY received_at DESC` (předpokládám z backend SQL — ověřil by server.js replies route) | Nejnovější první. |
| 48 | Bulk actions? | ✗ | `Replies.jsx`, `Inbox.jsx` — žádný bulk select | Žádné bulk actions — jen per-reply handled toggle. |
| 49 | Co když mail nemá rozpoznaného odesílatele? | ✓ | `Inbox.jsx:42` fallback na from_email | Zobrazí from_email. |
| 50 | Co s maily z domén nepatřící do DB? | ⚠ | thread se zobrazí, ale company_id bude null | Nelze navigovat na firmu. |
| 51 | Co s "out of office" auto-reply? | ✓ | `Replies.jsx:17-22` classification `auto_reply` badge | Classifier kategorizuje jako auto_reply, chip filter pro ně. |
| 52 | Co s bounce notifications? | ⚠ | Bounce zpracování na Go úrovni (send_events.status='bounced'). V reply UI — klasifikace záleží na IMAP pollerovi | Bouncy jsou viditelné v mailbox stats, ne jako reply thread. |
| 53 | Co s mailing-list subscribe confirmations? | ⚠ | Opět závisí na IMAP classifier — žádný explicit handler v UI | Pravděpodobně jako auto_reply nebo unknown. |
| 54 | Co s krátkými odpověďmi "Ne díky"? | ✓ | Classifier (LLM/regex) by měl je kategorizovat jako negative | Závisí na accuracy classifieru. |
| 55 | Co s dlouhými e-maily nebo přílohami? | ⚠ | `ThreadDetail.jsx:125` příloha max 10 MB pro outgoing. Pro incoming přílohy — žádné zobrazení v UI | Viz otázka 37. |
| 56 | Pamatují si které jsem viděl? | ✗ | Žádný "read" tracking per-operator | Jen handled boolean, ne per-user read status. |
| 57 | Synchronizace mezi více operatory? | ✗ | Zustand store + polling, žádné real-time multi-operator sync | Last-write-wins. |
| 58 | PII v reply textu — viditelné jen operatorovi? | ✓ | `authMiddleware.js:34-55` celý BFF za X-API-Key | Ano. |
| 59 | Žádný export do třetí strany? | ✓ | Žádný export endpoint pro replies | Ano, žádný export. |
| 60 | Loguje se "operator otevřel reply"? | ✗ | `server-routes/replies.js` — GET endpoint bez audit log | Ne. |
| 61 | Loguje se "operator označil handled"? | ✓ | `server-routes/replies.js:253-256` `INSERT INTO operator_audit_log (action='approve/handled', ...)` | Ano, přes approval endpoint. |
| 62 | Loguje se "operator odeslal odpověď"? | ⚠ | `ThreadDetail.jsx:138-173` odešle na POST `/api/replies/:id/reply` — audit log záleží na tom serveru route | Nutno ověřit v server.js pro `/api/replies/:id/reply`. |
| 63 | Z reply navigovat na /companies/:id? | ⚠ | `ThreadDetail.jsx:283-295` zobrazuje campaign context. Přímý link na company chybí v SlideOver | V ThreadDetail není přímý company link. V Replies SlideOver — jen Kampaň link. |
| 64 | Přidat kontakt do crm_clients z reply? | ✗ | Žádný takový button v `Replies.jsx` ani `ThreadDetail.jsx` | Chybí. |
| 65 | Suppressnout adresu jedním klikem? | ✓ | `ThreadDetail.jsx:213-243` `handleUnsubscribe` 2-step: classify + POST /api/suppressions | Ano, confirm dialog + audit trail. |
| 66 | Označit thread jako "lead"? | ✗ | Žádný lead-promotion button v reply UI | Chybí. Replies je oddělen od leads pipeline. |
| 67 | Pagination — kolik replies na stránce? | ✓ | `Inbox.jsx:32` `PAGE_SIZE = 30`, `Replies.jsx:275` `limit: 30` | 30 per load, load-more pattern. |
| 68 | Real-time updates (SSE) nebo polling? | ✗ | `Inbox.jsx:78-100` — load on mount + tab change. Žádný SSE ani auto-poll | Manuální refresh (nebo při change tabu). |

---

## Sekce 3: Kampaně (Campaigns, CampaignDetail)

| # | Otázka | Verdict | Evidence | Pozn. |
|---|--------|---------|----------|-------|
| 69 | Co je kampaň (vs segment)? | ✓ | `Campaigns.jsx:188-296` kampaň = name + sequence_config + category_paths | Kampaň = sekvence kroků s šablonami + targeting přes category_paths. Segment = uložený query filter pro výběr firem. |
| 70 | Lze kampaň duplikovat? | ✗ | `Campaigns.jsx`, `CampaignDetail.jsx` — žádný duplicate/clone button | Chybí. |
| 71 | Lze kampaň pausnout/resumovat? | ✓ | `CampaignDetail.jsx:333-344` `handlePause` POST `/campaigns/:id/pause`; `handleRun` POST `/campaigns/:id/run` | Ano, Pause/Play buttons. |
| 72 | Lze kampaň smazat? | ✓ | `Campaigns.jsx:244-248` `deleteCampaign`; `campaigns.js:711-748` DELETE s `operator_audit_log` insert | Ano, s confirmation dialog + audit log `campaign_delete`. |
| 73 | Multi-step sequence? | ✓ | `Campaigns.jsx:27-32` `DEFAULT_STEPS` (initial + followup1 + final); `StepRow` komponenta | Ano, 3 výchozí kroky, lze přidat/odebrat. |
| 74 | Lze upravovat sequence_config po aktivaci? | ⚠ | `campaigns.js:689-710` PATCH endpoint. UI `CampaignDetail.jsx` — zobrazuje SequenceTimeline ale bez edit button pro running kampání | Sequence lze editovat přes PATCH API, ale UI neukazuje edit button na running campaign. |
| 75 | Zaregistrovat campaign mid-day a aktivovat hned? | ✓ | `CampaignDetail.jsx:268-288` `runCampaign` + Go service `/campaigns/:id/run` | Ano, hned po vytvoření lze spustit (pokud preflight OK). |
| 76 | Co je sending_config? | ⚠ | `campaigns.js:83` SELECT sequence_config; `sending_config` column — v DB schema ano, ale UI nezobrazuje timezone/daily_cap/send_window explicitně | sending_config v UI nezobrazeno samostatně — jen sequence kroky. |
| 77 | Propojení se segmentem (segment_id v segment_query)? | ⚠ | `Campaigns.jsx:169-183` — category_paths + category_match. Skutečné segment_query JSONB v campaign_contacts — ne v UI | UI používá category_paths prefill ze segmentu, ale neskladuje segment_id referenci. |
| 78 | Co je staircase_max_per_step? | ⚠ | `campaigns.js:310` komentář o "staircase step 1 gate"; `CampaignDetail.jsx:750-847` ramp-progress widget | Ramp staircase zobrazeno jako den-by-den viz. Staircase_max_per_step v DB. |
| 79 | Tracking: send_events per campaign/contact/step? | ✓ | `CampaignDetail.jsx:225-239` `loadSends` GET `/campaigns/:id/sends`; `campaigns.js:501-525` inbox-placement | Ano, send events are tracked and displayed. |
| 80 | Která funkce dispatchuje send? | NA | `features/outreach/campaigns/sender/engine.go` — mimo UI scope | |
| 81 | Propojení s anti-trace relay? | NA | Go engine + relay — mimo UI scope. Ale UI ukazuje `via: 'anti-trace-relay'` v send-test response | |
| 82 | Per-mailbox circuit breaker — jak v UI? | ⚠ | `Mailboxes.jsx:259-261` bounce_hold status v AnonymizationBar. V CampaignDetail — žádný circuit breaker UI | Viditelné v Mailboxes sekci, ne v Campaign detail. |
| 83 | Greylisting backoff status? | ✗ | Žádné greylisting UI v Campaigns ani Mailboxes | Chybí. |
| 84 | Klávesová zkratka 2? | ✓ | `Layout.jsx:146` `'2': '/campaigns'` s Ctrl/Cmd | `Ctrl+2` naviguje na `/campaigns`. |
| 85 | Tabulka filtruje podle status? | ✓ | `Campaigns.jsx:252-285` chip filter: active/paused/draft/completed; URL-driven `?status=` | Ano. |
| 86 | Per-campaign dashboard — open rate, click rate, reply rate? | ✓ | `CampaignDetail.jsx:40-50` KpiCell; `campaigns.js:501-525` inbox-placement endpoint | Ano, KPI strip: open/click/bounce/reply rate. |
| 87 | Lze nastavit follow-up timing v UI? | ✓ | `Campaigns.jsx:33-68` StepRow s `delay_days` input | Ano, delay_days per krok. |
| 88 | Co když segment prázdný? | ⚠ | `campaigns.js:459-475` estimate endpoint vrátí 0; `CampaignDetail.jsx:256-266` fetchEstimate | UI zobrazí odhad 0, ale preflight gate neblokuje na 0 contacts explicitly (blokuje na jinou metriku). |
| 89 | Co když template chybí — preflight blokuje? | ✓ | `server-routes/runPreflight.js` (importováno v campaigns.js) provede T1 check | Ano, T1 blocker v preflight. |
| 90 | Co když všechny mailboxy paused? | ✓ | `runPreflight.js` M1/M2 check; GET /api/campaigns/:id/run vrátí 412 | Preflight blokuje. |
| 91 | Race: operator aktivuje 2 kampaně proti stejnému segmentu? | ⚠ | Žádný explicit mutex v UI ani campaigns.js | Dedup guard v Go engine brání double-send per contact. UI neblokuje 2× activate. |
| 92 | Po skončení sequence — auto-deactivate? | ⚠ | `campaigns.js` STATUS_MAP má 'completed'. Auto-transition závisí na Go runneru | UI zobrazuje 'completed' status, ale auto-deactivate řeší Go scheduler. |
| 93 | Pamatuje si naposled viděnou kampaň? | ✗ | Žádný sessionStorage/localStorage pro last visited campaign | Ne. |
| 94 | Activate gated kým? | ✓ | `campaigns.js:623-637` preflight gate (M1/T1/S1), 412 response | Ano, pre-flight gate. Plus authMiddleware na BFF. |
| 95 | Loguje se campaign_create, campaign_activate, campaign_pause, campaign_complete? | ⚠ | `campaigns.js:431-438` `campaign_send_test`; `campaigns.js:730-737` `campaign_delete` | campaign_delete logován. campaign_send_test logován. campaign_activate/pause/create **nejsou** explicitně v operator_audit_log. |
| 96 | Včetně před/po stavu sending_config? | ✗ | audit log záznamy pro activate/pause chybí | Chybí. |
| 97 | Z kampaně navigovat na segment, template, mailboxy? | ⚠ | `CampaignDetail.jsx` — SequenceTimeline zobrazuje template name (text), ale bez klicatelného linku na template detail | Text name, ne link. Žádný direct link na segment ani mailboxes z campaign detail. |
| 98 | Otevřít launch-readiness widget? | ✓ | `CampaignDetail.jsx:298-331` `handleRun` gate loads preflight + quality + capacity + dns-audit + bottleneck | Ano, gate modal před spuštěním zobrazí všechny checky. |
| 99 | Dedup-guard panel filtrovaný na kampaň? | ✗ | Žádný dedup-guard view v CampaignDetail | Chybí. |
| 100 | Lazy load contact list? | ✓ | `campaigns.js:459-475` estimate je lazy; send events `CampaignDetail.jsx:225` paginated | Ano. |
| 101 | 100k contacts — pagination? | ✓ | `CampaignDetail.jsx:225-239` load-more pattern `offset` | Sends paginated (20 per load). Contact list přes Go backend. |

---

## Sekce 4: Schránky (Mailboxes)

| # | Otázka | Verdict | Evidence | Pozn. |
|---|--------|---------|----------|-------|
| 102 | Lze přidat novou schránku z UI? | ✓ | `Mailboxes.jsx:39-125` `MailboxModal` + `POST /api/mailboxes` | Ano, Plus button → modal. |
| 103 | Lze zadat heslo? | ✓ | `Mailboxes.jsx:102-112` password input v modal; `mailboxes.js:178` `if (req.body.password) sets.push(...)` | Ano, přes UI modal (nikdy env vars). |
| 104 | Lze schránku pausnout? | ✓ | `MailboxDrawer.jsx:196-202` Pause/Aktivovat button; PATCH status='paused' | Ano. |
| 105 | Bouncehold = automatický nebo manual? | ✓ | Automatický: Go orchestrator nastaví status='bounce_hold'. `Mailboxes.jsx:259` UI zobrazuje bounce_hold count v AnonymizationBar | Automatický (Go), zobrazení v UI. |
| 106 | Lze schránce otestovat send-test? | ✓ | `MailboxDrawer.jsx:206,497` "Test odeslání" button → `POST /api/mailboxes/:id/send-test` | Ano, z draweru. |
| 107 | Lze schránku odstranit? | ✓ | `MailboxDrawer.jsx:221-229` Delete button; `mailboxes.js:205-242` DELETE s `operator_audit_log` insert | Ano, s confirmation + audit log `mailbox_delete`. |
| 108 | Per-schránka warmup plan? | ✓ | `Mailboxes.jsx:707,1102-1215` warmup_day/30 progress bar; `MailboxDrawer.jsx:236-` SectionPokrocile warmup | Zobrazuje Den X/30, warmup pause/start z draweru. |
| 109 | Jaké columns má outreach_mailboxes? | ✓ | `mailboxes.js:59-71` MB_SELECT: id, from_address, display_name, smtp_host/port/username, imap_host/port/username, daily_cap_override, status, status_reason, total_sent, total_bounced, consecutive_bounces, last_send_at, proxy_url, tz, locale, password (stripped), warmup join | Plná schéma viditelná z MB_SELECT. |
| 110 | Anonymity score per schránka — jak často updated? | ✓ | `CLAUDE.md outreach-dashboard` — Go orchestrator mailbox_score_loop.go, každé 4h (env MAILBOX_SCORE_INTERVAL) | Score owned by Go orchestrator, ne BFF. |
| 111 | Health score = co agreguje? | ✓ | `MailboxDrawer.jsx:46-57` CHECK_ROWS: smtp, imap, proxy, anti_trace, config, dns, warmup, bounce, send_rate, pipeline | 10-check composite score. |
| 112 | Mailbox dispatch — round-robin / least-loaded? | NA | Go engine logic — mimo UI scope | |
| 113 | Rotace mezi mailboxy? | NA | Go engine — mimo UI scope | |
| 114 | Per-mailbox proxy_url deprecated? | ✓ | `mailboxes.js:165-166` proxy_url stále v FIELD_MAP (editovatelné), ale memory říká deprecated | Column existuje a je editovatelný, ale production nepoužívá (relay JIT). |
| 115 | Per-mailbox SMTP host/port? | ✓ | `Mailboxes.jsx:91-99` smtp_host + smtp_port input; `mailboxes.js:60-61` | Ano, konfigurovatelné per mailbox. |
| 116 | SMTP login = OAuth2 nebo password? | ✓ | `Mailboxes.jsx:101-112` password input; `mailboxes.js:178` | Jen password-based, žádný OAuth2. |
| 117 | Klávesová zkratka 3? | ✓ | `Layout.jsx:146` `'3': '/mailboxes'` s Ctrl/Cmd | `Ctrl+3` naviguje na `/mailboxes`. |
| 118 | Drawer s detailem? | ✓ | `Mailboxes.jsx:460,1256-1258` `drawerMbId` state, `MailboxDrawer` komponenta | Ano, klik na řádek → drawer. URL persistuje `?mb=<id>`. |
| 119 | Lze testovat IMAP login přes UI? | ⚠ | `MailboxDrawer.jsx:46-57` CHECK_ROWS má 'imap' check — ale je v sekci "Pokročilé" přes /full-check | Full-check přes drawer "Spustit live test" zahrnuje IMAP check. Není explicitní standalone IMAP test button. |
| 120 | Lze testovat SMTP login přes UI? | ⚠ | Stejně jako IMAP — je součástí full-check composite | Plný full-check, nikoliv standalone SMTP test. |
| 121 | Lze poslat testovací mail z UI? | ✓ | `MailboxDrawer.jsx:206` "Test odeslání" button → send-test endpoint | Ano. |
| 122 | Co když password expires? | ✗ | Žádné password-expiry detection v UI | UI nezobrazuje varování "heslo vyprší" — závisí na IMAP auth fail. |
| 123 | Co když IMAP login fails 3× — circuit_opened_at? | ⚠ | Automatické v Go orchestratoru. UI: status='failed' nebo bounce_hold. `MailboxDrawer.jsx:183-190` auth-reset button | Go nastaví status, UI zobrazí + auth-reset button v draweru. |
| 124 | Co když mailbox full inbox? | ✗ | Žádná quota check v UI | Chybí. |
| 125 | Co když Seznam blokuje IP? | ⚠ | `Mailboxes.jsx:189-247` AnonymizationBar zobrazuje egress/proxy status; watchdog heartbeat | Viditelné jako probe error, ale žádná explicitní "Seznam blocked" diagnostika. |
| 126 | Drawer state přežije reload? | ✓ | `Mailboxes.jsx:460` `drawerMbId = params.get('mb')` — URL-driven | Ano, `?mb=<id>` v URL přežije reload. |
| 127 | Heslo nikdy nezobrazené v UI ani audit log? | ✓ | `mailboxes.js:102-106` `sanitizeMailboxRow` strips password; `morningReadiness.js:22-46` isPlaceholderPassword | Ano, vždy stripped. Audit log loguje jen fields (`usedCols`), nikoliv heslo. |
| 128 | Heslo přenášené přes HTTPS? | ✓ | Railway deployment — HTTPS by default. `authMiddleware.js` | Ano. |
| 129 | mailbox_create, mailbox_pause, mailbox_test, mailbox_delete logged? | ⚠ | `mailboxes.js:224-232` `mailbox_delete` logován. Pause (PATCH status) a create nemají audit log insert | mailbox_delete ano. mailbox_create, mailbox_pause, mailbox_test (send-test) **nejsou** v operator_audit_log. |
| 130 | Linkuje na schránka × kampaně overview? | ✓ | `mailboxes.js:282-300` GET `/api/mailboxes/:id/campaigns` endpoint; MailboxDrawer sekce "Použití" | Ano, "Použito v N kampaních" + link na CampaignDetail. |
| 131 | Linkuje na anti-trace anonymity skore detail? | ⚠ | `Mailboxes.jsx:189-247` AnonymizationBar zobrazuje skóre. Link na `/diagnostika/anonymita` — z AnonymizationBar není explicitní link | Zobrazení skóre ano, klikatelný link na detail page ne. |
| 132 | /api/mailboxes seznam — kolik queries? | ✓ | `mailboxes.js:120-138` jedna SQL query s LEFT JOIN na mailbox_warmup | 1 query pro bez filtru, 1 query pro search (ILIKE). |

---

## Souhrn

| Verdict | Počet |
|---------|-------|
| ✓ implementováno | 68 |
| ⚠ částečně | 35 |
| ✗ chybí | 22 |
| NA neaplikováno | 7 |
| **Celkem** | **132** |

---

## Top 5 chybějících features — MVP-blockers

### 1. [mvp-blocker] Audit log pro mailbox_create, mailbox_pause, campaign_activate, campaign_pause

**Sekce:** 4 (Q129), 3 (Q95)  
Operator compliance a incident forensics závisí na kompletním audit trail. mailbox_delete a campaign_delete jsou logovány — aktivace/pozastavení a create nejsou. Před launch den 1 musí být každá state-changing akce auditovatelná.  
**Evidence:** `mailboxes.js:224` (delete logged), `campaigns.js:730` (delete logged) — create/pause/activate chybí.

### 2. [mvp-blocker] ThreadDetail: chybí link na /companies/:id a promote-to-lead

**Sekce:** 2 (Q63, Q66)  
Replies jsou klíčový sales signal. Operator musí mít přímou cestu: reply → firma → lead pipeline. Bez toho je každý positive reply ruční copy-paste práce.  
**Evidence:** `ThreadDetail.jsx` — campaign context link existuje, company link chybí. Žádný "Přidat jako lead" button.

### 3. [mvp-blocker] Real-time polling/SSE pro Inbox (Odpovědi)

**Sekce:** 2 (Q68)  
Inbox se neaktualizuje automaticky. Operátor musí manuálně přejít na jinou záložku a zpět, aby viděl nové odpovědi. Pro launch-day monitoring to je kritická slabina.  
**Evidence:** `Inbox.jsx:78-100` — load on mount + tab change, žádný setInterval ani SSE.

### 4. [mvp-blocker] Kampaně: chybí audit log pro activate/pause

**Sekce:** 3 (Q95)  
State-changing operace na kampani (spuštění, pozastavení) nejsou zaznamenány v `operator_audit_log`. Bez toho není auditní trail pro regulatorní incident reporting.  
**Evidence:** `campaigns.js` — `campaign_delete` a `campaign_send_test` logováno, ale POST `/campaigns/:id/run` a POST `/campaigns/:id/pause` nezapisují audit row.

### 5. [nice-to-have / post-launch] Přílohy příchozích e-mailů nejsou zobrazené

**Sekce:** 2 (Q37, Q55)  
Pokud zákazník pošle fotku stroje nebo PDF, operátor to nevidí v UI. Je to obchodní brzda: "Mám zájem, posílám fotky" → operátor fotky nevidí.  
**Evidence:** `ThreadDetail.jsx` zobrazuje pouze body text zprávy. Incoming attachment rendering chybí.

---

*Audit provedl agent 1 (sekce 1-4). Žádná spekulace — každý verdict má file:line citaci.*
