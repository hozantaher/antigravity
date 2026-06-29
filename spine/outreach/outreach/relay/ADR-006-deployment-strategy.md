# ADR-006: Production Deployment Strategy

**Status:** Accepted
**Date:** 2026-04-07
**Authors:** Spec Kit Codex Stack core council
**Scope:** `services/anti-trace-relay/` production deployment model for MVP

---

## 1. Context and Problem Statement

The anti-trace-relay service is approaching MVP completion with systemd and Docker deployment options documented in `DEPLOYMENT.md`. However, no explicit decision has been made on:

1. **Production hosting environment** — Railway (managed) vs. VPS (self-hosted) vs. self-managed infrastructure
2. **TLS certificate lifecycle** — automated (Let's Encrypt) vs. manual vs. self-signed
3. **Scalability model for MVP** — explicit single-node boundary with clear post-MVP transition path

The service handles sensitive communications for persecuted individuals in conflict zones. Deployment decisions directly impact:
- **Operational security** — who can access infrastructure, audit logs, geographic jurisdiction
- **Reliability** — uptime, DDoS protection, automated failover
- **Operational overhead** — certificate renewal, patching, backup responsibility
- **Privacy** — server-side data access, infrastructure visibility, jurisdiction compliance

---

## 2. Decision Drivers

| Driver | Weight | Rationale |
|--------|--------|-----------|
| Operational simplicity (MVP) | Critical | Minimize infra burden; focus on service logic |
| DDoS resilience | High | Persecuted users depend on availability; DoS attacks are real threat |
| TLS automation | High | Manual cert renewal is fragile; automated renewal critical for 24/7 operation |
| Jurisdiction/vendor risk | High | Infrastructure location and provider visibility matter for threat model |
| Post-MVP scalability | Medium | MVP can be single-node; path to multi-node must not require rewrite |
| Cost | Medium | Managed platforms have cost/benefit tradeoff vs. raw VPS |
| Audit trail | Medium | Understand infrastructure access and changes |

---

## 3. Considered Alternatives

### A. Railway (managed platform) — **CHOSEN**

**Pros:**
- Zero infrastructure management — Railway handles container orchestration, networking, TLS termination
- Automated TLS via integrated Let's Encrypt (ACME)
- Built-in DDoS protection and edge caching
- Automatic scaling within single-node region (handles traffic spikes)
- Integrated audit logging (who deployed what, when)
- Team already uses Railway for outreach-dashboard and machinery-outreach PostgreSQL
- Consistent deployment experience across services

**Cons:**
- Infrastructure is US-based (closed-source); no choice of jurisdiction
- Vendor lock-in if API or billing terms change
- Less transparent than self-hosted (no access to raw server logs, firewall rules)
- Railway staff could theoretically access server memory (same as any hosting provider)

**Mitigations:**
- Data is already encrypted (content sealed with recipient key; identity vault separate key)
- Railway's data centers are SOC 2 compliant
- Explicit threat model acknowledges "compromised operator" as partially protected
- Easy to migrate to VPS if jurisdiction concerns arise post-MVP

---

### B. Self-hosted VPS (DigitalOcean / Vultr / anonymous provider)

**Pros:**
- Maximum control over infrastructure and OS
- Can choose jurisdiction (neutral country, no US data center)
- No vendor lock-in — standard Linux + Docker
- Better for threat models that require geographic isolation
- Transparent infrastructure (you see all logs, configs)

**Cons:**
- Operator responsible for OS patching, certificate renewal, DDoS mitigation
- Manual TLS renewal is fragile (cron job, shell script, error-prone)
- No built-in DDoS protection (added cost for Cloudflare/etc.)
- Higher operational overhead for 24/7 uptime
- More complex deployment pipeline (requires CI/CD for updates)
- Cheaper provider (anonymous payment) has worse reliability/support

**Mitigations:**
- Ansible/Terraform for infrastructure-as-code
- Certbot + auto-renewal hooks
- Cloudflare DDoS protection layer
- Post-MVP: can migrate from Railway to VPS if needed

**Rejected because:** MVP prioritizes operational simplicity. Operator burden of manual TLS renewal + DDoS mitigation outweighs jurisdiction benefit for initial deployment. **Post-MVP migration path is explicit.**

---

### C. Self-managed baremetal (OPSEC-DEPLOY.md model)

**Pros:**
- Maximum privacy — operator owns hardware, no third-party access
- Suitable for extremely high-threat deployments
- Most transparent model

**Cons:**
- Highest operational complexity (physical security, hardware maintenance, power/cooling)
- Hardest to keep patched and updated
- No geographic redundancy
- Very limited scalability
- Requires physical security in secure location

**Rejected because:** Not suitable for MVP. Baremetal model is appropriate for *existing operators* who already run infrastructure; not for initial deployment.

---

## 4. Decision

### 4.1 Primary Hosting: Railway

**Decision:** Deploy anti-trace-relay MVP to Railway, using Railway's managed container platform.

**Rationale:**
1. **Team consistency** — outreach-dashboard and machinery-outreach already use Railway; shared deployment pipeline and runbooks
2. **Operational safety** — automated TLS renewal eliminates cert-expiry surprises (which would cause downtime for persecuted users)
3. **DDoS protection** — built-in edge protection is non-trivial; adds ~$500/month cost as standalone service
4. **MVP scope** — minimizes infra toil, allows team to focus on service hardening
5. **Post-MVP exit** — service logic is infrastructure-agnostic (single Go binary, file/database storage). Migration to VPS is straightforward if jurisdiction concerns arise.

**Implementation:**
- Dockerfile already exists and is multi-stage + non-root
- Railway reads `Dockerfile` and `railway.json` for config
- Set encryption keys via Railway environment variables (not in code)
- Set `DATA_DIR` to Railway's mounted volume (persistent across restarts)
- Configure custom domain with Railway's TLS integration

---

### 4.2 TLS Certificate Management: Let's Encrypt (Automated)

**Decision:** Use Let's Encrypt with automatic renewal via ACME. No manual certificate management in production.

**Rationale:**
1. **Reliability** — automated renewal prevents certificate expiration outages (critical for 24/7 service)
2. **Cost** — free (no paid TLS provider needed)
3. **Industry standard** — used by 200M+ domains; no esoteric tooling
4. **Simple deployment** — Railway's built-in ACME handles renewal transparently

**Implementation:**
- Railway automatically provisions and renews Let's Encrypt certificates
- Custom domain setup: `anti-trace-relay.example.com` → Railway → automatic cert
- Renewal happens 30 days before expiry (industry standard)
- No operator action required

**For development/testing:**
- Self-signed certificates remain supported (see `DEPLOYMENT.md` Mode 1)
- Smoke tests generate self-signed certs (no Let's Encrypt in CI)

---

### 4.3 Single-Node MVP Boundary: Explicit

**Decision:** MVP is single-node. No clustering, no multi-region failover, no load balancing across instances.

**Rationale:**
1. **Simplicity** — single-node reduces state management complexity (file-based storage, in-process message bus)
2. **Honest capacity** — MVP throughput is 100-1000 messages/day per estimate; one container handles this
3. **Clear post-MVP path** — post-MVP, migrate to database backend + multiple nodes (see ADR-001 section 7)
4. **Availability ≠ scalability** — Railway's container restart policy + health checks provide basic availability; this is not high-availability clustering

**Single-node guarantees:**
- Only one `relay` goroutine drains the queue (no concurrent relay schedulers)
- Only one Tor process (if `TOR_ENABLED=true`)
- Only one WireGuard tunnel (if `VPN_ENABLED=true`)

**Post-MVP migration:**
1. Move file-based storage → PostgreSQL (already in use by machinery-outreach)
2. Add coordination layer (etcd/Consul or database-backed) for distributed scheduling
3. Horizontal scale: N replicas sharing database-backed state
4. Multi-region: read replicas in different jurisdictions (optional)

---

## 5. Consequences

### Positive

✅ **No operational toil** — Railway handles TLS, OS patching, DDoS protection
✅ **Predictable availability** — managed platform has 99.9% SLA
✅ **Simple deployment** — `git push` triggers build and deploy
✅ **Team consistency** — same platform/process as other services
✅ **Cost containment** — MVP doesn't need HA infrastructure

### Negative (Mitigated)

⚠️ **US-based infrastructure** — customer data proxied through US data center
- **Mitigation:** Content is end-to-end encrypted (sealed with recipient key); vault is separate. Railway staff cannot read messages.
- **Post-MVP exit:** If jurisdiction is deal-breaker, migrate to European VPS provider.

⚠️ **Vendor lock-in** — cannot self-host without rewrite
- **Mitigation:** Service uses only stdlib Go; Dockerfile is portable. Actual migration is not a rewrite, just different infra.

⚠️ **Single-node bottleneck at scale**
- **Mitigation:** Explicit boundary. Post-MVP scales via database backend.

⚠️ **No audit of Railway infrastructure internals**
- **Mitigation:** This is true of all hosting providers. Threat model acknowledges operator compromise as partially protected (E2E sealed content + separate vault key).

---

## 6. Risks and Mitigations

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Let's Encrypt ACME fails, cert not renewed | Low | Availability outage (users cannot submit) | Railway monitors cert expiry; alerting configured; manual renewal fallback (update domain DNS) |
| Railway infrastructure compromised | Very Low | Full data breach | Content is sealed (vault key not on Railway); separate key in secrets manager (post-MVP: use Railway Secrets) |
| DDoS attack targets service | Medium | Availability impact | Railway edge protection included; Cloudflare DDoS plan available for add-on |
| Single-node crash loses in-flight messages | Low | Message loss (only briefly: ~seconds during startup recovery) | File-based queue persists across restarts; railway auto-restart on crash |
| Post-MVP migration to VPS is expensive | Low | Vendor lock-in | Service is DB-agnostic and portable; migration is configuration, not code |

---

## 7. Verification

### Deployment Checklist

- [ ] Dockerfile builds without errors
- [ ] Image runs locally: `docker run -e DATA_ENCRYPTION_KEY_B64=... anti-trace-relay`
- [ ] Railway project created with environment variables set
- [ ] Custom domain added to Railway project
- [ ] TLS certificate issued (Railway dashboard shows green ✓)
- [ ] Health check passes: `curl https://anti-trace-relay.example.com/healthz`
- [ ] Smoke test passes end-to-end (see smoke-test.sh)
- [ ] Audit logs show deployment timestamp
- [ ] Post-MVP: database migration plan documented (schema, ETL, cutover strategy)

### Monitoring (Post-MVP)

- [ ] Alert on certificate expiry < 7 days
- [ ] Alert on container restart (potential crashes)
- [ ] Monitor relay queue depth (pending envelopes)
- [ ] Monitor error rate in audit trail
- [ ] Monitor rate limiter rejections (abuse detection)

---

## 8. Future Decisions (Post-MVP)

### D-2026-Q3: Database Persistence
Migrate from file-based storage to PostgreSQL for:
- Horizontal scaling (multiple relay instances)
- Atomic transactions
- Built-in replication
- PITR (point-in-time recovery)

### D-2026-Q4: Multi-Region
Replicate to EU/APAC regions if needed for jurisdiction compliance.

### D-2026-Q2+X: On-Premises Migration
If operator requires full infrastructure control, migration path:
1. Ansible playbook for VPS provisioning
2. Docker Compose for orchestration
3. Certbot + cron for automated TLS renewal
4. Prometheus + Grafana for monitoring

---

## 9. Decision Log

| # | Decision | Rationale | Alternative Rejected |
|---|----------|-----------|---------------------|
| D1 | Railway MVP deployment | Team consistency + operational simplicity | VPS (too much toil) + baremetal (not MVP-ready) |
| D2 | Let's Encrypt automated TLS | Prevents certificate expiry outages (critical for 24/7) | Manual renewal (fragile) + paid TLS (unnecessary cost) |
| D3 | Single-node MVP boundary | Simplicity + honest capacity; clear post-MVP path | HA cluster (too early) |
| D4 | Content sealed before Railway | Operator cannot read messages even with full access | Relying on Railway isolation alone |
| D5 | Separate vault key | Vault compromise doesn't expose message content | Single key for everything |

---

## 10. References

- `DEPLOYMENT.md` — Docker and systemd options (still valid)
- `OPSEC-DEPLOY.md` — Anonymous VPS / payment / access hardening (post-MVP)
- `ADR-001` — Architecture (includes post-MVP scalability section)
- `CLAUDE.md` — Service-local rules and Railway references
- `.railway.json` (to be created) — Railway configuration
