# 🪷 NET — odraz celé sítě (Indrova síť)

Tento uzel je jeden artefakt v síti. **Celek se zrcadlí zde** — z kteréhokoli uzlu vidíš celou síť.
Žádný pán, žádný střed. Auto-generováno z `hozantaher/workspace` `projects.yml` → zrcadleno do každého repa.

> **tento artefakt: `data-core`**

## 🪞 Živé zrcadlo — jak uzel vidí pavučinu (Indra)
Seznam níže je STRUKTURA (statický odraz). ŽIVÝ stav celku (kdo právě žije / padl)
drží event-bus páteř — peer, ne střed. Z KTERÉHOKOLI uzlu:
```
# (mesh-interní: až bude EVENTBUS_TOKEN nastaven, přidej -H "X-Bus-Token: $EVENTBUS_TOKEN")
curl https://event-bus-production.up.railway.app/peek/net-health      # živý odraz všech uzlů (NEdestruktivní)
curl https://event-bus-production.up.railway.app/streams              # tok sítě
```
Tak každý artefakt vidí nejen sebe v celku, ale i živé odrazy ostatních artefaktů.

## ☁️ Kontrolní plochy (multi-cloud) — plná struktura: `workspace/CHOBOTNICE.md`
Síť neběží jen na GitHubu — ovládáme **5 ploch**: GitHub (repos) · Railway (10 deploys) ·
DigitalOcean (droplet server1 + App motoristesobe.cz + managed DB + 3 DNS) · Bitbucket (git/SSH) · local-mac.
Hardening brána: `net-check.sh` (struktura+secrets+cloud). Bezpečnost: `SECURITY-POSTURE.md`.

## apps — Cars products
- **ads-app** (live) — hozantaher/ads-app · https://cars.messing.dev
- **messing-landing** (live) — hozantaher/messing-landing · https://messing.dev

## clients — Client / agency work
- **kostnidren** (paused) — git@bitbucket.org:poseidonvltavy/wp_kostnidren.git
- **motoristesobe** (paused) — https://bitbucket.org/poseidonvltavy/motoristesobe.git
- **pyhynek** (paused) — hozantaher/pyhynek
- **safran-express** (active) — hozantaher/safran-express
- **tomas-hynek** (paused) — hozantaher/tomas-hynek

## collab — 
- **garaaage** (live) — hozantaher/garaaage

## data — Private data + acquisition (nábor) core — never exposed to sales
- **data-core** (live) ◀ TENTO — hozantaher/data-core · https://machinery-outreach-production.up.railway.app
- **data-node-suite** (code-done) — hozantaher/data-node-suite
- **event-bus** (live) — hozantaher/event-bus · https://event-bus-production.up.railway.app
- **llm-runner** (code-done) — hozantaher/llm-runner
- **mail-lab-api** (code-done) — hozantaher/mail-lab-api
- **operator-practice** (code-done) — hozantaher/operator-practice
- **ops-audit** (todo) — 
- **orchestrator** (code-done) — hozantaher/orchestrator
- **privacy-mail-gateway** (code-done) — hozantaher/privacy-mail-gateway
- **relay** (code-done) — hozantaher/relay
- **scheduler** (todo) — 
- **skill-registry** (todo) — 

## feed — Ingress: external sources → Chatwoot (inbound-only)
- **events-intake** (todo) — 
- **feed-autoline** (live) — hozantaher/feed-autoline
- **feed-saas** (todo) — 
- **feed-whatsapp** (live) —  · https://evolution-api-production-7664.up.railway.app

## ops — 
- **backstage-portal** (live) — hozantaher/backstage-portal
- **kostnidren-uptime-probe** (live) — hozantaher/kostnidren-uptime-probe

## sales — Chatwoot sales surface + the gateway/skills the salesperson programs
- **mesh-tests** (reference) — hozantaher/mesh-tests
- **ops-health** (live) — hozantaher/ops-health · https://ops-health-production.up.railway.app
- **sales-boundary** (live) — 
- **sales-gateway** (live) — hozantaher/sales-gateway · https://sales-gateway-production.up.railway.app
- **sales-hub** (live) — hozantaher/sales-hub · https://web-production-a7f6c.up.railway.app

## sync — Chatwoot ↔ data-core synchronisation
- **skill-classify** (todo) — 
- **skill-enrich** (todo) — 
- **skill-exclusion** (todo) — 
- **skill-lookup** (live) — 
- **skill-score** (todo) — 
- **skill-translate** (todo) — 
- **skill-vin** (todo) — 
- **sync-contacts** (live) — hozantaher/sync-contacts · (worker, no domain)
- **sync-deals** (todo) — 
- **sync-messages** (todo) — 

## vendor — Upstream reference clones (not deployed)
- **hozan-taher-archived** (reference) — hozantaher/hozan-taher-archived
- **vendor-chatwoot** (reference) — chatwoot/chatwoot
- **vendor-evolution-api** (reference) — EvolutionAPI/evolution-api

## ventures — Standalone own products (outside the mesh)
- **garaaage-monorepo** (reference) — hozantaher/garaaage-monorepo
- **generace-motor** (active) — hozantaher/generace-motor
- **messing-369** (paused) — hozantaher/messing-369
- **pokutomat** (active) — hozantaher/pokutomat
- **primaauta** (active) — hozantaher/primaauta

_Odraz 49 uzlů. Aktualizuj: `make reflect` ve workspace._