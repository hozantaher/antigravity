# ADR-006: Secret Management — Environment Variables as Production Model

## Status: Accepted

## Context

Privacy-gateway handles 5 categories of secrets via environment variables:

| Secret | Env Var | Sensitivity |
|--------|---------|-------------|
| Data encryption key | `DATA_ENCRYPTION_KEY_B64` | Critical — encrypts all 8 data stores |
| SMTP credentials | `SMTP_USERNAME`, `SMTP_PASSWORD` | High — email relay access |
| IMAP credentials | `IMAP_USERNAME`, `IMAP_PASSWORD` | High — inbox read access |
| Dev API token | `DEV_API_TOKEN` | Medium — local dev auth |
| Intake API token | `INTAKE_API_TOKEN` | Medium — bridge ingest auth |

All secrets are loaded once at startup via `config.Load()`. No secret is logged, returned in API responses, or persisted outside the process.

## Decision

**Keep environment variables as the production secret management model.** Do not introduce a vault (HashiCorp Vault, AWS Secrets Manager, SOPS, etc.) unless one of the following triggers is met:

### Migration Triggers (any one is sufficient)

1. **Multi-operator deployment** — more than one person needs to manage secrets, requiring access control and audit trails
2. **Secret rotation without restart** — operational requirement to rotate SMTP/IMAP credentials or encryption keys without downtime
3. **Compliance requirement** — external audit or regulation mandates a dedicated secret store with access logging
4. **Secret count > 15** — env var management becomes unwieldy; a structured store reduces operational errors

### Why not migrate now

- **Single-operator deployment.** One person manages all secrets. Access control is filesystem permissions on `.env`.
- **Startup-only loading.** Secrets are read once, held in memory. No runtime secret fetching, no connection to external services.
- **Zero external dependencies.** No vault server to operate, no SDK to integrate, no network dependency at startup.
- **Encryption key is already strong.** AES-256-GCM key derived from base64-encoded env var. Key management is the operator's responsibility regardless of storage mechanism.
- **Docker/systemd native.** Both deployment targets handle env vars natively (`--env-file`, `EnvironmentFile=`).

### If migration is triggered

1. **SOPS + age first** — encrypted `.env` file, decrypted at deployment time. Preserves file-based workflow, adds encryption at rest for secret files.
2. **HashiCorp Vault only if** multi-operator with rotation requirements. Adds network dependency and operational complexity.
3. **Cloud-native (AWS SM, GCP SM) only if** deploying to managed cloud with IAM already in place.

### Operational Requirements (current model)

Operators must:

1. Never commit `.env` files to version control (`.gitignore` already covers this)
2. Set `DATA_ENCRYPTION_KEY_B64` to a cryptographically random 32-byte key, base64-encoded
3. Use unique, app-specific passwords for SMTP and IMAP (not personal account passwords)
4. Replace the default `DEV_API_TOKEN` value (`dev-token`) before any non-local deployment
5. Restrict `.env` file permissions to owner-only (`chmod 600`)

## Alternatives Considered

1. **HashiCorp Vault now** — Rejected because: adds server dependency, network requirement at startup, operational complexity (unsealing, token renewal). Overkill for single-operator deployment.
2. **SOPS/age now** — Rejected because: adds build-time dependency and key management for the SOPS key itself. Current threat model (filesystem access = game over anyway) doesn't benefit.
3. **Docker secrets** — Rejected because: ties deployment to Docker Swarm. Single-binary deployment story is a product feature.
4. **Compile-time embedding** — Rejected because: secrets in binary = secrets in version control adjacent. Worse than env vars.

## Consequences

- Operators must secure their `.env` files and deployment pipelines.
- Secret rotation requires process restart (acceptable for current scale).
- The `config.Load()` function remains the single entry point for all configuration including secrets — no scattered `os.Getenv` calls.
- This ADR must be revisited before any multi-tenant or multi-operator deployment.

## Review Date: Before first multi-operator deployment, or when secret count exceeds 15.
