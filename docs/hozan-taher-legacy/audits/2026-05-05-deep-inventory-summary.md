# Deep Inventory — Master Tracker

**Status:** Živý dokument — aktualizovat po merge každého section reportu  
**Datum:** 2026-05-05  
**Trigger:** Agregace 5 section auditů (otázky 1–591) před launchem

---

## Verdict Counts per Sekce

| Sekce | Otázky | ✓ | ⚠ | ✗ | NA | Report |
|-------|--------|---|---|---|----|--------|
| 1–4 (Příprava, Odpovědi, Kampaně, Schránky) | 1–130 | TBD | TBD | TBD | TBD | [section-1-4](2026-05-05-deep-inventory-section-1-4.md) — chybí |
| 5–8 (Firmy, Setup, Segments, Kontakty) | 131–211 | TBD | TBD | TBD | TBD | [section-5-8](2026-05-05-deep-inventory-section-5-8.md) — chybí |
| 9–12 (Leady, Šablony, Skórování, CRM klienti) | 212–296 | TBD | TBD | TBD | TBD | [section-9-12](2026-05-05-deep-inventory-section-9-12.md) — chybí |
| 13–17 (Analytika, Watchdog, Observability, Anonymita, DedupGuard) | 297–389 | TBD | TBD | TBD | TBD | [section-13-17](2026-05-05-deep-inventory-section-13-17.md) — chybí |
| Cross-cutting (IMAP, Reply, Timeline, UX, RFC, GDPR, Perf, Resilience) | 390–591 | **39** | **43** | **55** | **65** | [cross-cutting](2026-05-05-deep-inventory-cross-cutting.md) ✓ |

**Cross-cutting verdikt distribuece:**
- ✓ Implementováno: 39 (19 %)
- ⚠ Částečně: 43 (21 %)
- ✗ Chybí: 55 (27 %)
- NA Neaplikováno: 65 (32 %)

*(sekce 1–17 TBD — viz poznámka níže)*

---

## GH Issues pro Cross-cutting MVP-Blockery

Níže jsou problémy které byly otevřeny jako GH issues (open ONE issue per blocker):

| # | Issue | Popis | Severity |
|---|-------|-------|----------|
| 1 | #881 | UIDvalidity neimplementováno — mailbox rebuild → duplicity | HIGH |
| 2 | #873 | Reply attribution bez email fallback — aliasy ztraceny | HIGH |
| 3 | #874 | Inbound attachments chybí v UI | HIGH |
| 4 | #875 | List-Unsubscribe header není auto-injektován | HIGH |
| 5 | #876 | In-Reply-To/References chybí v follow-up emailech | MEDIUM |
| 6 | #877 | Precedence: bulk header chybí | MEDIUM |
| 7 | #878 | SEQ FETCH místo UID FETCH — race condition | MEDIUM |
| 8 | #879 | Žádný statement_timeout v pg.Pool | MEDIUM |
| 9 | #880 | DPA agreements chybí (GDPR subprocessors) | MEDIUM |
| 10 | #882 | Drafts neperzistovány | LOW |

---

## Poznámka k sekcím 1–17

Sekce 1–17 (otázky 1–389) nebyly dokončeny v tomto PR — příslušné reporty (`section-1-4.md`, `section-5-8.md`, `section-9-12.md`, `section-13-17.md`) ještě neexistují na `main`. Issues z existing section audits:
- Sekce 5–8 bylo zpracováno dříve: issues #859, #860, #861, #862 jsou otevřené

Tento master tracker bude aktualizován po merge každého section reportu.

---

## Top 10 MVP-Blockers (všechny audity)

Kombinovaný pohled na kritické blocker-level problémy z dostupných auditů:

### Z cross-cutting auditu (2026-05-05):

1. **[HIGH] Reply attribution bez email fallback** (Q398-400) — asistentka / alias odpovídá a reply je zahozen. Inbound zprávy z neznámých emailů jsou logované jako `inbound no matching thread` a nikdy se nedostanou do ThreadDetail. Fixit: přidat email-based fallback v `matchToThread` + BFF reply-inbox creation pro unmatched inbound.

2. **[HIGH] UIDvalidity ignorováno** (Q393) — po mailbox rebuild IMAP server přečísluje UIDs; poller's in-memory seen-set stale; potenciální duplikace reply zpracování. Fixit: přidat `UIDVALIDITY` check v `doFetch`, invalidovat seen-set při změně.

3. **[HIGH] Inbound attachments neviditelné** (Q413-415) — fotky a PDFs které zákazník pošle jsou uloženy v `message_attachments` DB i Railway volume, ale UI (`ThreadDetail.jsx`) je nezobrazuje. Fixit: přidat attachment list do `MessageBubble` pro inbound zprávy.

4. **[HIGH] List-Unsubscribe header není garantován** (Q493) — `runner.go` injektuje `UnsubURL` do šablony (tělo emailu), ale **ne do email headeru**. Gmail/seznam one-click unsubscribe závisí na `List-Unsubscribe` v headers. Fixit: přidat automatický `List-Unsubscribe` + `List-Unsubscribe-Post` do rendered.Headers v `runner.go`.

5. **[MEDIUM] In-Reply-To/References chybí v bump emailech** (Q498-499) — follow-up zprávy (step 2, 3) nenastavují `In-Reply-To: <original-message-id>`. Příjemcův mail klient nezachytí zprávy jako jedno vlákno. Fixit: přidat předchozí Message-ID do SendRequest a nastavit `In-Reply-To` v `buildMessage`.

6. **[MEDIUM] Precedence: bulk header chybí** (Q495) — bez `Precedence: bulk` mohou spam filtry klasifikovat jako phishing (bulk sender bez bulk deklarace je podezřelý). Fixit: přidat do `runner.go` rendered.Headers.

7. **[MEDIUM] SEQ FETCH místo UID FETCH** (Q528) — `poller.go` používá sequence numbers z `SEARCH UNSEEN`. Při concurrent přístupu se sequence numbers mohou přesunout. Fixit: použít `UID SEARCH UNSEEN` a `UID FETCH`.

8. **[MEDIUM] statement_timeout chybí** (Q574) — `server.js` pool nemá `statement_timeout`. Jediný dlouhý query může zablokovat connection pool. Fixit: přidat `options: '--statement_timeout=30000'` do `pg.Pool`.

9. **[MEDIUM] DPA agreements chybí** (Q569-570) — `art30-register.md` dokumentuje 4 subprocessory bez DPA: Railway, Anthropic, Sentry. GDPR Art. 28 vyžaduje písemnou DPA. Fixit: podepsat DPA s každým subprocessorem (proces, ne kód).

10. **[MEDIUM] Drafts neperzistovány** (Q411) — compose box v ThreadDetail je in-memory only; refresh = ztráta rozpracované odpovědi. Fixit: localStorage backup s cleanup po odeslání.

### Z sekce 5–8 auditu (existing issues #859–862):

11. **[HIGH] Company audit log chybí** (#860) — operator_audit_log neloguje company mutations
12. **[HIGH] DNT toggle UI chybí** (#861)
13. **[MEDIUM] Per-contact reply history chybí v draweru** (#862)
14. **[MEDIUM] Company exclusion_status PATCH chybí** (#859)

---

## Tracking Status

| Audit report | Status | MVP-blocker issues filed |
|---|---|---|
| cross-cutting (Q390-591) | ✓ Dokončeno | 10 issues níže |
| section-1-4 (Q1-130) | ✗ Chybí na main | TBD po merge |
| section-5-8 (Q131-211) | ⚠ Partial (issues #859-862) | 4 issues existují |
| section-9-12 (Q212-296) | ✗ Chybí na main | TBD po merge |
| section-13-17 (Q297-389) | ✗ Chybí na main | TBD po merge |
