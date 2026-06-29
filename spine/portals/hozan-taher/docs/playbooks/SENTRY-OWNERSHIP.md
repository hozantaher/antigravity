# Sentry Issue Ownership Rules

## Nastavení v sentry.io → Settings → Ownership Rules

Formát: `path:pattern owner@email.com`

### Pravidla (nakopíruj do Ownership Rules textového pole)

```
# BFF routes
url:*/api/analytics/* tomáš@hozan.cz
url:*/api/campaigns/* tomáš@hozan.cz
url:*/api/mailboxes/* tomáš@hozan.cz
url:*/api/companies/* tomáš@hozan.cz

# Go services
path:features/inbound/orchestrator/* tomáš@hozan.cz
path:features/outreach/campaigns/* tomáš@hozan.cz
path:features/outreach/relay/* tomáš@hozan.cz

# React frontend
path:features/platform/outreach-dashboard/src/pages/* tomáš@hozan.cz
```

## Co ownership pravidla dělají
- Při nové chybě → automaticky assign owner na issue
- Owner dostane email pokud má alert nakonfigurovaný
- Pomáhá identifikovat kdo zná daný kód
