# Local-dev anti-trace-relay

**Why**: Railway rebuild trvá ~2 min při každé změně relay kódu. Pro iterativní vývoj transportu, proxy-pool sources, probe logiky apod. pusťte relay **lokálně** proti produkční DB (která je vzdálená TCP).

## One-shot bootstrap

```bash
# 1. Generate ephemeral dev secrets
mkdir -p /tmp/antitrace-data
cat > /tmp/antitrace-data/.env <<EOF
DATA_ENCRYPTION_KEY_B64=$(head -c 32 /dev/urandom | base64)
VAULT_ENCRYPTION_KEY_B64=$(head -c 32 /dev/urandom | base64)
DEV_API_TOKEN=$(head -c 32 /dev/urandom | base64 | tr -d '=+/')
EOF

# 2. Build + run relay on 127.0.0.1:8089
cd features/outreach/anti-trace-relay
go build -o /tmp/antitrace-relay ./cmd/relay
set -a && source /tmp/antitrace-data/.env && set +a
LISTEN_ADDR=127.0.0.1:8089 \
  DATA_DIR=/tmp/antitrace-data \
  PLAIN_HTTP=true \
  TRANSPORT_MODE=proxy \
  /tmp/antitrace-relay > /tmp/antitrace-data/relay.log 2>&1 &

# 3. Smoke test
curl -sS http://127.0.0.1:8089/healthz
curl -sS http://127.0.0.1:8089/v1/proxy-pool -H "Authorization: Bearer $DEV_API_TOKEN"
```

## BFF override

`features/platform/outreach-dashboard/.env`:

```
ANTI_TRACE_RELAY_URL_OVERRIDE=http://127.0.0.1:8089
ANTI_TRACE_RELAY_TOKEN=<DEV_API_TOKEN z kroku 1>
```

`relayClient.js` precedence: **URL_OVERRIDE → DB config → URL fallback**. Override nesmí být v produkčním env — DB config je authoritative tam.

Restart BFF (`pnpm dev`) — `/api/proxy-pool` shape s `working[], cz_working, total_candidates` = lokální relay; shape s `count:N` = produkční Railway.

## Trade-offs

- **Plus**: 3s rebuild + restart místo 2min Railway deploy.
- **Minus**: Lokální pool se probne znovu od nuly při každém startu (~60-120s než dorazí CZ proxy).
- **Minus**: Relay je stateless, ale `audit/` + `pool-trend` se ukládá do `/tmp/antitrace-data/` — smazat při reset.

## Revert k produkci

Odstranit `ANTI_TRACE_RELAY_URL_OVERRIDE` z `.env` + kill lokální relay proces. BFF se vrátí na DB-configured Railway URL.
