## Co se změnilo

<!-- Stručný popis změn (max 3 věty) -->

## Typ změny

- [ ] feat — nová funkce
- [ ] fix — oprava chyby
- [ ] refactor — refaktoring bez změny chování
- [ ] test — přidání/úprava testů
- [ ] chore — závisnoti, CI, dokumentace

## Checklist

- [ ] `go build ./...` projde
- [ ] `go test ./...` projde (nebo `pnpm test`)
- [ ] Nové testy pokrývají změny
- [ ] Žádné hardcoded secrets ani API keys
- [ ] BOARD.md aktualizován (pokud se mění architektura)

## Testování

<!-- Jak jsi otestoval změny? Co jsi spustil? -->

## Sentry

<!-- Pokud změna může ovlivnit error rate nebo performance: -->
- [ ] Nové error cesty mají `capture500()` / `sentry.CaptureException()`
- [ ] Přidány breadcrumby pro nové operace (pokud relevantní)

## Subsystem map citation (CAD-A4)

<!-- If this PR touches services/, modules/, or features/platform/outreach-dashboard/server.js
     or features/platform/outreach-dashboard/src/server-routes/, cite the relevant
     docs/subsystem-maps/*.md commit SHA. CI gate validates. Skip for
     doc-only or test-only edits. -->
- Subsystem: <!-- e.g. anti-trace, imap-inbound, dashboard-bff, scrapers, worker, content-render, protections, common-libs, OR "none — doc-only/test-only" -->
- Map SHA: <!-- output of `git rev-parse HEAD:docs/subsystem-maps/<name>.md` -->
- /start-task echo checklist: <!-- "filled" or "skipped — trivial" -->

