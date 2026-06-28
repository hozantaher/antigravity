# Deep inventory — všechny dashboardové sekce a napojení na mailing

**Status:** Otázky vygenerovány, čeká na agentní audit napříč sekcemi
**Datum:** 2026-05-05
**Trigger:** Operator chce před zítřejším launch ověřit že každá sekce dashboard funguje, je napojená na mailing pipeline a operuje jako plnokrevný prodejní systém.

## Záběr

17 dashboardových sekcí + 8 cross-cutting témat. Pro každou sekci 30-50 otázek; celkem ~700 otázek. Po vygenerování spawnu agenty kteří odpoví na každou otázku reálným kódovým auditem (cite file:line, not speculation).

## Kategorie otázek pro každou sekci

A) Funkce — co sekce dělá, k čemu slouží
B) Data flow — co čte z DB, kam zapisuje
C) Mailing integration — jak se napojuje na anti-trace pipeline / IMAP poller / classifier
D) UX — jak operator interaguje, klávesové zkratky, hot keys
E) Edge cases — chybové stavy, prázdné stavy, race conditions
F) Persistence — co přežije reload BFF, restart Go orchestrator
G) Security — kdo to vidí, je to gate-d za X-API-Key
H) Audit — co se loguje do operator_audit_log
I) Integrace s ostatními sekcemi — hand-off, shared Zustand store
J) Performance — page load time, query time, pagination

---

## 1. Příprava (PripravaRana, PripravaHesla)

A funkce:
1. Co je "Příprava" — pre-flight ranní rituál nebo permanentní ovládací panel?
2. Které kontroly se v ní zobrazují (mailbox passwords, dedup migrace, anti-trace status)?
3. Jaký je rozdíl mezi PripravaRana a PripravaHesla?
4. Je to jen read-only nebo lze přímo opravit (např. fill mailbox heslo)?
5. Mohu z této sekce přímo aktivovat kampaň?
6. Které "blockers" se odsud naviguje?

B data:
7. Z jakého API se čerpá morning-readiness data?
8. Jak často se refreshuje (auto-reload nebo manual)?
9. Persistuje stav přes session?

C mailing:
10. Sleduje to že anti-trace relay je up?
11. Sleduje to že 4 mailboxy mají score 100?
12. Sleduje to že migrace 049+050+051+052 jsou aplikované?

D UX:
13. Klávesová zkratka 0?
14. Co se zobrazuje na top stránky?
15. Mohu kliknout na blocker a navigovat k řešení?

E edge:
16. Co když Go orchestrator nedostupný?
17. Co když DB nedostupná?
18. Co když všechny checky red?

F persistence:
19. Pamatuje si které blockers jsem už odbavil?

G security:
20. Vidí ji každý nebo jen operator?

H audit:
21. Loguje se akce "operator viděl Přípravu"?
22. Loguje se "operator opravil heslo"?

I integrace:
23. Linkuje na /mailboxes pokud heslo chybí?
24. Linkuje na /launch-readiness před aktivací?

J perf:
25. Kolik queries fire při otevření?
26. Cache TTL?

---

## 2. Odpovědi (Replies, ThreadDetail, Inbox)

A funkce:
27. Je to jako mailový klient (Apple Mail / Outlook)?
28. Vidím historii konverzace s každou firmou?
29. Vidím vlákno (thread) s celou výměnou e-mailů?
30. Lze odpovědět z tohoto rozhraní?
31. Je odeslání odpovědi ručně, nebo skrz operator/queue (LLM návrh)?
32. Jak se rozlišují odpovědi handled vs unhandled?
33. Jak se mění stav threadu (open / closed / replied / etc.)?

B data flow:
34. Odkud se táhne data — outreach_messages, reply_inbox, outreach_threads?
35. Jaký je vztah mezi outreach_messages a thread?
36. Jak je propojen reply na původní send (in-reply-to header? message-id?)?
37. Jsou attachments (fotografie, PDFs) viditelné a downloadable?
38. Co se zobrazuje u replies bez identified contact?

C mailing:
39. Stahuje systém data z IMAP a ukládá je do DB? Jak často (poll interval)?
40. Který kód to dělá (features/inbound/orchestrator/imap/poller.go)?
41. Co když IMAP poller spadne — jak se to obnoví?
42. Loguje se UID každé staženého mailu?
43. Je tam dedup ochrana proti dvojímu zaznamenání?

D UX:
44. Klávesová zkratka 1 a co dělá?
45. Lze filtrovat handled/unhandled?
46. Lze řadit podle odpověděla nedávno / nejdéle?
47. Jaký je default sort order?
48. Bulk actions (označit handled, převést na lead)?

E edge:
49. Co když mail nemá rozpoznaného odesílatele?
50. Co s e-maily z domén které nepatří do žádné firmy v DB?
51. Co s "out of office" auto-reply?
52. Co s bounce notifications od MTA?
53. Co s mailing-list subscribe confirmations?
54. Co s kratkými odpověďmi typu "Ne díky"?
55. Co s dlouhými e-maily nebo s přílohami velkých velikostí?

F persistence:
56. Pamatují si které jsem viděl?
57. Synchronizace mezi více operatory ovládacích panelů?

G security:
58. PII v reply textu — viditelné jen operatorovi?
59. Žádný export do třetí strany?

H audit:
60. Loguje se "operator otevřel reply"?
61. Loguje se "operator označil handled"?
62. Loguje se "operator odeslal odpověď"?

I integrace:
63. Lze z reply navigovat na /companies/:id (původní firma)?
64. Lze přidat kontakt do crm_clients z reply?
65. Lze suppressnout adresu jedním klikem (Art. 21 opt-out)?
66. Lze označit thread jako "lead" (převést do leads pipeline)?

J perf:
67. Pagination — kolik replies na stránce?
68. Real-time updates (SSE) nebo polling?

---

## 3. Kampaně (Campaigns, CampaignDetail)

A funkce:
69. Co je kampaň v tomto systému (vs segment)?
70. Lze kampaň duplikovat?
71. Lze kampaň pausnout / resumovat?
72. Lze kampaň smazat? (audit log)
73. Multi-step sequence (initial + follow-ups)?
74. Lze upravovat sequence_config po aktivaci?
75. Lze zaregistrovat campaign mid-day a aktivovat hned?

B data:
76. Co je sending_config (timezone, daily_cap, send_window)?
77. Jak je propojeno se segmentem (segment_id v segment_query JSONB)?
78. Co je staircase_max_per_step (migrace 017 — applied?)?
79. Tracking: send_events per campaign, per contact, per step.

C mailing:
80. Která funkce dispatchuje send (features/outreach/campaigns/sender/engine.go)?
81. Jak se kampaň propojuje s anti-trace relay?
82. Per-mailbox circuit breaker — jak se zobrazí v UI?
83. Greylisting backoff status?

D UX:
84. Klávesová zkratka 2?
85. Tabulka filtruje podle status (draft, running, paused, completed)?
86. Per-campaign dashboard — open rate, click rate, reply rate?
87. Lze nastavit follow-up timing v UI?

E edge:
88. Co když segment je prázdný — povolí runner spustit?
89. Co když template chybí — preflight blokuje?
90. Co když všechny mailboxy paused — runner se zastaví?
91. Co když operator zaktivuje 2 kampaně proti stejnému segmentu — race?
92. Co po skončení sequence — auto-deactivate?

F persistence:
93. Pamatuje si naposled viděnou kampaň?

G security:
94. Activate je gated kým? Pre-flight check?

H audit:
95. Loguje se campaign_create, campaign_activate, campaign_pause, campaign_complete?
96. Včetně před/po stavu sending_config?

I integrace:
97. Z kampaně lze navigovat na segment, na template, na mailboxy?
98. Lze otevřít launch-readiness widget pro tu kampaň?
99. Lze otevřít dedup-guard panel filtrovaný na tuto kampaň?

J perf:
100. Lazy load contact list?
101. Když je 100k contacts v kampani, jak se zobrazí pagination?

---

## 4. Schránky (Mailboxes)

A funkce:
102. Lze přidat novou schránku z UI?
103. Lze zadat heslo (per memory feedback_mailbox_passwords_via_db jen UI nebo SQL)?
104. Lze schránku pausnout?
105. Bouncehold = automatický stav nebo manual flip?
106. Lze schránce otestovat send-test?
107. Lze schránku odstranit (audit log)?
108. Per-schránka warmup plan?

B data:
109. Jaké columns má outreach_mailboxes?
110. Anonymity score per schránka — jak často updated?
111. Health score = co konkrétně agreguje?

C mailing:
112. Která mailbox dispatchne který send (round-robin / least-loaded)?
113. Jak se rotuje mezi mailboxy?
114. Per-mailbox proxy_url — deprecated per memory?
115. Per-mailbox SMTP host / port (smtp.seznam.cz / 587)?
116. SMTP login = OAuth2 nebo password?

D UX:
117. Klávesová zkratka 3?
118. Drawer s detailem (otevírá se kliknutím na řádek)?
119. Lze testovat IMAP login přes UI?
120. Lze testovat SMTP login přes UI?
121. Lze poslat testovací mail z UI?

E edge:
122. Co když password expires (Seznam ho ruší po N dnech inactivity)?
123. Co když IMAP login fails 3× — circuit_opened_at flips?
124. Co když mailbox je celý obsazen (full inbox)?
125. Co když Seznam blokuje IP odkud se hlásíme?

F persistence:
126. Drawer state přežije reload?

G security:
127. Heslo nikdy nezobrazené v UI ani audit log?
128. Heslo přenášené přes HTTPS jen?

H audit:
129. mailbox_create, mailbox_pause, mailbox_test, mailbox_delete logged?

I integrace:
130. Linkuje na schránka × kampaně overview (kterou kampaní jsou používané)?
131. Linkuje na anti-trace anonymity skore detail?

J perf:
132. /api/mailboxes seznam — kolik queries?

---

## 5. Firmy (Companies, CompanyDetail, CompanyTimeline)

A funkce:
133. Lze prohlížet detail firmy (ARES data, contacts, send history, replies)?
134. Funguje to formou timeline (chronological feed všech eventů)?
135. Lze firmu vyloučit (exclusion_status)?
136. Lze přidat custom note / tag?
137. Lze přiřadit ICP_tier ručně?
138. Lze otevřít timeline jednoho contactu vs všech contacts firmy?

B data:
139. Odkud se data plní (ARES, firmy.cz, eWAY-CRM XLSX import)?
140. Jak se update enrichment data (intelligence loop 6h)?
141. Jak se synchronizuje s contacts table (1:N přes ICO)?
142. Jak se synchronizuje s crm_clients (FK crm_client_id)?
143. Photo attachments — kde uložené (Railway volume)?

C mailing:
144. Vidím historii všech send_events na contacts firmy?
145. Vidím všechny inbound replies z firmy (přes contacts.ico join)?
146. Vidím kdy byl naposledy oslovena (last_contacted)?
147. Vidím dedup-guard skip reasons (proč nešel mail nedávno)?

D UX:
148. Klávesová zkratka 4?
149. Search by název, ICO, email?
150. Filter by region, NACE, icp_tier?
151. Sort by composite_score?
152. Bulk add to segment?

E edge:
153. Co když firma má více "aktivních" emails (boss@ + asistentka@)?
154. Co když firma zanikla (datum_zaniku NOT NULL)?
155. Co když ICO je ne-validní (8 digit but not in ARES)?
156. Co když firma má víc rows v companies (duplicate scrape)?

F persistence:
157. Drawer state přes reload?

G security:
158. PII contactů viditelné jen operatorovi?

H audit:
159. company_view, company_tag_add, company_excluded logged?

I integrace:
160. Z firmy navigovat na contacts list?
161. Z firmy přidat do segmentu ručně?
162. Z firmy spustit DSR access nebo erasure?
163. Z firmy poslat 1-shot mail (mimo kampaň)?

J perf:
164. Timeline pagination — kolik eventů na stránce?

---

## 6. Setup (parent group v sidebaru)

A funkce:
165. Setup je collapsible group — co je v ní?
166. Pamatuje si collapsed state přes localStorage?

D UX:
167. Operator může schovat / rozbalit sekci?
168. Default rozbaleno nebo schované?

---

## 7. Uložené filtry (Segments)

A funkce:
169. Co je segment vs ad-hoc query?
170. Lze segment uložit pojmenovaný?
171. Lze segment vyřadit ze seznamu?
172. Lze segment sdílet mezi operatory?
173. Lze segment použít pro novou kampaň přímo?
174. Refresh: nepřepočítává se segment automaticky?

B data:
175. Schema segment_query JSONB (operations EQ, IN, GTE, AND/OR)?
176. segment_memberships table — kdy se updates (manual refresh, on-demand)?
177. Lze segment exportovat do CSV?

C mailing:
178. Z segmentu se z BFF naseeduje campaign_contacts (ručně přes scripts/launch/seed-campaign-457.sql)?

D UX:
179. UI Query Builder — jak intuitivní?
180. Preview počet matches před uložením?

E edge:
181. Co když segment matchne 0 firem?
182. Co když matchne 100k firem (paginace)?
183. Co když filter referencuje column která neexistuje?

F persistence:
184. Custom segments per-operator vs globální?

G security:
185. Kdo může mazat segmenty?

H audit:
186. segment_create, segment_delete logged?

I integrace:
187. Z segmentu navigovat na seznam firem v něm?
188. Z segmentu spustit campaign?

J perf:
189. Query timeout?

---

## 8. Kontakty (Contacts)

A funkce:
190. Lze prohlížet seznam contacts (osoby ve firmách)?
191. Lze přidat ručně contact (mimo firmy.cz scraping)?
192. Lze suppressnout contact (Art. 21 opt-out)?
193. Lze označit DNT (do-not-track)?
194. Lze sloučit duplicitní contacts (merge)?
195. Lze contact přesunout mezi firmy (FK rename)?

B data:
196. contacts.email_status vs companies.email_status?
197. contacts.lifetime_touches — bumped triggerem?
198. contacts.dnt — kdo to nastavuje (auto-DNT classifier)?
199. contacts.crm_client_id FK — backfilled jak?

C mailing:
200. Vidím per-contact send history?
201. Vidím per-contact reply history?
202. Vidím dedup-guard verdict pro contact (proč se přeskočil)?

D UX:
203. Search, filter, sort?
204. Bulk suppress, bulk add to segment?

E edge:
205. Co když contact email == company email (1:1)?
206. Co když contact má víc identit (boss + asistentka stejná osoba)?

F persistence:
207. Drawer state?

G security:
208. PII viditelné — masking pravidla?

H audit:
209. contact_suppress, contact_unsuppress, contact_merge logged?

I integrace:
210. Z contact otevřít company, otevřít thread, otevřít suppression?

J perf:
211. /api/contacts pagination, search index?

---

## 9. Leady (Leads)

A funkce:
212. Co je lead vs contact vs reply?
213. Kdy se contact přesune do leads (po positive reply classification)?
214. Lead stages — kvalifikace, demo, proposal, won, lost?
215. Lze lead přesunout mezi stages?
216. Lze přidat poznámku, follow-up reminder?
217. Lze lead převést do CRM (export do eWAY)?

B data:
218. leads table schema?
219. Vztah leads ↔ contacts ↔ companies ↔ outreach_threads?

C mailing:
220. Lze z leadu poslat ad-hoc reply?

D UX:
221. Kanban board s stages?
222. Drag-and-drop mezi stages?

E edge:
223. Co když contact replyne ale není ještě v leads?
224. Auto-promote contact → lead trigger?

F persistence:
225. Lead position v stage persists přes reload?

G security:
226. Notes viditelné jen operatorovi?

H audit:
227. lead_create, lead_stage_change, lead_export logged?

I integrace:
228. Z lead otevřít timeline firmy?
229. Z lead exportovat do CRM (crm_clients update)?

J perf:
230. Kolik leads zvládne stránka bez lag?

---

## 10. Šablony (Templates)

A funkce:
231. Šablona = email body + subject?
232. Lze šablonu duplikovat?
233. Lze šablonu A/B testovat?
234. Variable substitution ({{first_name}}, {{company_name}})?
235. Spintax podporován ({Hi|Hello|Dobrý den})?
236. Multi-language (cs, en)?
237. Per-template anonymity score (humanize impact)?

B data:
238. email_templates schema?
239. Versioning — pamatuje historie verzí?

C mailing:
240. Která render funkce ji zpracovává (features/outreach/campaigns/content/render.go)?
241. Jak se substitutují variables (handlebars vs Go template)?
242. Humanize engine — co dělá s textem (typos, Markov)?

D UX:
243. Live preview během edit?
244. Validation per save (required vars present)?
245. Test render proti sample contact?

E edge:
246. Co když var v šabloně neodpovídá contact field (chybí first_name)?
247. Co s HTML escape?
248. Plain text vs HTML mail?

F persistence:
249. Draft pamatuje rozpracovanou šablonu?

G security:
250. XSS v preview prevention?

H audit:
251. template_create, template_update, template_delete logged?

I integrace:
252. Z šablony navigovat na kampaně co ji používají?
253. Z šablony otevřít explain (per-variable explanation)?

J perf:
254. Render benchmark?

---

## 11. Skórování (Scoring)

A funkce:
255. Co se scoruje — firmy, contacts, oboje?
256. composite_score, icp_score, best_targeting_score — co je rozdíl?
257. Lze scoring přepočítat manuálně?
258. Auto-recalculation — kdy běží (intelligence loop 6h)?
259. Per-axis breakdown (sector_match, region_match, size_match, NACE_match)?

B data:
260. Kde uložené (companies.composite_score, contacts.score)?
261. Jaký je vzorec (váhy per-axis)?

C mailing:
262. Vidím skóre při výběru contacts pro kampaň?
263. Sort kampaně po skóre?

D UX:
264. Histogram distribuce skóre v segmentu?
265. Per-axis explorer (jaký podíl na finální score)?

E edge:
266. Co když firma nemá data pro scoring (výjmka, default 0)?

F persistence:
267. Filter přes session?

G security:
268. Scoring config (váhy) — operator edit?

H audit:
269. scoring_recalculate logged?

I integrace:
270. Ze scoring otevřít top-N firem?

J perf:
271. Recalculate of 200k firem trvá kolik (intelligence loop)?

---

## 12. CRM klienti (CrmClients)

A funkce:
272. CRM klient vs prospect — jaký je rozdíl?
273. Co se importuje z eWAY-CRM XLSX (klienti vs obchodní_případy)?
274. Lze ručně přidat CRM klienta?
275. Lze update existující CRM klienta?
276. Lze CRM klienta smazat (audit log per memory)?
277. CRM badge na CompanyDetail / ContactDetail (Sprint CRM-6)?

B data:
278. crm_clients schema (entity_id unique per source)?
279. FK na companies + contacts (crm_client_id)?
280. dedup-guard 8. axis crm_active_client (Sprint CRM-5)?

C mailing:
281. CRM klient se automaticky vyřazuje z outreach?
282. Suppression list backfilled při importu?

D UX:
283. Filter podle stav (Aktuální, Potenciální, Nezajímavý, Začínáme)?
284. Search by name, ICO, email?
285. Drawer s detailem (deals, history)?

E edge:
286. Co když CRM email matchne víc contactů v naší DB?
287. Co když ICO matchne firmu která už zanikla?
288. Reimport — UPSERT nebo INSERT?

F persistence:
289. Filter přes reload?

G security:
290. Komu jsou CRM data viditelná?

H audit:
291. crm_import logged (PR #830)?
292. crm_client_delete logged?

I integrace:
293. Z CRM klienta otevřít company timeline?
294. Z CRM klienta otevřít contact list?
295. CRM badge na replies (rozpoznání že odepsal CRM klient)?

J perf:
296. /api/crm/clients pagination?

---

## 13. Analytika (Analytics)

A funkce:
297. KPIs zobrazené na hlavní stránce?
298. Per-campaign metrics (open, click, reply, bounce)?
299. Per-mailbox metrics (deliverability, score)?
300. Per-segment metrics (size trend)?
301. Time series / sparklines?
302. Filter by date range?

B data:
303. Z jakých tables se agreguje (send_events, tracking_events, reply_inbox)?
304. Cache TTL pro aggregations?

C mailing:
305. Real-time update po novém send?

D UX:
306. Klávesová zkratka? (Engineering group, ne primary)
307. Export do CSV / PDF?

E edge:
308. Co když intelligence loop neběží (žádný refresh data)?
309. Co když data starší než 7 dní (retention)?

F persistence:
310. Filters přes session?

G security:
311. Analytics dashboard public-link sharing? Ne pro PII data.

H audit:
312. analytics_view logged?

I integrace:
313. Lze drill-down z metrics na konkrétní seznam (např. "20 bouncí" → seznam bounce events)?

J perf:
314. Heavy aggregation queries — caching?

---

## 14. Upozornění (Watchdog)

A funkce:
315. Co se monitoruje (mailbox health, anti-trace failures, bounce spikes, reply backlog)?
316. Severity (critical, warning, info)?
317. Lze alert manuálně close?
318. Lze alert snooze (suppress 1h)?
319. Auto-close když problem resolves?

B data:
320. alerts / alert_state table?
321. Source: probes, healing log, intelligence loop?

C mailing:
322. Alert at "mailbox bounce rate > 5%"?
323. Alert at "anti-trace queue depth > 100"?
324. Alert at "no IMAP poll for 1h"?

D UX:
325. Klávesová zkratka? (engineering)
326. Toast notifications real-time?
327. Per-source filter (mailbox vs anti-trace vs IMAP)?

E edge:
328. Storm of alerts — rate limit per source?
329. Alert deduplication?

F persistence:
330. Snooze persists přes reload?

G security:
331. Alerts globální nebo per-operator?

H audit:
332. alert_close, alert_snooze logged?

I integrace:
333. Z alertu navigovat na příčinu (např. mailbox detail)?

J perf:
334. Polling interval pro nové alerts?

---

## 15. Pozorovatelnost (Observability)

A funkce:
335. Logs streaming (Sentry, Railway logs)?
336. Daemons status (campaign_daemon, intel_loop)?
337. Cron job last_run timestamps?
338. Health snapshot (DB, anti-trace, IMAP, BFF)?
339. Anti-trace egress diagnostic?
340. Sentry release tag?

B data:
341. /api/health/system response — co obsahuje?
342. /dashboard endpoint Go orchestrator?

C mailing:
343. Per-pipeline-step success rate?
344. Bottleneck identification?

D UX:
345. Real-time auto-refresh?
346. Drill-down do log entries?

E edge:
347. Co když Go service down — UI graceful degradation?

F persistence:
348. Sentry replay link?

G security:
349. Logs nemají PII (per pii-leakage audit PR #841)?

H audit:
350. observability_view audit log?

I integrace:
351. Linkuje na Sentry, Railway dashboards?

J perf:
352. Dashboard load time pod 1s?

---

## 16. Diagnostika anonymity (DiagnostikaAnonymita)

A funkce:
353. Per-message anonymity score (L1 IP leak / L2 fingerprint / L3 envelope / L4 DKIM-SPF-DMARC)?
354. Histogram skóre přes recent sends?
355. Per-mailbox average anonymity?
356. Detail view jednoho výsledku?
357. Trend v čase?

B data:
358. anonymity_test_messages table?
359. Migrations 022 + 023 + 024?

C mailing:
360. Real production sends scored automaticky? Nebo jen test sends?
361. Threshold pro alert (skóre < 40 = warning)?

D UX:
362. Search by run_id?
363. Filter per-mailbox per-template?

E edge:
364. mb-to-mb ceiling 60/100 (memory mb_to_mb_anonymity_ceiling)?
365. mb-to-Gmail (full L3+L4 viditelnost)?

F persistence:
366. Filters přes reload?

G security:
367. Diagnostic data jen operator?

H audit:
368. anonymity_test_run logged?

I integrace:
369. Linkuje na anonymity-test cmd output?
370. Linkuje na mailbox detail (per-mailbox score)?

J perf:
371. Aggregations cached?

---

## 17. Dedup Guard (DedupGuard)

A funkce:
372. 8 axes (PR #832): dnt, lifetime_exhausted, cross_campaign, per_domain, bounce_cluster, region_rate_limit, engagement_decay, crm_active_client?
373. Per-segment funnel (eligible → blocked breakdown)?
374. Recent skips list (PII redacted per PR #841)?
375. Per-axis statistics (hit count last 24h / 7d)?

B data:
376. campaign_contacts.details JSONB skip_reason?
377. contacts.dnt + lifetime_touches + email_domain (migrace 049)?

C mailing:
378. Real-time po každém runner tick?
379. Pre-launch verification (jeden ze 4 sanity gates)?

D UX:
380. Klávesová zkratka? (engineering)
381. Manual override (operator unblock contact)?

E edge:
382. Co když 0 contactů blokováno (test segment)?
383. Co když 100% contactů blokováno (chyba v config)?

F persistence:
384. Filter persists?

G security:
385. Recent skips email redacted (PII memory)?

H audit:
386. dedup_guard_init, dedup_guard_update logged?

I integrace:
387. Z guard panelu otevřít contact detail (proč přesně blokován)?
388. Z guard panelu modifikovat config (threshold)?

J perf:
389. Aggregations TTL?

---

## Cross-cutting otázky

### A. IMAP integration

390. Stahuje systém data z IMAP a ukládá? (features/inbound/orchestrator/imap/poller.go)
391. Jak často poll (default 60-90s)?
392. UID watermark per mailbox — pamatuje co už staženo?
393. UIDvalidity-aware (mailbox rebuilt → re-fetch all)?
394. Multi-folder polling (INBOX, Spam, Trash)?
395. Auth fail handling (3× 401 → circuit_open)?
396. TLS / STARTTLS?

### B. Reply attribution

397. Přiřazují se odpovědi ke správné firmě a kontaktům?
398. Match by email lower(trim) → contact → company.ico?
399. Co když odepsal někdo jiný v té samé firmě (boss → asistentka)?
400. Co s aliasy (info@firma.cz → boss@firma.cz)?
401. Forwarded mail (Outlook auto-fwd)?

### C. Conversation history / Timeline

402. Mohu si projít historii konverzace s firmou?
403. Funguje to formou timeline (chronological feed)?
404. Per-company nebo per-contact thread?
405. Visualization (timeline graph, kanban, list)?
406. Filterable per-event-type (send, open, click, reply, bounce)?

### D. Mailový klient pocit

407. Chová se to jako mailový klient (Apple Mail / Outlook)?
408. Lze odpovědět z UI (compose box)?
409. Lze přepojit / forward?
410. Lze označit jako spam (manual classifier override)?
411. Drafts perzistent?
412. Inbox vs Sent split?

### E. Attachments

413. Mohu vidět fotky které firma pošle?
414. Inline image preview (lightbox)?
415. Download attachment?
416. Storage location (Railway volume, S3)?
417. PDF preview?
418. Antivirus scan (clamav)?

### F. Sales system completeness

419. Vytěžíme ze získaných dat maximum?
420. Per-firma intent score (engagement intensity)?
421. Predikce reply pravděpodobnosti?
422. Kdy je nejlepší čas znovu oslovit (cool-off recommendation)?
423. Auto-segmentace high-intent firem?
424. Campaign lift analysis (A vs B template)?

### G. CRM integration

425. eWAY-CRM XLSX import (Sprint CRM-1 až CRM-7)?
426. Bidirectional sync (export back to eWAY)?
427. Conflict resolution (CRM updated, naše DB updated)?

### H. Plný prodejní systém

428. Je to plný prodejní systém?
429. Funnel stages (Lead → MQL → SQL → Opportunity → Customer)?
430. Forecast / pipeline value?
431. Activity log per firma?
432. Reminders + follow-up scheduler?
433. Multi-user assignment (operator A vlastní firma X)?

---

## Další otázky (random brutal list, kandidáty na audit)

434. Co když operator otevře 2 taby a každý udělá jinou změnu na téže entity?
435. Optimistic locking? Last-write-wins?
436. Service worker / offline mode?
437. Mobile responsive (smartphone in field)?
438. Screen reader accessible?
439. Dark mode persistent přes reload?
440. Keyboard navigation všude?
441. Focus trap v modals?
442. Confirmation dialog před destructive akcí?
443. Undo functionality (last action)?
444. Bulk select stable přes pagination?
445. Right-click context menu?
446. Drag-and-drop podporováno?
447. Search with autocomplete?
448. Recent items / favorites?
449. Saved views?
450. Custom columns (operator vybírá kterých 5 sloupců se zobrazí)?
451. Density (compact / regular / comfortable)?
452. Pin column (sticky first column)?
453. Resize columns?
454. Multi-sort?
455. Column-specific filter (Excel-like)?
456. Inline edit?
457. Cell-level audit (kdo to upravil)?
458. Export selected (current view) vs export all?
459. Saved CSV exports?
460. Scheduled exports (weekly digest)?
461. PDF print-friendly view?
462. Quick action bar (most common actions one click)?
463. Floating help / chat?
464. Notification center?
465. Operator presence (who's online)?
466. Activity feed (recent operator actions)?
467. Notes per entity (free-form notepad)?
468. Tags global vocabulary?
469. Smart suggestions (based on history)?
470. "Did you mean" search?
471. Recently changed indicator?
472. Stale data warning (data older than X)?
473. Deleted data recovery (soft delete trash)?
474. Versioning per entity (kdo, kdy, co změnil)?
475. Diff viewer pro historie?
476. Audit log search (who did X)?
477. Permission roles (admin, operator, viewer)?
478. Feature flags per environment?
479. A/B test framework?
480. Analytics tracking (heap, posthog)?
481. User feedback widget?
482. Error boundary per page?
483. Graceful degradation when API slow?
484. Skeleton loading states?
485. Empty state illustrations?
486. Onboarding tutorial?
487. Keyboard shortcuts help (?)
488. Quick tour for new feature?
489. Changelog / release notes?
490. Feature deprecation warnings?

### Mailing / pipeline brutal otázky

491. Kdo je odpovědný za rendering Subject line (template engine vs send-time?)
492. Kdy se přepočítává `Reply-To` (per-mailbox unique?)
493. List-Unsubscribe header povinný (RFC 2369)?
494. List-Unsubscribe-Post header (RFC 8058 one-click)?
495. Precedence: bulk header?
496. X-Campaign-ID header (interní tracking)?
497. Message-ID format unique guaranteed?
498. References header (chain replies)?
499. In-Reply-To header?
500. SPF record na sending domain (mxsender@firma.cz vs mb1@email.cz)?
501. DKIM signing — selector / key length?
502. DMARC policy (none / quarantine / reject)?
503. BIMI logo?
504. Authenticated Received Chain (ARC)?
505. Feedback Loop (FBL) registration s Seznam/Gmail?
506. Postmaster tools monitoring (Gmail Postmaster, Yahoo)?
507. RBL check before send (blacklisted by Spamhaus, SORBS)?
508. SPF record SoftFail vs Fail behavior?
509. Reverse DNS (PTR) match na sending IP?
510. Open relay test (vs MX relay)?
511. Greylisting smart retry?
512. TLS verify (StartTLS vs implicit TLS)?
513. SMTP banner randomization?
514. EHLO / HELO hostname per envelope?
515. MAIL FROM normalization (RFC 5321)?
516. RCPT TO encoding (UTF-8 SMTPUTF8)?
517. DATA boundary (CRLF.CRLF)?
518. Long line handling (>998 chars)?
519. Content-Transfer-Encoding (quoted-printable, base64)?
520. Charset declaration (utf-8 forced)?
521. MIME multipart/alternative (text + html)?
522. Attachment Content-Disposition?
523. Reply tracking pixel placement?
524. Click-tracking redirect URL pattern?
525. Cookie-less tracking?
526. UTM parameters auto-injection?

### IMAP brutal otázky

527. SELECT vs EXAMINE folder (read-write vs read-only)?
528. UID FETCH vs SEQ FETCH?
529. CAPABILITY before LOGIN check?
530. IDLE protocol support (push notifications)?
531. CONDSTORE extension (modseq)?
532. QRESYNC for fast sync?
533. SEARCH UNSEEN performance?
534. Empty mailbox handling?
535. Flags update (\Seen, \Deleted, \Flagged)?
536. Move vs copy+delete?
537. Append (drafts persist)?
538. Quota check?
539. Mailbox subscribe / unsubscribe?

### Anti-trace brutal otázky

540. HELO domain leak in `Received: from <client-name>`?
541. EHLO IP literal vs FQDN?
542. X-Originating-IP header strip?
543. X-Mailer header strip / spoof?
544. Date header timezone match egress timezone?
545. Message-ID domain match sending mailbox domain?
546. Boundary string randomized per envelope (zero entropy = fingerprint)?
547. Header order preservation (RFC 5321 implicit ordering)?
548. Body ending CRLF.CRLF dot-stuffing?
549. SMTP pipelining vs sequential commands?
550. Connection reuse same envelope vs fresh?
551. SOCKS5 versioning correctness?
552. WireGuard packet handshake replay protection?
553. VPN handshake fingerprinting (DPI detection)?
554. DNS leakage outside VPN tunnel?
555. NTP / time sync (clock skew detection)?

### GDPR / Compliance brutal

556. Privacy notice link v každém emailu (HTML footer)?
557. List-Unsubscribe + List-Unsubscribe-Post oba?
558. Unsubscribe link 1-click bez login?
559. Soft unsub vs hard unsub semantics?
560. DSR access response time SLA (1 měsíc)?
561. DSR erasure cascades všechny tabulky (PR #855)?
562. Data minimisation in audit_log (PR #841)?
563. Pseudonymization possible?
564. Data retention 1825 days (PR #852)?
565. Operator audit_log immutable (no UPDATE/DELETE)?
566. CMS / cookie consent banner if dashboard public?
567. Geographic restriction (EU-only data residency)?
568. Cross-border transfer (Railway is in EU? Mullvad endpoints?)?
569. Sub-processor list documented?
570. DPA agreement template ready?

### Performance brutal

571. Largest table row count (companies, contacts, send_events)?
572. Index coverage on hot queries?
573. N+1 query detection?
574. Query timeout config (statement_timeout)?
575. Connection pool size (pgxpool)?
576. Slow query log review?
577. Redis / cache layer needed?
578. CDN for static assets?
579. WebSocket / SSE per page?
580. Bundle size dashboard (gzip <500kb)?
581. Time to first byte (<1s)?
582. Time to interactive (<3s)?
583. Largest contentful paint (LCP <2.5s)?

### Resilience brutal

584. Graceful degradation when Go orchestrator unreachable?
585. BFF retry with backoff?
586. Circuit breaker frontend → BFF?
587. Service worker fallback offline?
588. Localstorage backup of unsent forms?
589. Browser refresh = lost state mitigation?
590. Memory leak in long-running tabs (24h+)?
591. Background fetch refresh?

---

## Postup auditu

Po vygenerování seznamu spawnu **5 agentů** v paralelních worktrees, každý dostane 3-4 sekce:

- Agent 1: sekce 1-4 (Příprava + Odpovědi + Kampaně + Schránky)
- Agent 2: sekce 5-8 (Firmy + Setup + Segments + Kontakty)
- Agent 3: sekce 9-12 (Leady + Šablony + Skórování + CRM klienti)
- Agent 4: sekce 13-17 (Analytika + Upozornění + Pozorovatelnost + Diagnostika + Dedup Guard)
- Agent 5: cross-cutting (IMAP, reply attribution, timeline, mailový klient pocit, attachments, sales completeness, brutal otázky 434+)

Každý agent:
1. Přečte odpovídající kód (cite file:line)
2. Odpoví na každou otázku konkrétními měřenými fakty (žádná spekulace)
3. Označí každou odpověď: ✓ implementováno / ⚠ částečně / ✗ chybí / NA neaplikováno
4. Sepíše per-section audit doc
5. Filuje GH issue za každou ✗ chybějící feature kterou pokládá za MVP-blocker
6. Open ONE PR per agent

Reporty:
- `docs/audits/2026-05-05-deep-inventory-section-1-4.md`
- `docs/audits/2026-05-05-deep-inventory-section-5-8.md`
- `docs/audits/2026-05-05-deep-inventory-section-9-12.md`
- `docs/audits/2026-05-05-deep-inventory-section-13-17.md`
- `docs/audits/2026-05-05-deep-inventory-cross-cutting.md`

Master tracker:
- `docs/audits/2026-05-05-deep-inventory-summary.md` — počet ✓/⚠/✗ per sekce, top 10 mvp-blockers
