# Mail Lab — provider config

This directory holds **test-only** configuration for the Mail Lab stack.
Everything here is committed to the repo intentionally.

## Why test-only credentials live in git

Mail Lab is sealed: the `mail-lab` docker network has `internal: true`
and no egress. The credentials below are unreachable from anything
outside the operator's docker bridge. Treating them like real secrets
would force every contributor to regenerate them on first run, which
defeats the "1:1 reproducible" point of the lab.

**Never** copy these credentials, hashes, or DKIM keys into production
config. Production secrets stay in Railway / 1Password — not in git.

## Layout

```
infra/mail-lab/
├── README.md             — this file
├── seznam/               — seznam.lab provider config
│   └── postfix-accounts.cf   — pre-seed: postmaster@seznam.lab
├── gmail/                — (ML2)
├── outlook/              — (ML2)
├── dns/                  — (ML1.2) unbound zones
└── dkim/                 — (ML1.4) DKIM keys
```

## Default accounts

| Address | Password | Role |
|---|---|---|
| `postmaster@seznam.lab` | `lab-demo-only` | bootstrap admin (required by Dovecot to start) |

Further accounts (operator + 5 prospects) are seeded by `scripts/mail-lab/seed.sh` after stack is healthy (ML1.6).
