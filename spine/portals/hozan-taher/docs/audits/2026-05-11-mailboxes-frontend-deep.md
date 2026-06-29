# Mailboxes Frontend Deep Audit
**Date:** 2026-05-11 | **Scope:** `/mailboxes` page + child components

---

## 1. Component tree

```
Mailboxes.jsx (1294 LoC)                        pages/Mailboxes.jsx
├── MissingPasswordBanner                        components/MissingPasswordBanner.jsx
│     props: mailboxes[]
├── SystemHealth banner (inline)                 Mailboxes.jsx:890–901
├── PageHead / PageStatStrip / PageStat          components/page (index)
├── MailboxHealthBoard                           components/mailboxes/MailboxHealthBoard.jsx
│     props: mailboxes[], onPick(mb)
├── PageToolbar                                  components/page
│   ├── SearchInput (ref forwarded)              components/SearchInput.jsx
│   ├── <select> status filter                   Mailboxes.jsx:957–965
│   ├── ChipGroup / Chip (health band)           components/page
│   ├── FilterCount / FilterX button             components/page
│   ├── RefreshCw / Loader button                Mailboxes.jsx:1003
│   └── DensityToggle                            components/page
├── Config drift banner (inline)                 Mailboxes.jsx:1015–1024
├── AnonymizationBar (inline)                    Mailboxes.jsx:190–321
│   ├── [pills: anti-trace, egress, watchdog, bounce guard]
│   ├── LaunchStatsRow (inline, hardcoded id=457) Mailboxes.jsx:137–187
│   ├── ProxyExhaustBanner                       components/ProxyExhaustBanner.jsx
│   └── PoolHealthWidget                         components/PoolHealthWidget.jsx
│         props: proxyPool, proxySources
│         └── PoolTrendSparkline                 components/PoolTrendSparkline (no source read)
├── OchranyPanel                                 components/OchranyPanel.jsx
│   props: intervalMs (none passed → default), layers
│   hooks: useProtectionsMatrix, useProtectionAlerts
├── RampStaircase                                components/RampStaircase.jsx
│   props: campaignId=457 (hardcoded Mailboxes.jsx:1043)
├── Bulk bar (inline, conditional)               Mailboxes.jsx:1047–1057
├── mb-table with SortTh, Sparkline rows         Mailboxes.jsx:1080–1264
│   └── [row] MailboxDrawer trigger (onClick)
├── MailboxDrawer                                components/mailboxes/MailboxDrawer.jsx (752 LoC)
│   props: mb, siblings, toast, onClose, onEdit, onToggle, onDelete,
│          onAssignProxy, onWarmupToggle, onNavigate, antiTraceOk
│   ├── SectionStav → ScoreHero                 MailboxDrawer.jsx:59–116
│   ├── SectionPouziti                           MailboxDrawer.jsx:120–170
│   ├── SectionAkce                              MailboxDrawer.jsx:173–265
│   └── SectionPokrocile (<details>)             MailboxDrawer.jsx:269–457
│       ├── per-check breakdown (CHECK_ROWS)
│       ├── Warmup section
│       ├── Protections / secItems
│       ├── Statistiky (DrawerMetricGrid)
│       └── Připojení + assign-proxy button
├── MailboxModal (add / edit)                    Mailboxes.jsx:40–127
├── CsvImportModal                               Mailboxes.jsx:376–437
└── Confirm (delete confirm)                     components/Confirm.jsx
```

---

## 2. Action inventory

### Mailboxes.jsx

| Action | file:line | URL + method | Optimistic / refetch | Error UX |
|--------|-----------|-------------|----------------------|----------|
| Přidat schránku (save) | 753–756 | `POST /api/mailboxes` via store | store prepends to array (no rollback) | `toast('Chyba při přidávání', 'err')` |
| Uložit (edit modal) | 757–760 | `PATCH /api/mailboxes/:id` via store | store merges response | `toast('Chyba při ukládání', 'err')` |
| Aktivovat / Pozastavit (row toggle) | 761–769 | `PATCH /api/mailboxes/:id` `{status}` via store | store merges | `toast('Chyba', 'err')` — generic |
| Warmup toggle | 771–781 | `PATCH /api/mailboxes/:id/warmup` | `reloadMailboxes()` after | `toast('Chyba warmup', 'err')` |
| Smazat | 782–789 | `DELETE /api/mailboxes/:id` via store | store filters | `toast('Chyba', 'err')` — generic |
| Row re-check (health pill) | 874–883 | `GET /api/mailboxes/:id/full-check?force=1` | `setLiveScores` directly | silent `.catch({})` — **no toast** |
| Přiřadit proxy (per-row) | 814–826 | `POST /api/mailboxes/:id/assign-proxy` | `updateMailbox(id,{proxy_url})` | `toast(data.error+detail, 'err')` |
| Import CSV | 381–402 | `POST /api/mailboxes/import-csv` | `onDone()→reloadMailboxes()` | `toast` via result.ok flag inline |
| Bulk Aktivovat | 742–751 | `PATCH /api/mailboxes/:id` per-id loop | store merges each | `toast('Hotovo (N)', 'ok')` — no per-item error |
| Bulk Pozastavit | 742–751 | `PATCH /api/mailboxes/:id` per-id loop | store merges each | same — no per-item error |
| Bulk Přiřadit proxy | 828–853 | `POST /api/mailboxes/bulk-assign-proxy` | `updateMailbox` per ok result | `toast` with partial fail count |
| Bulk Full-check | 855–872 | `POST /api/mailboxes/bulk-check` | `setTimeout(12000, fetch health-summary)` | `toast('Chyba', 'err')` — generic; 12s hardcoded delay |
| Refresh button | 694–697 | `GET /api/mailboxes/health-summary` + proxy-pool?refresh=1 | `setLiveScores` + `setProxyPool` | no error toast (silent) |
| HealthBoard tile click | 938–944 | — (sets `?q=` URL param) | — | — |
| Filter reset (Escape / button) | 500–506 | — | — | — |
| 'n' / 'N' shortcut | 801 | — opens MailboxModal | — | — |

### MailboxDrawer.jsx

| Action | file:line | URL + method | Optimistic / refetch | Error UX |
|--------|-----------|-------------|----------------------|----------|
| Run live check (ScoreHero button) | 501–509 | `GET /api/mailboxes/:id/full-check?force=1` | `setLiveResult` | silent catch — **no toast** |
| Reset AUTH | 511–527 | `POST /api/mailboxes/:id/auth-reset` `{reason}` | none — no store update | `toast('AUTH reset selhal: msg', 'err')` |
| Aktivovat/Pozastavit (drawer) | 199–207 | `PATCH /api/mailboxes/:id` via prop `onToggle` | delegated to parent | delegated |
| Test odeslání | 529–547 | `POST /api/mailboxes/:id/send-test` `{to}` | none | `toast('Test selhal: msg', 'err')` |
| Diagnostika | 554–568 | `GET /api/mailboxes/:id/full-check?force=1` | `setLiveResult` + `setDiagResult` | inline `diagResult` panel |
| Upravit | 232–237 | — lifts `onEdit(mb)` to parent | — | — |
| Smazat | 239–246 | — lifts `onDelete(mb.id)` | — | — |
| Navigate campaign (Použití list) | 549–552 | — `navigate('/campaigns/:id')` | — | — |
| Přiřadit proxy (Pokročilé) | 441–454 | — lifts `onAssignProxy(mb.id)` | — | — |
| Warmup toggle (Pokročilé) | 367–375 | — lifts `onWarmupToggle(mb)` | — | — |
| Copy diagnostics | 612–623 | `navigator.clipboard.writeText` | — | `toast('Kopírování selhalo', 'err')` |
| Nav prev/next (J/K) | 601–610 | — `onNavigate(±1)` | — | — |

**On drawer open**, 4 fetches fire simultaneously (line 485–498):
- `GET /api/mailboxes/:id/full-check`
- `GET /api/mailboxes/:id/check-history`
- `GET /api/mailboxes/:id/stats`
- `GET /api/mailboxes/:id/campaigns`

All 4 use silent `.catch(() => {})` — **no loading skeleton for `liveResult`, `stats`** (only `usageLoading` drives a skeleton for Použití section).

---

## 3. State management

### Zustand store (`src/store.js`)

- `mailboxes[]` — fetched via `loadAll()` / `reloadMailboxes()`. No dedicated `useMailboxes` hook; page binds via `useStore(s => s.mailboxes)` etc.
- CRUD actions: `addMailbox` (prepend), `updateMailbox` (merge), `deleteMailbox` (filter). No rollback on any action — failure throws, caller catches and toasts.
- No optimistic writes: `updateMailbox` awaits PATCH before updating store (lines 56–59).

### Local state in Mailboxes.jsx

| State | Type | Purpose |
|-------|------|---------|
| `liveScores` | `{}` | Per-mailbox `{score, ok, critical}` from health-summary + SSE |
| `sendTrends` | `{}` | 7-day sparkline data per mailbox id |
| `antiTrace` | obj/null | One-time fetch on mount, never refreshed |
| `proxyPool` | obj/null | Fetched on mount; refresh via refreshProxyPool() |
| `proxySources` | obj/null | 60s interval poll |
| `systemHealth` | obj/null | 15s interval poll |
| `watchdogHealth` | obj/null | 15s interval poll |
| `configDrift` | obj/null | 60s interval poll |
| `launchStats` | obj/null | 15s interval poll, hardcoded campaign 457 |
| `rowChecking` | `Set` | Which rows have in-flight row-level full-check |
| `selected` | `Set` | Bulk-selection ids |
| `sortKey/sortDir` | string | Table sort |
| `density` | string | Compact/normal — persisted in localStorage via useDensity |
| `lastFetchedAt/isRefreshing` | timestamp/bool | Refresh button UX |
| `nowTick` | timestamp | 5s tick for relative time labels |
| `alertedAt` | `useRef(Map)` | Throttle low-score toasts (1/hr/mailbox) |

### SSE stream

- `EventSource('/api/mailboxes/health-stream')` (Mailboxes.jsx:636–672)
- Listens for `mailbox` events → merges into `liveScores`
- Exponential backoff reconnect (1s → 30s cap)
- Polling at `HEALTH_REFRESH_MS = 15_000` ms continues as fallback

### Polling intervals summary

| Endpoint | Interval | Tab-hidden guard |
|----------|----------|-----------------|
| `/api/mailboxes/health-summary` | 15s | `document.hidden` check |
| `/api/health/proxy-sources` | 60s | yes |
| `/api/health/system` | 15s | yes |
| `/api/health/watchdog` | 15s | yes |
| `/api/health/drift` | 60s | yes |
| `/api/campaigns/457/launch-stats` | 15s | yes |
| `/api/health/proxy-exhaust` (ProxyExhaustBanner) | 60s (default) | yes |
| OchranyPanel matrix | 30s (default, via `useProtectionsMatrix`) | unknown |

---

## 4. Hardcoded / broken patterns

### Magic numbers / hardcoded IDs
- `LAUNCH_CAMPAIGN_ID = 457` — Mailboxes.jsx:136. Used in both `LaunchStatsRow` display and `RampStaircase` prop (line 1043). Breaks silently if campaign 457 is deleted (both self-hide on 404, graceful but not configurable).
- `HEALTH_REFRESH_MS = 15_000` — Mailboxes.jsx:30. Reasonable, but duplicated by 4 separate `setInterval` calls each also using 15_000 ms. Could be unified.
- Bulk-check result-check delay: `setTimeout(..., 12000)` — Mailboxes.jsx:864. Hardcoded; if full-check is slower than 12s the refresh fires on stale data.

### TODO / FIXME / HACK
None found in either file via grep. Comments are explanatory docs, not deferred work markers.

### Disabled buttons with conditions
- MailboxModal Save button disabled when `!valid` (Mailboxes.jsx:78) — correct.
- Drawer toggle disabled for `bounce_hold` / `retired` — correct. But `handleToggle` in parent also guards this; double guard is safe.
- Drawer "Reset AUTH" is conditionally rendered only when `auth_fail_count > 0 || circuit_opened_at` (MailboxDrawer.jsx:177). If Go backend resets these before UI polls, the button disappears — expected.

### Error paths that are silent / unreachable
- `rowRecheck` (Mailboxes.jsx:874–883): `catch {}` swallows errors silently — **no toast**. Operator sees spinner hang then nothing if relay is down.
- `runLiveCheck` in drawer (MailboxDrawer.jsx:501–509): `catch { /* keep prior */ }` — silent. Score hero stays stale with no feedback.
- All 4 drawer-open fetches use `.catch(() => {})` — no error state rendered if any fetch fails.
- `refreshAll` → `refreshProxyPool` (Mailboxes.jsx:688–697): silent `catch(() => null)` — pool pill stays at prior value or null, no operator notification.
- `antiTrace` fetch (Mailboxes.jsx:529): sets `{ ok: false, reason: 'fetch_error' }` — pill shows "DOWN". Correct.
- `sendTrends` fetch (Mailboxes.jsx:608–616): silent catch — sparklines just don't render. Acceptable.

### Refetch loop risk
- `useEffect(() => { fetchHealth() }, [mailboxes.length, fetchHealth])` — Mailboxes.jsx:605. Triggers health fetch whenever any mailbox is added or removed. `fetchHealth` is memoized with `useCallback([], [])` so the dep is stable. Low risk but could double-fire during initial `loadAll`.
- No infinite loop potential found — all intervals are cleared in cleanup.

### Missing loading skeleton
- `liveResult` (check breakdown in Pokročilé section): no skeleton while initial full-check loads. `ScoreHero` shows spinner for `liveLoading` but `liveLoading` is only true for manual re-runs, not the initial fetch.
- `stats` (drawer Statistiky): shows `'…'` as value strings — minimal but functional.

---

## 5. Accessibility / UX gaps

### aria-label on icon-only buttons
- Row Pause/Play button (Mailboxes.jsx:1246): has `aria-label` — correct.
- Row Pencil/Edit button (Mailboxes.jsx:1254): has `aria-label` — correct.
- Health pill recheck button (Mailboxes.jsx:1188–1196): title only, no `aria-label` — **missing**.
- Refresh button (Mailboxes.jsx:1003–1009): has `aria-label="Obnovit data"` — correct.
- Drawer close button (MailboxDrawer.jsx:654): has `aria-label="Zavřít"` — correct.
- Drawer copy-diagnostics button (MailboxDrawer.jsx:686): has `aria-label` — correct.
- Drawer nav prev/next (MailboxDrawer.jsx:663–681): both have `aria-label` — correct.
- OchranyPanel alert ack button (OchranyPanel.jsx:234): has `aria-label` — correct.
- OchranyPanel "Obnovit" button (OchranyPanel.jsx:211): no `aria-label`, text label only — acceptable.

### Keyboard navigation
- Table rows: full Up/Down/Home/End/Enter/Space support (Mailboxes.jsx:1123–1143). Good.
- Page shortcuts: `/` focus search, `n` new, `Escape` reset filters (Mailboxes.jsx:795–807). Good.
- Drawer: Tab trap implemented (MailboxDrawer.jsx:581–597). Escape closes. j/k sibling navigation.
- OchranyPanel LayerRow: `role="button"` + `tabIndex={0}` + `onKeyDown` Enter/Space (OchranyPanel.jsx:119–122). Good.
- MailboxHealthBoard tiles: `<button>` with `aria-label` — correct.
- **Gap**: `<select>` for status filter has `aria-label` but no visible label element — relying solely on aria-label, which is fine for screenreaders but invisible to sighted users.

### Focus management
- Drawer open: first focusable element receives focus (MailboxDrawer.jsx:571–578). Return focus on close via `previouslyFocused.current?.focus()`. Correct.
- Modal open (`MailboxModal`): `autoFocus` on email field (new) or password field (edit) via input `autoFocus` prop (Mailboxes.jsx:85, 112). Correct.
- **Gap**: when drawer closes via backdrop click (`drawer-bg onClick`), focus returns to previously focused — but that may be a table row button, which is `role="button"` with tabIndex, so focus is recoverable. Acceptable.

### Toast feedback gaps
- Row-level `rowRecheck`: no toast on error (Mailboxes.jsx:874–883).
- Drawer `runLiveCheck`: no toast on error (MailboxDrawer.jsx:507).
- Bulk actions: `bulkAction` emits a single success toast but swallows per-item PATCH errors (Mailboxes.jsx:742–751). If one of N mailboxes fails, the count still says "Hotovo (N)".

---

## 6. Per-feature working/broken map

| Feature | Status | Notes |
|---------|--------|-------|
| Přidat schránku (modal) | working | validation, toast, store prepend |
| Upravit schránku | working | deep-link `?edit=<id>` auto-opens with password autofocus |
| Smazat schránku | working | Confirm dialog, drawer close on delete |
| Aktivovat / Pozastavit (row) | working | bounce_hold/retired guard present |
| Aktivovat / Pozastavit (drawer) | working | same guard |
| Bulk Aktivovat / Pozastavit | partial | per-item errors silently ignored; only aggregate toast |
| Bulk Přiřadit proxy | working | per-result error aggregation, partial-fail toast |
| Bulk Full-check | partial | 12s hardcoded delay before health refresh; errors generic |
| Per-row Full-check (health pill) | partial | works but no toast on error; spinner hangs silently on failure |
| Drawer: full-check on open | partial | no loading skeleton for liveResult; silent on failure |
| Drawer: Run live check (ScoreHero) | partial | spinner shown, but silent error |
| Drawer: Reset AUTH | working | confirm dialog, toast ok/err |
| Drawer: Test odeslání | working | window.prompt for target, toast ok/err |
| Drawer: Diagnostika | working | inline result panel, syncs Stav hero |
| Drawer: Použití (campaign list) | working | skeleton during load, navigate on click |
| Drawer: Warmup toggle | working | lifted to parent, reloadMailboxes |
| Drawer: Přiřadit proxy (Pokročilé) | working | lifted to parent handler |
| Drawer: Copy diagnostics | working | clipboard, toast |
| Drawer: j/k navigation | working | sibling-aware, updates URL |
| CSV Import | working | per-row result display, reloadMailboxes on done |
| MailboxHealthBoard tiles | working | filters table via ?q= URL param |
| Health band chips filter | working | URL-persisted, counts shown |
| Status filter select | working | URL-persisted |
| Search (/ shortcut) | working | URL-persisted, SearchInput ref |
| Sort columns | working | multi-column, toggle dir |
| Density toggle | working | localStorage-persisted |
| SSE health stream | working | exponential backoff, merges liveScores |
| AnonymizationBar (anti-trace pill) | working | one-time fetch on mount, not refreshed |
| AnonymizationBar (egress pill) | working | mullvad / wg-pool / rotating-pool modes |
| LaunchStatsRow (campaign 457) | partial | hardcoded ID — breaks if campaign 457 retired |
| RampStaircase (campaign 457) | partial | same hardcoded ID concern |
| OchranyPanel matrix | working | expand/collapse, alert ack, manual refresh |
| MissingPasswordBanner | working | prop-fed or own fetch fallback |
| ProxyExhaustBanner | working | 60s poll, only triggers on `state.triggered` |
| PoolHealthWidget | working | mode-aware (mullvad vs rotating-pool) |
| Config drift banner | working | critical-only, 60s poll |
| Watchdog heartbeat pill | working | stale detection |
| Bounce guard pill | working | derived from mailboxes store |
| Low-score alert toast | working | 1/hr/mailbox throttle via alertedAt ref |
| ?edit=<id> deep-link | working | strips param after open |
| ?mb=<id> deep-link (drawer) | working | URL-persisted, reload-safe |
| Empty state (no mailboxes) | working | links to add/import |
| Empty state (filters) | working | filter reset button |
