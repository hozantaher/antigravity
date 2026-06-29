# Projektové TODO

## DevOps / MLOps Automatizace
- [ ] **Přesun AI a Audit automatizací mimo lokální stroj (Zamezení závislosti na zapnutém PC)**
  - Z migrovat Jules Nightwatch (`npm run ag:jules`) do Github Actions (noční spouštění ve 02:00) nebo na VPS server.
  - Z migrovat Cybernetic Audit (`npm run ag:audit --heal && npm run ag:map`) do Github Actions (po každém pushi do masteru / každou hodinu) nebo do PM2/cronu na VPS.
  - Zajistit, aby reporty z těchto procesů byly stále notifikovány v příslušných kanálech.

