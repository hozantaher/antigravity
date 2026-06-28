# ADR-007 — @hozan/dashboard-core: co patří do sdíleného UI balíčku

**Status:** Accepted
**Date:** 2026-04-23
**Relevant ticket:** #158

## Kontext

`features/platform/outreach-dashboard/` obsahuje sdílené UI primitiva (komponenty, hooky,
utility) které jsou importovány z více `services/*/ui/` barrelů
(`@hozan/contacts-ui`, `@hozan/campaigns-ui`, `@hozan/mailboxes-ui`,
`@hozan/inbox-ui`). Každý barrel teď re-exportuje fyzické soubory z
`src/` v monorepo dashboardu.

**Problém:** Při M6.2-B (fyzický přesun stránek do `services/*/ui/src/`) by
sdílené primitiva musely být buď duplikovány nebo importovány křížem
přes workspace boundary — oba přístupy jsou fragile.

**Řešení:** Zavést `@hozan/dashboard-core` jako skutečný workspace balíček
(`features/platform/dashboard-core/`) který vlastní sdílené primitiva. Všechny
`services/*/ui/` pak importují z `@hozan/dashboard-core`, nikoliv přes
relativní cesty.

## Rozhodnutí

Zavádíme `features/platform/dashboard-core/` jako pnpm workspace balíček
`@hozan/dashboard-core`. Do něj patří:

### Patří do @hozan/dashboard-core

| Kategorie | Soubory |
|-----------|---------|
| Design tokens | `src/styles/tokens.css`, typography, spacing, color scales |
| UI primitiva | `Button`, `Modal`, `SurfaceCard`, `Badge`, `Spinner`, `Toast` |
| Layout | `Layout.jsx`, `Sidebar`, `Topbar` |
| Sdílené hooky | `useToast`, `useStore` (zustand slice interface), `useKeyboardShortcuts` |
| Utility | `src/lib/tokens.js` (CSS var helpers), `src/lib/scoring.js`, `src/lib/emailVerify.js` |
| Sentry wrapper | `src/sentryInit.js`, `RouteErrorBoundary`, `fetchWithSentry` |

### NEPATŘÍ do @hozan/dashboard-core

| Kategorie | Důvod |
|-----------|-------|
| Feature pages (`Companies.jsx`, `Campaigns.jsx`, …) | Patří do `services/*/ui/` |
| BFF-specific utility (`server.js`, `authCache.js`) | Backend, ne UI |
| E2E testy | Patří k příslušné stránce |
| `store.js` (Zustand) | Zůstává v `features/platform/outreach-dashboard/` — obsahuje BFF URL |

### Kritéria pro zařazení

Komponenta/hook/utility patří do `@hozan/dashboard-core` pokud:
1. Je importována z ≥2 různých `services/*/ui/` barrelů
2. Nemá přímou závislost na BFF URL nebo backend-specific env vars
3. Nemá side-effecty specifické pro jednu stránku

## Důsledky

- **Pozitivní:** M6.2-B (fyzický přesun stránek) je bezpečný — závislosti
  jsou explicitní, ne implicitní přes relativní cesty
- **Pozitivní:** Stránky v `services/*/ui/` mohou být buildovány nezávisle
- **Pozitivní:** Sentry inicializace a error boundaries jsou na jednom místě
- **Negativní:** Další pnpm workspace balíček = více `pnpm install` overhead
- **Neutrální:** `features/platform/outreach-dashboard/` zůstává jako host app (Vite entry,
  routing, store) — nemaže se

## Implementační kroky (prerekvizita M6.2-B)

1. `mkdir features/platform/dashboard-core && pnpm init` → `@hozan/dashboard-core`
2. Přesunout soubory z tabulky "Patří" (fyzicky nebo re-export)
3. Aktualizovat pnpm-workspace.yaml: `features/platform/dashboard-core`
4. Aktualizovat importy v `features/platform/outreach-dashboard/src/` → `@hozan/dashboard-core`
5. Ověřit build dashboardu + unit testy

## Alternativy zvažované

- **Alt A: Nechat sdílené věci v `features/platform/outreach-dashboard/src/`** — nevyhovuje
  M6.2-B (fyzický přesun by způsobil import cycles nebo duplicitu)
- **Alt B: Kopírovat primitiva do každého `services/*/ui/`** — duplikace,
  divergence stylů, nehospodárné
- **Alt C: Jeden velký `@hozan/ui` monolith** — příliš velký coupling,
  blokuje nezávislé nasazení services
