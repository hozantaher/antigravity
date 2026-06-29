# Rozšíření Mullvad pool endpointů (Sprint AS6)

Tento playbook popisuje kroky pro přidání nových WireGuard endpointů do `anti-trace-relay` služby a zvýšení kapacity pro nové schránky.

## Požadavky

- Přístup k Mullvad účtu (https://mullvad.net)
- Railway dashboard pro editaci env proměnných
- Přístup k BFF operátorskému panelu pro ověření

## Krok 1: Generování nové Mullvad WireGuard konfigurace

1. Přihlas se na https://mullvad.net do svého účtu
2. Jdi na Account → WireGuard configuration
3. Klikni "Generate new key"
4. Vyber geografické servery (doporučeni: CZ Praha, CZ Brno fallback, SK Bratislava)
5. Stáhni `.conf` soubor
6. Otevři soubor v textovém editoru a vypiš si:
   - `PrivateKey` (sekce `[Interface]`)
   - `PublicKey` (sekce `[Peer]`)
   - `Endpoint` (sekce `[Peer]`, formát: `hostname:port`)
   - `Address` (sekce `[Interface]`, IP adresa)

**Pozor:** Mullvad limituje maximálně 5 device keys na jeden účet. Pokud už máš 5 klíčů, vytvoř nový Mullvad účet (nebo smaž starý nepoužívaný klíč).

### Příklad konfigurace

```
[Interface]
PrivateKey = ILl3lFI8X2xqD8PZplwA9wq2VzFU3j...
Address = 10.64.222.0/32
DNS = 1.1.1.1

[Peer]
PublicKey = WM1ywDnFAkPqH9+JXqJgqLc4TjUFDQqjbLpkHsIHgHM=
Endpoint = cz5-wireguard.mullvad.net:51820
AllowedIPs = 0.0.0.0/0
```

## Krok 2: Přidání konfigurace do Railway env

1. Otevři Railway dashboard → `anti-trace-relay` service
2. Jdi na Variables tab
3. Edituj env proměnnou `WIREPROXY_POOL_CONFIG` (JSON array)
4. Přidej nový endpoint s touto strukturou:

```json
{
  "label": "cz-prg-wg-105",
  "country": "CZ",
  "peer_pubkey": "WM1ywDnFAkPqH9+JXqJgqLc4TjUFDQqjbLpkHsIHgHM=",
  "peer_host": "cz5-wireguard.mullvad.net:51820"
}
```

**Konvence pro label:**
- Formát: `<country-2>-<city-3>-wg-<seq>`
- Příklady: `cz-prg-wg-101`, `cz-prg-wg-102`, `cz-brn-wg-103`, `sk-bts-wg-201`
- `country` → `CZ`, `SK`, `PL`, `HU` (Mullvad dostupné)
- `seq` → pořadové číslo v daném městě (počínaje 01)

### Pokud jde o nový Mullvad účet

1. Vytvoř nový env var `WIREPROXY_POOL_PRIVATE_KEY_<ACCOUNT>` (např. `WIREPROXY_POOL_PRIVATE_KEY_MULLVAD_2`)
2. Napiš tam PrivateKey z konfigu
3. V `WIREPROXY_POOL_CONFIG` přidej pole `private_key_var: "WIREPROXY_POOL_PRIVATE_KEY_MULLVAD_2"` (relay to zpracuje)

**Příklad s více účty:**

```json
[
  {
    "label": "cz-prg-wg-101",
    "country": "CZ",
    "peer_pubkey": "...",
    "peer_host": "cz5-wireguard.mullvad.net:51820"
  },
  {
    "label": "cz-prg-wg-105",
    "country": "CZ",
    "peer_pubkey": "...",
    "peer_host": "cz6-wireguard.mullvad.net:51820",
    "private_key_var": "WIREPROXY_POOL_PRIVATE_KEY_MULLVAD_2"
  }
]
```

## Krok 3: Restart anti-trace-relay služby

1. V Railway dashboardu jdi na `anti-trace-relay` → Deployments
2. Klikni "Redeploy" na aktuální deployment
3. Čekej na успеш (zelený status)

Aktuální endpoint health se načte z Mullvad během prvního startu služby.

## Krok 4: Ověření nové kapacity v BFF

1. Otevři Operátor dashboard (Schránky page)
2. Ověř panel "Kapacita Mullvad fondu" v horní části
3. Check: `pool_size` by měl být zvýšen o počet nových endpointů
4. Curlem pro debug:
   ```bash
   curl https://your-bff-domain.com/api/relay/pool-capacity
   ```
   
   Měl by vrátit:
   ```json
   {
     "pool_size": 8,
     "pinned_count": 1,
     "ratio": 0.125,
     "endpoints": [
       {
         "label": "cz-prg-wg-101",
         "country": "CZ",
         "pinned_to": { "id": 12834, "from_address_redacted": "<u>@..." }
       },
       {
         "label": "cz-prg-wg-105",
         "country": "CZ",
         "pinned_to": null
       }
     ]
   }
   ```

## Krok 5: Test nového endpointu

Před používáním v produkčních zprávách:

1. **SMTP probe:**
   - Otevři Schránky page → vyber kteroukoliv schránku
   - Klikni "SMTP test" button
   - Ověř že zprávou projde novým endpointem
   - Podívej se do logs (relay + mailbox) na egress IP

2. **IMAP probe:**
   - Klikni "IMAP test" na stejné schránce
   - Ověř inbox fetch bez chyb

## Krok 6: Bezpečnostní checklist

- [ ] **Nikdy necommituj Mullvad keys do gitu** — používej pouze env vars
- [ ] **Rotace klíčů každých 90 dní** — viz `docs/playbooks/secret-rotation.md`
- [ ] **Test rDNS nového IP** — pokud je blacklisted (Spamhaus, atd.), zvol jiný Mullvad server
- [ ] **Check seznam.cz logs** — ověř, že nový endpoint není jejich systémy automaticky blokován
- [ ] **Backup stávajícího WIREPROXY_POOL_CONFIG** — v případě rollback

## Krok 7: Mailbox creation post-expansion

Poté co jsi rozšířil pool:

1. V BFF panelu "Kapacita Mullvad fondu" se tlačítko "Přidat schránku" aktivuje (pokud byl před tím zablokován)
2. Postup pro vytvoření nové schránky viz `docs/playbooks/first-campaign-launch.md` → část "Nová schránka"
3. Nový mailbox se automaticky přiřadí prvnímu volnému endpointu při prvním odeslání/testu

## Troubleshooting

### Pool se nereloaduje v BFF
- Restarť BFF Express server (stop + `pnpm dev` nebo Railway redeploy outreach-dashboard)
- Ověř env proměnné v Railway are up-to-date (`curl /api/relay/pool-capacity` by měl vrátit nové číslo)

### rDNS lookup failed
- Nový Mullvad IP nemá reverse DNS → Seznam to nemusí ráda
- Volba: vyhledej jiný Mullvad server nebo počkej na Mullvad rDNS setup (řídí Mullvad tým)

### Endpoint se zobrazuje v pool ale schránka se nemůže přiřadit
- Check DB constraints: `SELECT COUNT(*) FROM outreach_mailboxes WHERE pinned_endpoint_label = 'cz-prg-wg-105'`
- Pokud něco lockuje label, smaž ručně: `UPDATE outreach_mailboxes SET pinned_endpoint_label = NULL WHERE id = ...` (jen v debug/dev!)

### Certifikát expired na Mullvad serveru
- Ostatně, TLS handshake failuje s `certificate_verify_failed`
- Ověř že relay je na aktuální verzi (atd. cert store je up-to-date)

## Doporučené konfigurace

- **Malá deployment (1–3 schránky):** 4 endpointy (3 aktivní + 1 reserve)
- **Střední (4–6 schránek):** 8 endpointů
- **Velká (7–12 schránek):** 14 endpointů (12 aktivní + 2 reserve)

Viz `docs/playbooks/pool-sizing-guide.md` pro detailní doporučení.

## Poznámky

- Endpoint label je immutable (jednou přiřazený mailbox zůstane na tom endpointu forever)
- Pokud endpointu dojde reputation (blacklist), mailbox je prakticky nepoužitelný bez manuální reparametrization (out of scope)
- Počet Mullvad device keys na účet: max 5 → pro 7+ endpointů vytvoř další účty
