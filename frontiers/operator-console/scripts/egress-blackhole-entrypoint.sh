#!/bin/sh
# R8a — DNS blackhole for BFF (Node/Express) container.
#
# Any direct dial to public SMTP/IMAP from the BFF would expose the
# operator's IP. Resolve to loopback so Node's DNS lookups refuse before
# the request could leak. The only authorized egress path is the
# anti-trace-relay service (not this container).
set -eu

cat >> /etc/hosts <<'EOF'

# --- R8a egress blackhole: refuse DNS for public SMTP/IMAP ---
127.0.0.1 smtp.seznam.cz smtp.gmail.com smtp.post.cz smtp.email.cz
127.0.0.1 imap.seznam.cz imap.gmail.com imap.post.cz imap.email.cz
127.0.0.1 smtp.office365.com smtp.mail.yahoo.com outlook.office365.com
::1 smtp.seznam.cz smtp.gmail.com smtp.post.cz smtp.email.cz
::1 imap.seznam.cz imap.gmail.com imap.post.cz imap.email.cz
::1 smtp.office365.com smtp.mail.yahoo.com outlook.office365.com
# --- end R8a ---
EOF

exec su-exec bff:bff "$@"
