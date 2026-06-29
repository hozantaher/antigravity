# Doručitelnost a verifikace — plán

**Status:** Návrh ke schválení (Sprint H už v práci jako součást)
**Datum:** 2026-05-12
**Trigger:** Po dnes provedené diagnostice campaign 457 vyšlo najevo, že
(a) 426,296 contactů v DB nikdy nebylo verifikováno a `email_status=valid`
je jen import default, (b) per-domain cooldown blokoval 21,725 contactů
kvůli freemail bug (opraveno PR #1270), (c) Gmail flagoval naše sendy
jako spam kvůli Mullvad VPN IP (vyřešeno přepnutím na Railway direct
egress), (d) campaign 457 je single-step a žádný follow-up plán
neexistuje. Iniciativa shrnuje, co potřebujeme udělat, aby další kolo
posílání mělo doručitelnost 95%+ místo hádky se spam filtry.

## Kontext

Aktuálně je obrázek tenhle: máme 426k kontaktů z ARES + CRM importu, z
nichž 14,512 je na seznam.cz, 2,294 na gmail.com a další tisíce na
ostatních freemailech. Žádná z těch adres nikdy nebyla probnutá SMTP RCPT
TO testem — `email_status=valid` je literál z importu. Velký risk: bez
verifikace pošlu 100 emailů, 30 z nich bounce, hard-bounce rate 30% =
mailbox přes noc zablokovaný v anti-spam reputaci.

Campaign 457 první vlna (74 emailů) skončila vyčerpaná: 74 sent, 19
pending (blokováno IMAP recovery suppression), 21,725 blokováno
freemail-domain bug (teď fixnuto), zbytek na step 1 (single-step
sekvence, fakticky DONE). Žádný follow-up neexistuje.

Diagnostika Gmail spam landing (operátor 2026-05-12, Show Original
headers): Mullvad CZ exit IP byla flagged jako VPN/datacenter, takže
Gmail házel do spamu i přes SPF/DKIM/DMARC pass. Egress přepnut na
Railway direct (PR #1257 + env flip). Nevíme ještě, jestli Railway IP
je v Gmail reputaci výš — potřebujeme měřit.

Sprint H už je rozjetý jako součást této iniciativy: agent buduje UI
surface pro bulk verify všech kontaktů.

## Sprint J — Verify pipeline production-ready

Sprint H staví UI surface a základní enqueue. J ho dotahuje na úroveň,
kdy operátor opravdu může 426k contactů projet bez babysittingu.

Konkrétně J zavádí:

- **DNS MX caching** — `verifyEmail` dnes hammeruje DNS na každý
  per-contact probe. 426k unique-domain lookups je zbytečné — 30-50k
  unikátních domén stačí cache 24h.
- **Per-MX rate limit** — místo per-domain `_domainProbeLock` 5s
  rozšíříme na per-MX-host limit (gmail-smtp-in.l.google.com 1 req/2s
  apod.). Současné domain-level by zablokovalo všechny gmail.com adresy
  za sebou.
- **Quarantine kanál pro catch-all domény** — když probe vrátí
  catch-all, tak nemáme jistotu, jestli adresa existuje. UI to označí
  jako "risky", operátor rozhodne sam o-individual.
- **Re-verify cron** — kontakt verified > 90 dní pošli zpět do queue
  (lidé měnili firmy, adresy padly). Dnes verifikuje jen jednou.
- **Test ratchet** — žádný nový kód v contactVerifyCron bez integration
  testu s pg-mem fixturou.

## Sprint K — Segment refresh post-verify

Po J už máme spolehlivá `email_status` data. Sprint K přidá UI a logiku
pro budování campaign-eligible segmentů z verified contactů.

Mám na mysli:

- **Segment builder v UI** — filtr `email_status IN (valid)` AND `NACE
  IN sectors` AND `region IN regions` AND `NOT IN dedup_blocked`. Live
  count "X kontaktů odpovídá", "Y bude skipnuto dedupem". Operátor
  vidí předem, kolik mailů kampaň reálně pošle.
- **Dry-run enrollment** — enroll virtuálně bez INSERT do
  campaign_contacts, vrať počty po každém kroku pipeline (eligibility,
  dedup, suppression). Dnes je to black box — operátor kliká "Start"
  a doufá.
- **Domain coverage chart** — kolik unikátních domén ve segmentu, max
  contactů per doména. Defensivní signál pro spam: pokud máme 5 adres
  z `kovostroj.cz` a chceme všech 5 oslovit, je to fingerprint.

## Sprint L — Multi-step sekvence

Campaign 457 měla jen `intro_machinery` step 0 a žádný follow-up.
Standardní cold-email best practice je 3-4 follow-ups s 5-12 dny mezi
nimi (memory `feedback_cold_email_pattern` — 80+ iterací validovaných).

L zavádí:

- **Sequence editor v UI** — drag-and-drop step builder. Per-step
  template selection + delay_days. Visual timeline.
- **Template library s tracking** — DB-backed `email_templates`
  (existuje), přidat per-template metriky: kolik kampaní použilo,
  open rate, reply rate, spam complaint rate. Operátor vidí, který
  follow-up funguje.
- **Reply-aware skipping** — jakmile contact odpoví na step N, další
  steps se neodesílají. Dnes runner už to dělá přes `outreach_threads.status=closed`,
  ale UI to nezobrazuje.

## Sprint M — Deliverability monitoring

Bez monitoringu nepoznáme, kdy nám reputace klesne. M postaví dashboard
panel s konkrétními signály.

Co tam má být:

- **Bounce rate per mailbox** — last 24h, 7d, 30d. Alert nad 2% (per
  industry standard).
- **Spam complaint rate** — FBL reports od Seznam/Gmail (pokud
  podporují) + manuální klasifikace v `/replies`. Alert nad 0.1%.
- **Delivery time histogram** — od `submitted` k `delivered` (post-IMAP
  Sent appendu). Pokud najednou vidíme `delivered` za 2h místo 30s, MX
  greylistuje nebo deferruje.
- **Blacklist monitoring** — `runBlacklistCheckCron` už zapisuje
  `mailbox_alerts`, ale UI to nemá agregaci. Přidat panel "Blacklisty"
  s historií + dedup.
- **Reputation score per mailbox** — vážený součet bounce + spam +
  delivery time + auth fails. Operátor vidí, který mailbox potřebuje
  pause.

## Sprint N — Vlastní doména a infrastruktura

Tohle je nejdéle trvající a nejvíc překračující inženýrský scope.
Aktuálně posíláme z `@seznam.cz` freemail mailboxů. Per dnešní
Gmail diagnostika, mismatch "Balkan Motors" signature + freemail
adresa snižuje doručitelnost. Plus Seznam DMARC je `p=NONE`.

N je dlouhodobá migrace:

- **Doménový rozhoduj.** `@balkanmotors.cz`, `@garaaage.cz`, jiná?
  Operátorské rozhodnutí.
- **DNS setup** — vlastní MX (přes Microsoft 365 / Google Workspace /
  Mailcow / Postfix), SPF s vlastní policy, DKIM podepisování,
  DMARC `p=quarantine` (postupně `p=reject`).
- **Migrace mailboxů** — vytvořit `goran.nowak@balkanmotors.cz` a
  postupně přepnout z seznam.cz. Existující IMAP threads zmigrovat
  nebo nechat na seznam.cz jako archive.
- **Reputation budget** — nová doména = warmup od nuly. Sprint AP1
  warmup phases zase platí (5/10/25/50/100/den).
- **Compliance update** — privacy notice, LIA, art30-register musí
  reflektovat novou doménu jako controller identity.

Tohle není levné: ~5,000-10,000 Kč setup + vlastní mailové infra +
měsíce reputation budování. Operátorské rozhodnutí, jestli to stojí
za to vs. zůstat na seznam.cz a žít s nižší Gmail delivery.

## Sekvencování a závislosti

- Sprint J čeká na Sprint H dokončení (UI surface existuje, J ho
  dotahuje).
- Sprint K čeká na J (potřebuje spolehlivá `email_status` data).
- Sprint L může jet paralelně s J — různé surface (sequence editor vs.
  verify panel).
- Sprint M může jet kdykoli — nezávislý.
- Sprint N je strategické rozhodnutí, ne čistý implementační sprint —
  spustit, až operátor řekne ano.

Odhad doba (sériově):

- J: 1-2 týdny (3-4 PRs: cache, MX limit, quarantine kanál, re-verify cron)
- K: 1 týden (2 PRs: segment builder + dry-run)
- L: 2 týdny (3 PRs: sequence editor + template metrics + reply skip)
- M: 1-2 týdny (3 PRs: panely + alerting + reputation score)
- N: 2-3 měsíce wall time (DNS + warmup)

Paralelně (J+L současně, M kdykoli): ~4-6 týdnů pro J+K+L+M.

## Co tahle iniciativa nepokrývá

- **Dashboard improvements** (předchozí iniciativa `2026-05-12-dashboard-improvements.md`) —
  Sprint D test coverage + Sprint E megastránky split zůstávají v té
  iniciativě. Doručitelnost je samostatný track.
- **Anti-trace anonymity** — operátor zvolil deliverability nad
  anonymity (Railway direct egress, ne Mullvad). Pokud se to obrátí,
  nový plán.
- **AI/LLM klasifikace replies** — Sprint S19/KT-B série, jiný track.
