# Sentry + GitHub Setup

## GitHub Secrets (nastavit jednou)

Jdi do: **GitHub repo → Settings → Secrets and variables → Actions → New repository secret**

| Secret name | Kde vzít hodnotu |
|-------------|-----------------|
| `SENTRY_AUTH_TOKEN` | sentry.io → Settings → Auth Tokens → Create New Token (scope: `project:releases`, `org:read`) |
| `SENTRY_ORG` | sentry.io → Settings → General → Organization slug (např. `hozan-taher`) |
| `SENTRY_PROJECT_FRONTEND` | sentry.io → Projects → outreach-dashboard slug (např. `hozan-taher-frontend`) |
| `VITE_SENTRY_DSN_FRONTEND` | sentry.io → Projects → outreach-dashboard → Settings → Client Keys → DSN |
| `SENTRY_DSN_BFF` | sentry.io → Projects → outreach-bff → Settings → Client Keys → DSN |
| `SENTRY_DSN_GO` | sentry.io → Projects → outreach-go → Settings → Client Keys → DSN |

## Sentry Projects (vytvořit jednou)

1. sentry.io → New Project
2. Vytvořit 3 projekty:
   - `outreach-dashboard-frontend` — typ: **JavaScript/React**
   - `outreach-bff` — typ: **Node.js**
   - `outreach-go` — typ: **Go**
3. Pro každý zkopírovat DSN do GitHub Secrets výše

## GitHub → Sentry propojení (commit linking)

1. sentry.io → Settings → Integrations → GitHub
2. Install GitHub App → vybrat repo `hozan-taher`
3. V každém projektu: Settings → Source Code Management → Link repo
4. Teď se ke každé Sentry chybě zobrazí přímý link na commit, PR, a autor

## Lokální `.env` pro development

```bash
# features/platform/outreach-dashboard/.env (nepushovat!)
SENTRY_DSN_BFF=https://...@sentry.io/...
VITE_SENTRY_DSN_FRONTEND=https://...@sentry.io/...
SENTRY_AUTH_TOKEN=sntrys_...

# Pro source map upload při lokálním buildu
SENTRY_ORG=hozan-taher
SENTRY_PROJECT_FRONTEND=outreach-dashboard-frontend
```

```bash
# modules/outreach/.env
SENTRY_DSN_GO=https://...@sentry.io/...
```

## Jak funguje release tracking v CI

Při každém push na `main`:

1. `pnpm build` — Vite plugin nahraje source mapy do Sentry automaticky (pokud `SENTRY_AUTH_TOKEN` je nastaveno)
2. Sentry Release step:
   - `sentry-cli releases new <git-sha>` — vytvoří release
   - `sentry-cli releases set-commits --auto` — propojí release s commity (vyžaduje GitHub integration výše)
   - `sentry-cli releases finalize <git-sha>` — označí release jako hotový

## Co se zobrazí v Sentry po nastavení

- Každá chyba → přesný řádek zdrojového kódu (ne minifikovaný)
- Každá chyba → seznam commitů v dané release
- Každá chyba → přímý odkaz na GitHub commit / PR
- Release history → kolik nových vs. regresních chyb přinesl každý deploy
