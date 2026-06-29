# i18n (module)
![Version](https://img.shields.io/badge/version-v1.1.0-blue)


Vertical-axis module — see `plan.md` §2. i18n is a **data/asset module** (no UI/logic axis of its own).

- **Catalog (data):** `locales/*.yml` — 12 locales (ar, cz, de, en, fr, hr, me, nl, pl, rs, ru, ua), Vue i18n. Resolved via `nuxt.config` `i18n.restructureDir: 'features/i18n'` + `langDir: 'locales'`.
- **Contract:** 12-locale **key parity** against the `cz` baseline — every key in `cz.yml` exists in all locales (no fallback to cz).
- **Sibling (server):** `server/email/translations/*.ts` is the *separate* server-side email i18n (not Vue YAML) — stays under `server/email`.

Self-measure: `pnpm module:signal i18n` (12-locale key-parity).
