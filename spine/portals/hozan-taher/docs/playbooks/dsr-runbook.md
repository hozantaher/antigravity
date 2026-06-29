# DSR Runbook — Data Subject Request Handling

> Pokud někdo požádá o své osobní údaje (Art. 15) nebo o jejich smazání (Art. 17),
> máš na to **1 měsíc** (Art. 12 GDPR). V odůvodněných případech lze prodloužit o 2.
>
> Created: 2026-04-25

## SLA

- **Confirmation reply**: do 48h potvrď že žádost přijala
- **Substantive response**: do 1 měsíce
- **Extension**: pokud potřebuješ víc, do 1 měsíce pošli důvod a ETA

## Identity verification

Před vyřízením ověř, že žadatel je opravdu data subject:

- Žádost přišla z emailu, na který jsme posílali → identita pravděpodobně OK
- Žádost přišla z jiného emailu → požádej o ověření (forward original email, doplň jméno + IČO firmy)
- Anonymní/neověřitelná žádost → odmítni s odkazem na čl. 12(6)

## Art. 15 — Right of access

**Žadatel chce vědět, co o něm máme**.

```bash
# Z Railway env nebo lokálně:
curl -s "https://<bff-url>/api/dsr/access?email=<EMAIL>" \
  -H "x-api-key: $OUTREACH_API_KEY" | jq .
```

Output JSON s 8 sekcemi:
- `contacts` (Schema A — primary registry)
- `outreach_contacts` (Schema B — enriched)
- `send_events` (max 500 latest)
- `reply_inbox` (replies sent BY them)
- `tracking_events` (opens/clicks)
- `suppression_list` (CZ table)
- `outreach_suppressions` (Go table)
- `audit_log` (operator actions on this contact)

**Response template** (operator → žadatel):

```
Vážená paní / pane,

děkujeme za Vaši žádost o přístup k osobním údajům podle čl. 15 GDPR.

V příloze naleznete kompletní výpis údajů, které o Vašem emailu
<EMAIL> evidujeme:
- Kontaktní údaje (email, jméno, region, firma)
- Záznamy o našich pokusech Vás kontaktovat
- Případné odpovědi, které jste nám zaslali
- Záznamy o případném odhlášení

Pokud žádáte o opravu (čl. 16) nebo výmaz (čl. 17), dejte vědět.

Garaaage s.r.o.
[OP — sídlo, IČO]
```

**Příloha**: vyexportuj JSON ze API jako příloha + lidsky čitelná tabulka (CSV nebo PDF).

## Art. 17 — Right to erasure ("right to be forgotten")

**Žadatel chce být zapomenut**.

```bash
curl -X POST "https://<bff-url>/api/dsr/erase?email=<EMAIL>" \
  -H "x-api-key: $OUTREACH_API_KEY" | jq .
```

**Response shape**:
```json
{
  "email": "...",
  "ok": true,
  "deleted": {
    "contacts": 1,
    "outreach_contacts": 1,
    "send_events": 5,
    "reply_inbox": 2,
    "tracking_events": 12
  },
  "suppression_kept": true,
  "message": "..."
}
```

**Co se NEMAŽE**:
- `suppression_list` / `outreach_suppressions` — proof of opt-out (povinné dle čl. 30 GDPR + §7(4) zák. 480/2004)
- Endpoint to konkretizuje v message

**Response template**:

```
Vážená paní / pane,

Vaše osobní údaje byly vymazány v souladu s čl. 17 GDPR. Konkrétně:
- Kontaktní záznam: smazán
- Historie odeslaných emailů: smazána
- Záznamy o otevřeních / kliknutích: smazány
- Záznamy o Vašich odpovědích: smazány

Email <EMAIL> jsme zároveň přidali na suppression list. Tuto evidenci
ze zákona držíme trvale jako důkaz, že respektujeme Vaši námitku
proti zpracování (čl. 21 GDPR + §7(4) zák. 480/2004).

V budoucnu se nestane, že Vás znovu osloníme — i kdybychom Váš email
získali z jiného zdroje, suppression list ho zablokuje.

Garaaage s.r.o.
[OP — sídlo, IČO]
```

## Art. 16 — Right to rectification

Žadatel chce opravit nepřesné údaje. **Není automatizovaný endpoint** — proveď ručně:

```sql
UPDATE contacts SET first_name='<correct>', last_name='<correct>'
WHERE email = '<EMAIL>';

INSERT INTO operator_audit_log(action, actor, entity_type, entity_id, details)
VALUES('dsr_rectify', 'operator', 'email', '<EMAIL>',
       jsonb_build_object('email', '<EMAIL>', 'fields_changed', '...'));
```

## Art. 21 — Right to object (opt-out)

**Žadatel se chce odhlásit**. Toto je AUTOMATIZOVÁNO:

- Klikne na unsubscribe link v emailu → server.js `/unsubscribe` insert do `suppression_list`
- Odpoví slovem "STOP" / "unsubscribe" → IMAP poller `replyClassifier.js` regex → `negative` → `shouldSuppress` → suppression_list

Manuální opt-out (telefonem, externí kanál):

```sql
INSERT INTO suppression_list(email, reason)
VALUES('<EMAIL>', 'manual_optout')
ON CONFLICT (email) DO UPDATE SET reason='manual_optout', suppressed_at=now();

INSERT INTO operator_audit_log(action, actor, entity_type, entity_id, details)
VALUES('dsr_object', 'operator', 'email', '<EMAIL>',
       jsonb_build_object('email', '<EMAIL>', 'channel', 'phone'));
```

## Stížnost na ÚOOÚ — co dělat

Pokud žadatel hrozí stížností nebo už ji podal:

1. **Nepanikařit** — ÚOOÚ obvykle dává možnost opravit
2. **Hned vyřídit DSR** — pokud existuje legitimate basis pro odmítnutí (čl. 12(5)(b)), dokumentuj
3. **Předat LIA-001** — máš dokumentovaný oprávněný zájem
4. **Cooperate** — při inspekci ukázat:
   - LIA-001 dokument
   - ROPA dokument
   - Audit log této žádosti
   - Verifikaci že suppression list funguje (UNION test)
5. **Konzultovat právníka** pokud fine > 100k Kč

## Známé limity současného endpointu

- **Nezahrnuje binární přílohy** (logy SMTP server response, raw IMAP fetched headers) — pokud žadatel chce VŠE doslova, doplň manuálním grep'em logů
- **Tracking events** limit 1000 — pro extrémně aktivní recipienty může být víc, doplň follow-up query s offset
- **Operator_audit_log** pouze pro emails kde details obsahuje email field — některé starší záznamy mohou být missing

## Audit trail

Endpoints automaticky logují volání do `operator_audit_log`:
- `dsr_access` — kdo a kdy se ptal na koho
- `dsr_erase` — co bylo vymazáno

Toto je důkaz pro auditora že DSR jsi vyřídil včas.

```sql
-- Per-month DSR statistika:
SELECT date_trunc('month', created_at) AS month,
       action,
       COUNT(*)
FROM operator_audit_log
WHERE action LIKE 'dsr_%'
GROUP BY 1, 2
ORDER BY 1 DESC;
```
