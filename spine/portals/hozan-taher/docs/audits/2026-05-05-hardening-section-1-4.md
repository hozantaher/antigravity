# Hardening Audit: Pages 1–4

**Datum:** 2026-05-05  
**Scope:** PripravaRana, PripravaHesla, Replies, ThreadDetail, Campaigns, CampaignDetail, Mailboxes

---

## PripravaRana (`/priprava`)

| Edge case | Severity | Fix recommendation |
|-----------|----------|-------------------|
| Loading state: bare text "Načítám…" — no skeleton cards | HIGH | Replace with skeleton card rows matching StepCard layout |
| Error state: raw minimal div without consistent styling | MEDIUM | Use consistent error banner component with styled retry button |
| EgressCard loading: "Načítám egress stav…" shown inside card while main page ready | LOW | Add inline spinner to EgressCard header |
| Stale data warning: refresh shows time but no "stale > 2 min" indicator | MEDIUM | Add visual stale badge when refreshedAt is >120s ago |
| `testAllMailboxes` network fail: error message disappears after 32s timeout | HIGH | Keep error message visible; don't override with null after timeout if error |
| Blocker section keyboard navigation: no `aria-live` on not-ready banner | MEDIUM | Add `aria-live="polite"` so screen readers announce readiness change |
| Missing CTA accessibility: "Pokračovat na Novou kampaň" has no keyboard focus indicator | MEDIUM | Ensure `:focus-visible` ring on launch CTA |
| No confirmation before campaign launch from Příprava CTA | LOW | Already links to `/campaigns?new=1` (modal), acceptable |

## PripravaHesla (`/priprava/hesla`)

| Edge case | Severity | Fix recommendation |
|-----------|----------|-------------------|
| Loading state: bare text "Načítám…" — no skeleton | HIGH | Add skeleton rows for password form |
| No per-row min-length validation before Save (8+ chars constraint only in placeholder) | HIGH | Show inline error per row when password < 8 chars on blur/submit |
| Partial save failure: `results.errors` shown as count only, no detail per row | MEDIUM | Already handles per-row result display in `pwd-ok/err` testids — OK |
| No "reveal password" toggle on password inputs | MEDIUM | Add show/hide toggle button per row |
| Auto-redirect (1.5s) blocks operator from reviewing errors | MEDIUM | Only redirect when no errors; show errors and keep user on page |
| No Escape key to cancel | LOW | Add keyboard handler: Escape → navigate('/priprava') |
| Tab order: form fields tabIndex fine but Save button is far from last input | LOW | Acceptable given grid layout |

## Replies (`/replies`)

| Edge case | Severity | Fix recommendation |
|-----------|----------|-------------------|
| Table loading: no skeleton rows, just disappears and reappears | HIGH | Add skeleton table rows during `listStatus === 'loading'` |
| Stats error: shows generic text, no retry on stats banner | MEDIUM | Already has retry button on statsRes.status==='error' — OK |
| Empty state: generic icon + text, no time-period filter hint | MEDIUM | Add "Vyber jiný filtr" hint on `tab !== 'all'` empty state |
| SlideOver: no `aria-modal` / focus trap | HIGH | Add focus trap to SlideOver overlay |
| SlideOver: close on Escape not implemented | HIGH | Add `useEffect` keydown handler for Escape |
| Row hover actions: Reply mailto link opens external email client without warning | LOW | Acceptable for power-user workflow |
| Concurrent tab changes: rapid tab switching can show stale data briefly | LOW | Cancel pending load on tab change (already handled by `setRows` on off=0) |
| Keyboard navigation in table: rows not focusable, no arrow key navigation | HIGH | Add `tabIndex={0}` and Enter/Arrow handlers to rows |

## ThreadDetail (`/replies/:id`)

| Edge case | Severity | Fix recommendation |
|-----------|----------|-------------------|
| Loading state: plain text "Načítám…" — no skeleton | HIGH | Add skeleton for message bubble area and meta card |
| Error state: plain `<p style={{ color: T.danger }}>Nenalezeno</p>` — no retry, no back button | HIGH | Add retry button + back-to-replies navigation link on error |
| Reply send: success state "Odesláno" text stays indefinitely | MEDIUM | Auto-clear `sent=true` after 5s |
| Unsubscribe: `window.confirm()` blocks UI thread | HIGH | Replace with inline confirmation panel |
| File attachment picker: no visual "Add attachment" button, just label text | MEDIUM | Add explicit "Přidat přílohu" button with icon |
| Context sidebar: no loading skeleton when context fetch is slow | LOW | Add skeleton for sidebar |
| Message compose: `width: '100%'` textarea but no `maxWidth` guard on wide screens | LOW | Acceptable inside flex column |

## Campaigns (`/campaigns`)

| Edge case | Severity | Fix recommendation |
|-----------|----------|-------------------|
| Loading state: no indicator — campaigns come from Zustand store synchronously, but store may be empty on first load | MEDIUM | Store already hydrates from BFF; empty state renders immediately — OK |
| Empty state when filter active: good CTA "Zrušit filtr" | OK | — |
| Delete confirmation: uses Confirm component — OK | OK | — |
| No "Clone campaign" feature | MEDIUM | File as enhancement issue |
| No "Pause all" emergency button | MEDIUM | File as enhancement issue |
| No loading feedback on status toggle (Play/Pause button) | HIGH | Show loading spinner on the specific row button during setCampaignStatus |
| Status toggle 412 error: shows Czech label in toast — good | OK | — |
| Keyboard nav: table rows not focusable | MEDIUM | Add `tabIndex={0}` + Enter handler on campaign rows |

## CampaignDetail (`/campaigns/:id`)

| Edge case | Severity | Fix recommendation |
|-----------|----------|-------------------|
| Loading state: generic centered "Načítám…" text — no skeleton | HIGH | Add skeleton for KPI strip + tab bar |
| 404: toast + navigate('/campaigns') — good pattern | OK | — |
| Gate modal: qualityLoading shows "Načítám…" only — no spinner | MEDIUM | Add `<Loader>` spinner icon next to loading text |
| Reset modal: clicking backdrop closes without confirmation when form has content | MEDIUM | Warn if confirmName or reason not empty before closing backdrop |
| Sends tab loading: no skeleton during sendsLoading=true | HIGH | Add skeleton table rows |
| Reply tab: just shows count + link; no inline preview | LOW | Acceptable redirect pattern |
| Auto-refresh while running: `setInterval(30s)` — good, but no visual indicator of next refresh | LOW | Add "aktualizuji za Xs" countdown — nice-to-have |

## Mailboxes (`/mailboxes`)

| Edge case | Severity | Fix recommendation |
|-----------|----------|-------------------|
| Loading state: no skeleton — table appears instantly from store | OK | Zustand synchronous |
| MailboxModal: valid check `f.email && f.smtp_host && f.smtp_username && f.password` — no per-field validation messages | HIGH | Add per-field inline error on blur |
| Delete confirmation: uses Confirm — OK | OK | — |
| SSE reconnect: exponential backoff implemented — good | OK | — |
| Bulk action on `bounce_hold` mailboxes: silently skips without user feedback | MEDIUM | Toast which mailboxes were skipped + why |
| CSV import: no column validation — silently imports wrong data | HIGH | Validate header row; show error if required columns missing |
| `window.confirm` pattern: not used here (uses Confirm component throughout) | OK | — |
| Keyboard shortcuts: `/` for search, `n` for new, `Escape` to reset — documented in title attributes but no hint in UI | MEDIUM | Add keyboard shortcut hint bar or tooltip |
| Per-mailbox IMAP/SMTP diagnostic button: not present | HIGH | File as enhancement issue — high operator value |

---

## Summary

| Page | HIGH severity | MEDIUM severity | LOW severity |
|------|--------------|-----------------|--------------|
| PripravaRana | 2 | 4 | 2 |
| PripravaHesla | 2 | 3 | 2 |
| Replies | 4 | 2 | 2 |
| ThreadDetail | 4 | 3 | 2 |
| Campaigns | 1 | 3 | 1 |
| CampaignDetail | 2 | 3 | 1 |
| Mailboxes | 2 | 3 | 1 |
| **Total** | **17** | **21** | **11** |
