# ADR-011 — Production egress: Hetzner CZ kernel-WG VPS

**Status:** Proposed
**Date:** 2026-05-01
**Related:**
- [ADR-002 — Autonomous Ops Architecture](ADR-002-autonomous-ops-architecture.md)
- [ADR-004 — Mail Lab + Operator Practice](ADR-004-mail-lab-and-operator-practice.md)
- Subsystem map: `docs/subsystem-maps/anti-trace.md` @ commit `db402237` (PR #565, CAD-M1, canonical 42-step pipeline)
- Initiative: `docs/initiatives/2026-05-01-egress-fix-rollout.md`
- Reports: `reports/brutal-2026-05-01/MASTER.md`, `reports/brutal-2026-05-01/probe-matrix-post-wgsocks.md`
- Memory: `seznam_proxy_geo_mismatch` (corrected 2026-05-01: bug is gVisor/userspace WG, not Mullvad reputation)

## Kontext

Brutal test 2026-05-01 prokázal, že **userspace WireGuard pipeline doručuje 1/10 STARTTLS hostů** (pouze Outlook s ~1.5KB cert chainem). Seznam, Gmail, Yahoo, Mailgun, SendGrid, Brevo, Fastmail i Zoho hangují na 28s i/o timeoutu při čtení druhého TCP segmentu TLS server-flightu (5-10KB cert chain s OCSP staple + SCTs).

Iterace bridgů — wireproxy v1.0.9 → windtf fork v1.1.2 → in-house wgsocks (PR #615) — daly **0 delty**: identický pass/fail vzorek napříč všemi třemi implementacemi. Diagnóza je shoda na vrstvě níž: `wireguard-go/tun/netstack` (gVisor TCP/IP) hangne při reassembly fragmentu napříč WG MTU 1420.

Důkaz, že to **není** Mullvad reputation: operátorův macOS Mullvad app (kernel WG, identický exit) doručil 36/36 emailů do Seznamu v rámci dnešního brutal testu (run-id `e8d5964d`). Pipeline anti-trace-relay přes Railway dnes doručil 0. Anonymity score dnešního brutal testu: 17/100 (single-egress + bypass přes lokální kernel WG, ne přes náš relay).

Memory `seznam_proxy_geo_mismatch` byl dnes opraven — původní hypotéza (Mullvad CZ exit blokovaný Seznamem) byla nesprávná. Skutečná root cause je gVisor netstack TCP fragmentation hang.

Před první ostrou kampaní (455 → 20 příjemců, machinery sektor) musíme vybrat produkční egress strategii, která **doručuje** + **zachovává privacy-hardened framing** (žádné transactional API kompromitující obsah/metadata).

## Rozhodnutí

**Zavádíme Option A — Hetzner CZ VPS s kernel WireGuard a Dante SOCKS5 jako produkční egress pro anti-trace-relay.** Anti-trace-relay zůstává na Railway, ale `SOCKS_PROXY_ADDR` ukazuje na veřejný IP nového VPS, port 1080 (heslem chráněný + IP-allowlistovaný na Railway egress range). Wgsocks zůstává v image jako fallback (`EGRESS_TRANSPORT=wgsocks`) pro případ ztráty VPS.

### Zvažované alternativy

#### Option B — Railway support ticket pro `CAP_NET_ADMIN` + `/dev/net/tun` — odmítnuto

Stays-in-Railway varianta. Otevřít support ticket s žádostí o `--cap-add=NET_ADMIN` a TUN device mount. Pokud by Railway vyhověl, mohli bychom běžet `wg-quick` v relay containeru a obejít gVisor.

**Proč ne (jako primární):** Railway managed runtime tyto capabilities standardně nedává; ETA odpovědi neznámé, pravděpodobnost odmítnutí vysoká (typický pattern u managed PaaS). **Necháváme ticket otevřený jako paralelní snahu** — pokud do Sprintu 3 dorazí kladná odpověď, můžeme migrovat zpět a vyřadit VPS.

#### Option C — Transactional email service (Mailgun EU / Postmark / SendGrid CZ) — odmítnuto

Outsource SMTP egress entirely; engine přepnout na HTTPS API.

**Proč ne:** Defetuje smysl privacy-hardened relaye — provider vidí plný obsah + metadata + per-recipient unsubscribe. Za 4 týdny budované anti-trace pipeline (T1-T8 + D1-D8 v `docs/subsystem-maps/anti-trace.md`) by se stalo dead code. Audit ratchet `no_bypass=0` baseline by se musel přeformulovat. Operátorský B2B kontext valuje "neprozradí infrastrukturu" jako must-have. Cena $15-50/mo srovnatelná s Hetzner kernel-WG VPS, ale tradeoff je úplně nesprávným směrem.

**Necháváme jako tier-2 fallback** pro nouzový provoz pokud VPS i Railway ticket selžou současně.

#### Option D — Wait for upstream `wireguard-go/tun/netstack` fix — odmítnuto jako primární

Filovat issue u WireGuard/wireguard-go s reprodukcí gVisor TCP fragmentation hangu.

**Proč ne (jako primární):** ETA neznámá; netstack maintenanceware může mít měsíce-rokový backlog. Blokovalo by produkční launch indefinitely.

**Děláme paralelně:** otevřeme issue s minimal repro (zachycený SCT-laden TLS handshake + SOCKS5 trace).

## Důsledky

### Pozitivní

- **Skutečný fix.** Kernel WG never hits gVisor; Dante SOCKS5 streamuje TCP po reálné TUN interface. Doručitelnost na Seznam/Gmail/Yahoo/atd. by měla být 10/10 (mirror dnešního local-Mullvad výsledku).
- **Mullvad rotation zachována.** Na VPS běží `wg-quick` proti Mullvadu — operátor může ručně rotovat WG configy, případně paralelně poolovat (ekvivalent stávajícího `wgpool` modu, ale na kernel level).
- **Privacy-hardened framing zachován.** Anti-trace-relay (Railway) → SOCKS5 (VPS) → kernel WG → Mullvad → SMTP recipient. Recipient vidí Mullvad CZ IP; my zachováváme T1-T8/D1-D8 envelope hardening.
- **Uvolňuje wgsocks z hot-pathu.** Wgsocks zůstává jako EGRESS_TRANSPORT=wgsocks fallback; tlak na rychlý gVisor fix mizí.
- **Audit kontinuita.** Audit ratchet `no_bypass` baseline 0 zůstává platný — pipeline kód se nemění, mění se jen `SOCKS_PROXY_ADDR` env.

### Negativní

- **Separate infra k operativě.** VPS s SSH klíči, OS patche, monitoring. Jednočlenný operátorský team — každá další box je distrakční náklad.
- **OPEX €60-120/yr** + cca 3-5h/yr OS maintenance.
- **Single-region SPOF.** CZ VPS = single point of failure. Mitigace v rollout runbooku (warm fallback na wgsocks, případně secondary VPS jako stretch goal).
- **VPN abuse policy.** Hetzner ToS dovoluje VPN klientský provoz; Mullvad jako outbound je commodity. Mailing throughput musí zůstat normálních B2B objemů (≤500/den).

### Neutrální

- **Anti-trace-relay container nemění.** Pouze ENV se updatuje. Žádný code change v Go pipeline, žádný PR proti hot-path.
- **Wireproxy + wgsocks codepaths stay shipped.** Vrstvu odstraníme až po 2 týdnech stabilního VPS provozu.

## Cost analysis

| Položka | Capex | Opex / měsíc | Opex / rok | Poznámka |
|---|---|---|---|---|
| **Option A — Hetzner CCX13 (Falkenstein DE)** | 0 | €5.83 | **€70** | 2 vCPU, 8GB RAM, 80GB NVMe, 20TB. Geo blízko CZ, latence ~5ms. |
| Option A alt — Vultr Prague | 0 | $6 | ~€67 | 1 vCPU, 1GB RAM. CZ exit nativně. |
| Option A alt — Hetzner CX22 | 0 | €4.51 | €54 | Cheapest viable. |
| Initial setup (operátor čas) | ~2h | — | — | Per Sprint 1 runbook. |
| **Option B — Railway ticket** | 0 | $0 | $0 | ETA neznámé; pokud odmítnut, je to wasted week. |
| **Option C — Mailgun EU Foundation** | 0 | $15 | $180 | 50K emails/mo. Per-recipient privacy DESTROYED. |
| Option C — Postmark Outbound 10K | 0 | $15 | $180 | Same privacy concern. |
| Option C — SendGrid Essentials | 0 | $19.95 | $239 | Same privacy concern. |
| **Option D — Upstream wait** | 0 | $0 | $0 | Block produkční launch indefinitely. |

**Recommendation:** Hetzner CCX13 Falkenstein — €70/yr, 2-3h setup, geo close to CZ.

## Rollout runbook (Option A)

### Step 1 — Provision VPS

```bash
ssh root@<vps-ip>
apt update && apt full-upgrade -y
apt install -y ufw wireguard-tools dante-server fail2ban
ufw default deny incoming
ufw allow 22/tcp
ufw allow from <railway-egress-cidr> to any port 1080 proto tcp
ufw --force enable
systemctl enable --now fail2ban
```

### Step 2 — Install kernel WG with Mullvad config

```bash
# Z Mullvad-WG.io stáhnout config pro CZ exit
chmod 600 /etc/wireguard/mullvad-cz3.conf
systemctl enable --now wg-quick@mullvad-cz3
wg show
curl --interface mullvad-cz3 https://am.i.mullvad.net/json
# Expected: {"is_mullvad": true, "country": "Czech Republic"}
```

### Step 3 — Configure Dante SOCKS5

`/etc/danted.conf`:
```
internal: eth0 port = 1080
external: mullvad-cz3
clientmethod: none
socksmethod: username
user.privileged: root
user.unprivileged: nobody

client pass {
  from: <railway-egress-cidr> to: 0.0.0.0/0
  log: connect disconnect error
}

socks pass {
  from: <railway-egress-cidr> to: 0.0.0.0/0
  command: connect
  protocol: tcp
}
```

```bash
useradd -r -s /usr/sbin/nologin antitrace
echo "antitrace:<strong-random-password>" | chpasswd
systemctl enable --now danted
```

### Step 4 — Verify egress through VPS

```bash
curl -x socks5://antitrace:<password>@<vps-ip>:1080 https://am.i.mullvad.net/json
# Expect: country=CZ, is_mullvad=true

for host in seznam.cz gmail.com yahoo.com mailgun.org sendgrid.net brevo.com fastmail.com zoho.eu outlook.com; do
  timeout 30 openssl s_client -connect smtp.${host}:587 -starttls smtp \
    -proxy <vps-ip>:1080 < /dev/null 2>&1 | grep -E "Verify return code"
done
```

### Step 5 — Update Railway env on `anti-trace-relay`

```
SOCKS_PROXY_ADDR=<vps-ip>:1080
SOCKS_PROXY_USER=antitrace
SOCKS_PROXY_PASS=<strong-random-password>
EGRESS_TRANSPORT=external_socks5
TRANSPORT_MODE=socks5
```

Zachovat všechny `WIREPROXY_*` ENVs (fallback při SOCKS_PROXY_ADDR unreachable).

### Step 6 — Re-run brutal test

```bash
node scripts/brutal-test/run.mjs --run-id=$(uuidgen) --report-dir=reports/brutal-post-vps-rollout/
```

Acceptance:
- 36/36 delivery via relay (ne lokální Mullvad bypass)
- probe-matrix.md: 10/10 STARTTLS pass
- anonymity score >= 80/100

### Step 7 — Tear-down podmínky

- 14 dní stabilního provozu, 2× per-week brutal test 36/36 → odebrat wireproxy binary
- Hetzner abuse flag → migrace na Vultr CZ
- Railway grant `CAP_NET_ADMIN` (Option B success) → migrate zpět, decommission VPS

## Decision criteria — kdy přehodnotit

| Trigger | Akce |
|---|---|
| `wireguard-go/tun/netstack` upstream fix released | Test wgsocks against gVisor fix; pokud 10/10, decom VPS, návrat do Railway. |
| Railway grant `CAP_NET_ADMIN` + `/dev/net/tun` | Migrate kernel-WG INTO Railway container; decom VPS. |
| Hetzner ToS abuse flag pro Mullvad outbound | Migrate na Vultr Prague nebo OVH CZ. |
| Mullvad blocked by Czech recipient SMTP servers (long-term) | Pivot na own egress IP nebo transactional service (re-eval Option C). |
| Provider count ≥3 active campaigns / >10K emails/mo | Add secondary VPS region, primary/standby load-balanced. |
