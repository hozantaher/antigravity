# Security Plan — Outreach System

**Datum:** 2026-04-11  
**Rozsah:** machinery-outreach (Go) + outreach-dashboard (React 19)  
**Zdroj:** Automatický audit, výsledky 2026-04-11

---

## Přehled rizik

| # | Závažnost | Služba | Problém |
|---|-----------|--------|---------|
| 1 | 🔴 HIGH | machinery-outreach | Open redirect v `/c` endpointu — `targetURL` bez validace |
| 2 | 🔴 HIGH | outreach-dashboard | `.env.local` s prod credentials může být commitnut |
| 3 | 🟠 MEDIUM | machinery-outreach | Žádný rate limiting na `/o`, `/c`, `/unsub` |
| 4 | 🟠 MEDIUM | machinery-outreach | `secureCompare()` používá statický HMAC klíč místo `subtle.ConstantTimeCompare` |
| 5 | 🟠 MEDIUM | machinery-outreach | Token `/o` a `/unsub` bez validace formátu (délka, charset) |
| 6 | 🟠 MEDIUM | outreach-dashboard | Chybí CSRF ochrana na POST/PATCH/DELETE routes |
| 7 | 🟠 MEDIUM | outreach-dashboard | Chybí audit log middleware pro citlivé akce |
| 8 | 🟡 LOW | machinery-outreach | Webhook bez HMAC podpisu |
| 9 | ✅ OK | outreach-dashboard | Session cookies: HttpOnly, SameSite=strict, Redis-backed |
| 10 | ✅ OK | outreach-dashboard | Argon2 hashing, rate-limited login, TOTP |

---

## Fáze 1 — Kritické opravy (implementovány 2026-04-11)

### 1.1 Open Redirect — `server.go:66-80`

**Problém:** `targetURL` z query parametru předán přímo do `http.Redirect()`.

```go
// ZRANITELNÉ
http.Redirect(w, r, targetURL, http.StatusFound)
```

**Oprava:** Parsovat URL a ověřit, že host sedí na allowlist z `TRACKING_BASE_URL`.

```go
func validateRedirectURL(rawURL, baseURL string) bool {
    parsed, err := url.Parse(rawURL)
    if err != nil { return false }
    base, err := url.Parse(baseURL)
    if err != nil { return false }
    return parsed.Host == base.Host && 
           (parsed.Scheme == "https" || parsed.Scheme == "http")
}
```

### 1.2 `.env.local` leak — dashboard

**Oprava:** Přidat do `.gitignore`, zkontrolovat git history.

---

## Fáze 2 — Rate Limiting (implementovány 2026-04-11)

### 2.1 In-memory rate limiter pro public endpointy

Token-bucket per IP, limity:
- `/o` (open pixel): 100 req/min/IP
- `/c` (click redirect): 50 req/min/IP  
- `/unsub`: 10 req/min/IP (nejcitlivější — mass opt-out attack)

Implementace: `golang.org/x/time/rate` + sync.Map pro per-IP buckets.

---

## Fáze 3 — Input hardening (implementovány 2026-04-11)

### 3.1 Token validace

Tokeny jsou hex-encoded SHA256 nebo UUID v4. Validovat regex před DB query:

```go
var validToken = regexp.MustCompile(`^[a-f0-9]{32,64}$`)
```

### 3.2 `secureCompare` fix

```go
// MÍSTO current HMAC wrapper
import "crypto/subtle"
return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
```

---

## Fáze 4 — Dashboard hardening (implementovány 2026-04-11)

### 4.1 CSRF middleware

Double-submit cookie pattern. Server vygeneruje `csrf_token` při loadu, klient posílá v `X-CSRF-Token` headeru, server ověří.

### 4.2 Audit log middleware

Logovat do `audit_logs` tabulky: `action`, `user_id`, `ip`, `timestamp`, `payload_summary` pro:
- login / logout / failed login
- PATCH /api/inbox (reklasifikace)
- PATCH /api/threads (close)
- admin actions

---

## Kontrolní seznam po implementaci

- [ ] `go test ./...` — všechny testy zelené
- [ ] `pnpm test` — dashboard unit testy zelené
- [ ] Manual: `/c?t=x&u=https://evil.com` → 400 Bad Request
- [ ] Manual: mass `/unsub` z jedné IP → 429 Too Many Requests
- [ ] Manual: krátký `t=abc` → 400 Bad Request (token too short)
- [ ] `.env.local` není ve `git status`

---

## Závislosti / žádné breaking changes

- Všechny opravy jsou backward-compatible
- Žádné schéma migrace potřeba (audit_log tabulka: nová)
- Rate limiter je in-memory (restart = reset, akceptovatelné pro tuto fázi)
