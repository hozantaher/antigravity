# Sentry Alert Rules

## Nastavení v sentry.io (manuální — UI)

### Alert 1: New Issue Alert
**Co:** Každá nová chyba která se v projektu ještě nevyskytla.
**Kde:** sentry.io → Alerts → Create Alert → Issues → "A new issue is created"
**Akce:** Send email to project members
**Filtr:** Environment: production

### Alert 2: Regression Alert
**Co:** Chyba která byla označena jako resolved se vrátila.
**Kde:** Alerts → "A previously resolved issue re-occurs"
**Akce:** Send email

### Alert 3: Error Rate Spike
**Co:** Více než 10 chyb za 1 minutu (abnormální spike).
**Kde:** Alerts → Metric Alert → event.type:error → threshold: 10/min
**Akce:** Send email

### Alert 4: Slow DB Query (performance)
**Co:** Střední hodnota db.query span > 500ms.
**Kde:** Alerts → Metric Alert → span.op:db.query p75 > 500ms
**Akce:** Send email
**Poznámka:** Vyžaduje tracesSampleRate > 0

## Kdy NEnastavovat alert
- Každý deploy (to je očekávaný "new issues" spike)
- DEV/staging environment (jen production)
