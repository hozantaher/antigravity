# Final pre-launch sprint — campaign 457

**Status:** In progress
**Datum:** 2026-05-06
**Trigger:** Hardening v2 + Inventory v2 + Testing v2 dokončeny. 5 reziduálních akcí před launch zítra 8:00.

## Cíl
Posunout campaign 457 ze stavu "kód + content green, infra neredeployed" do "running" zítra ráno.

---

## Sprint A — Autonomní verify + cleanup

Drobné DB checks a cleanup co nepotřebují operatéra.

- **A1:** Verify mailbox password integrity (`octet_length` všech aktivních mailboxů)
- **A2:** Filter e2e_test mailbox (id=11583) — `UPDATE status='paused'`
- **A3:** Verify campaign 457 final state (sequence single step, 100 pending, žádný cross-contamination)

## Sprint B — Operatorské deploy + restart

Bez tohoto kroku poběží zítřejší launch se starou verzí .tmpl.

- **B1:** Railway dashboard → hozan-taher → campaigns → Deploy (3-5 min)
- **B2:** Lokální BFF restart pro pickup batch-merge (memory `feedback_dev_server_restart_after_merge`)
- **B3:** Verify deploy fingerprint — git SHA matchuje Deployed SHA v Railway

## Sprint C — Mailbox rescore + warmup check

Aktuální skóre staré 9 dní + mb2 86/100. Rescore před send.

- **C1:** Dashboard `/mailboxy` → "Plná diagnostika" pro každý ze 4 production mailboxů
- **C2:** Pokud nový skóre <80 → halt a debug
- **C3:** Pokud všechny ≥80 → green light pro D

## Sprint D — Final smoke + go/no-go

Finální ověření že production cesta produkuje očekávaný výstup.

- **D1:** Send 1 email post-redeploy na info@messing.dev — verify subject "Dotaz" + simplified body + new footer + working {{.UnsubURL}}
- **D2:** Verify rendering v inboxu, žádný spam
- **D3:** Operator go/no-go

## Sprint E — Real launch + monitoring (zítra 8:00)

- **E1:** 7:50 verdict=green check
- **E2:** 8:00 klik Aktivovat
- **E3:** 8-9:00 první hour monitoring (cap 1/mailbox/hod = 4 maily)
- **E4:** 11:00 ramp 1→2 pokud green
- **E5:** 14:00 ramp 2→5 pokud green
- **E6:** 17:00 end-of-day report

## Závislosti

A + B + C parallel → D → E

## Halt podmínky (E)

- Hard bounce > 5 %
- Mailbox circuit trip
- Reply classifier <70 % accuracy
- Operator stop
