# Egress Fix Rollout — Hetzner CZ kernel-WG VPS

**Status:** active
**Vlastník:** operátor + Chat A (engineering)
**Datum založení:** 2026-05-01
**Datum uzavření:** —
**Trigger:** Brutal test 2026-05-01 prokázal 1/10 STARTTLS pass-rate přes wireproxy/wgsocks (oba userspace WG postavené nad `wireguard-go/tun/netstack`). Iterace bridgů (wireproxy v1.0.9 → v1.1.2 → in-house wgsocks PR #615) vykázaly 0 deltu — bug je hlouběji v gVisor TCP/IP layeru. 36/36 emailů dnes doručeno **pouze přes lokální kernel WG bypass**, ne přes anti-trace-relay. Před první ostrou kampaní (455 → 20 příjemců) musíme produkční egress fyzicky opravit. ADR-011 vybírá Option A (Hetzner CZ VPS); tato iniciativa exekvuje rollout.

## Kontext

Memory `seznam_proxy_geo_mismatch` byl dnes opraven — root cause není Mullvad reputation u Seznamu, ale gVisor netstack hangne při reassembly TLS server-flight fragmentu (5-10KB cert chain s OCSP staple + SCTs). Outlook (1.5KB) prochází; všech 8 ostatních hostů (Seznam, Gmail, Yahoo, Mailgun, SendGrid, Brevo, Fastmail, Zoho) hangne na 28s i/o timeout.

Plánovaná architektura post-rollout:

```
[BFF/orch] → [anti-trace-relay (Railway)] → SOCKS5(authenticated) → [Hetzner Falkenstein VPS] → kernel WG (wg-quick @mullvad-cz3) → SMTP recipient
```

Wgsocks zůstává v image jako `EGRESS_TRANSPORT=wgsocks` fallback; default flip na nový external SOCKS5 mode v sprintu 2.

Detailed decision rationale, alternative analysis, cost table, runbook → `docs/decisions/ADR-011-egress-kernel-wg-strategy.md`.

## Cíle

1. Stand up Hetzner CCX13 Falkenstein VPS s kernel WG + Dante SOCKS5 (≤2h setup)
2. Anti-trace-relay obrazovat na external SOCKS5 mode (`SOCKS_PROXY_ADDR=<vps-ip>:1080`); zachovat wgsocks fallback
3. Re-run brutal test: 10/10 STARTTLS hosts pass, 36/36 emails delivered přes relay (ne local bypass)
4. Anonymity score post-rollout ≥ 80/100 (combinaný s wgpool rotation)
5. 14-day stability window → cleanup wireproxy binary (separate follow-up PR)

## Plán (sprinty)

### Sprint S1 — VPS provisioning + kernel WG bring-up (1 den) {#sprint-s1}

Bare-metal stojící Hetzner CCX13 Falkenstein, kernel WG handshake confirmed, manual STARTTLS probe 10/10 pass.

- [ ] **S1.1** — Operátor objedná Hetzner CCX13 Falkenstein DE (€5.83/mo); získá static IP, SSH access. Alternative: Vultr Prague $6/mo pokud preferován native CZ exit.
- [ ] **S1.2** — Bootstrap Ubuntu 22.04 LTS box podle ADR-011 runbook Step 1
- [ ] **S1.3** — Z [Mullvad-WG.io](https://mullvad.net/en/account/wireguard-config) generate config pro `cz3-wireguard.mullvad.net`; `wg-quick up`, ověřit handshake
- [ ] **S1.4** — `curl --interface mullvad-cz3 https://am.i.mullvad.net/json` → potvrdit `{is_mullvad: true, country: "CZ"}`
- [ ] **S1.5** — Nainstalovat + configurovat Dante per ADR-011 Step 3
- [ ] **S1.6** — Vytvořit `antitrace` system uživatele s strong random heslem (1Password)
- [ ] **S1.7** — UFW: allow port 1080/tcp pouze z Railway egress CIDR. Pokud Railway egress range není stabilní, fallback na všeho-IP s aggressive fail2ban
- [ ] **S1.8** — Manual probe z dev boxu — 10 SMTP hostů přes openssl s_client -proxy. **DoD:** 10/10 STARTTLS pass <5s

**DoD sprintu:**
- `wg show` aktivní handshake
- `am.i.mullvad.net` confirms CZ exit
- Manual STARTTLS probe 10/10 přes proxy <30s total
- Credentials uložené v 1Password / SecOps store

---

### Sprint S2 — Anti-trace-relay rewire na external SOCKS5 (1 den) {#sprint-s2}

Update Railway ENV, ověření end-to-end přes anti-trace pipeline. Wgsocks/wireproxy zůstávají jako fallback bez code change.

- [ ] **S2.1** — Pokud existuje `EGRESS_TRANSPORT` switch s `external_socks5` mode v `features/outreach/anti-trace-relay/wgsocks` codebase: ověřit že čte `SOCKS_PROXY_ADDR` + `SOCKS_PROXY_USER/PASS` env. Pokud ne, micro-PR — minimal addition do bridge selection logic
- [ ] **S2.2** — Update Railway secrets na `anti-trace-relay`:
   - `SOCKS_PROXY_ADDR=<vps-ip>:1080`
   - `SOCKS_PROXY_USER=antitrace`
   - `SOCKS_PROXY_PASS=<strong-random>`
   - `EGRESS_TRANSPORT=external_socks5`
- [ ] **S2.3** — Trigger Railway redeploy. Sledovat logs — confirm bridge picks external_socks5
- [ ] **S2.4** — `GET /v1/egress-debug` na relay — confirm `egress_mode: external_socks5`
- [ ] **S2.5** — Through-relay STARTTLS probe — `POST /v1/probe` se správným `Authorization: Bearer`. 10/10 hosts pass
- [ ] **S2.6** — Re-run brutal test. 36 emailů musí jít přes relay (ne lokální bypass). **DoD:** 36/36 delivery rate, anonymity score per `reports/anonymity/<run-id>/`

**DoD sprintu:**
- Probe matrix `reports/brutal-post-vps-rollout/probe-matrix.md` shows 10/10 STARTTLS pass
- Brutal master `reports/brutal-post-vps-rollout/MASTER.md` confirms 36/36 delivery via relay path
- Anonymity score `reports/anonymity/<run-id>/score-report.md` ≥ 60/100 (před wgpool fix)
- Žádný change v `features/outreach/relay` core hot-path code

---

### Sprint S3 — Stabilization, observability, cleanup gating (1 den execute + 14 den window) {#sprint-s3}

Monitoring, alert thresholds, post-stability cleanup gate. Open paralelně Railway support ticket (Option B) + upstream wireguard-go issue (Option D).

- [ ] **S3.1** — Hetzner box monitoring: install `node_exporter` + cron checking `wg show` handshake age. Pokud handshake >5 min stale → alert
- [ ] **S3.2** — Dante log shipping: `/var/log/syslog` Dante connect/disconnect lines
- [ ] **S3.3** — Probe cron: každých 6 hodin spustit STARTTLS probe pro Seznam + Gmail z relay → if fail rate >10% za 24h → page operator
- [ ] **S3.4** — Open Railway support ticket asking for `--cap-add=NET_ADMIN` + `/dev/net/tun` mount (Option B)
- [ ] **S3.5** — Open issue na `github.com/WireGuard/wireguard-go` s minimal repro (Option D)
- [ ] **S3.6** — 14-day stability gate: pokud 2× per týden brutal test 36/36 + zero relay-pipeline alerts → trigger cleanup PR removing wireproxy binary z `features/outreach/anti-trace-relay/Dockerfile`
- [ ] **S3.7** — Update memory `seznam_proxy_geo_mismatch` s post-rollout outcome
- [ ] **S3.8** — Stretch: secondary VPS provisioning (Vultr Prague nebo Hetzner secondary region) jako warm standby

**DoD sprintu:**
- Handshake monitoring alert path tested
- Probe cron active, last 7-day fail rate <2%
- Railway ticket ID logged + status update v iniciative log po 7 dnech
- Wireguard-go issue # logged
- Po 14 dnech: cleanup PR mergnut nebo explicit decision dokumented why retain wireproxy

---

## Blokátory

- **Operátor must purchase Hetzner box** — engineering nemůže rollout-it bez VPS access. Sprint S1 blokován dokud VPS neexistuje.
- **Railway egress CIDR stability** — pokud Railway nepublikuje stabilní egress range, S1.7 musí spadnout zpět na "allow 0.0.0.0/0 + aggressive fail2ban"
- **`EGRESS_TRANSPORT=external_socks5` switch** — pokud aktuální wgsocks code path nepodporuje passthrough na externí SOCKS5 bez wireproxy/wgsocks ini, S2.1 vyžaduje malý PR

## Cross-references

- ADR: `docs/decisions/ADR-011-egress-kernel-wg-strategy.md` (this initiative is the execution arm)
- Reports: `reports/brutal-2026-05-01/MASTER.md`, `reports/brutal-2026-05-01/probe-matrix-post-wgsocks.md`
- Service guide: `features/outreach/relay/CLAUDE.md` (Egress + Known delivery limit)
- Subsystem map: `docs/subsystem-maps/anti-trace.md` (canonical 42-step pipeline, commit `db402237`)
- Memory: `seznam_proxy_geo_mismatch` (corrected 2026-05-01)
- Related initiative: `docs/initiatives/2026-05-01-cross-mailbox-anonymity-test.md` (post-rollout will exercise this)

## Log

- **2026-05-01** — Iniciativa založena. Trigger: brutal test 1/10 STARTTLS přes wgsocks/wireproxy. ADR-011 navržen + acceptován v draftu. Sprint S1 čeká na VPS purchase.
