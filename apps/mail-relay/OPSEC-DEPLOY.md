# OPSEC Deploy: Anonymous Infrastructure for Anti-Trace Relay

Anonymní software na ne-anonymní infrastruktuře je bezcenný. Tento dokument popisuje jak zřídit celý stack bez identity vazby.

**Pravidlo:** Každý krok proveď přes Tor. Nikdy se nepřipojuj k infrastruktuře z domácí/pracovní sítě.

---

## Vrstva 0: Anonymní přístup

Než cokoli zaregistruješ nebo zaplatíš:

### Operační prostředí

| Možnost | Úroveň | Popis |
|---------|--------|-------|
| **Tails OS** (USB boot) | Nejlepší | Amnestický OS, veškerý traffic přes Tor, žádné stopy na disku |
| **Whonix** (VM) | Silné | Gateway VM routuje vše přes Tor, Workstation VM izolovaná |
| **Tor Browser na běžném OS** | Minimální | Pouze prohlížeč je anonymní, OS může leakovat |

**Doporučení:** Tails na USB pro veškerou správu infrastruktury. Nabootuj, proveď správu, vypni. Žádná persistence.

### Síťový přístup

| Možnost | Riziko |
|---------|--------|
| Veřejná WiFi (kavárna, knihovna) | Nízké -- žádná registrace, kamera je riziko |
| SIM bez registrace + mobilní hotspot | Střední -- záleží na jurisdikci |
| Domácí ISP přes Tor | Střední -- ISP vidí Tor usage (ale ne co děláš) |
| Domácí ISP přes VPN + Tor | Nízké -- ISP vidí VPN, VPN vidí Tor |

**Pravidlo:** Nikdy nepoužívej stejnou síť pro anonymní správu A běžné aktivity ve stejný den.

---

## Vrstva 1: Anonymní platba

Servery stojí peníze. Platba nesmí vést k tvé identitě.

### Monero (XMR) -- doporučeno

Monero je nativně soukromá kryptoměna. Transakce jsou nesledovatelné by design.

```
1. Nainstaluj Monero GUI wallet na Tails/Whonix
2. Nastav wallet tak, aby se připojoval přes Tor (Settings -> Node -> Remote node over Tor)
3. Získej XMR:
   - P2P směnárna: LocalMonero (přes Tor Browser)
   - Cash-to-Monero: hotovostní vklad na peer-to-peer platformě
   - Atomic swap: BTC -> XMR (nepotřebuje účet)
4. Pošli XMR přímo na VPS providera
```

**Nikdy:** Nekupuj XMR přes KYC burzu (Binance, Coinbase). To ničí celý účel.

### Bitcoin s mixingem -- alternativa

Bitcoin je veřejný ledger. Bez mixingu je sledovatelný.

```
1. Získej BTC (P2P, ATM s hotovostí bez ID)
2. Pošli přes CoinJoin (Wasabi Wallet, JoinMarket)
3. Minimálně 3 CoinJoin rundy
4. Potom pošli na VPS providera
```

### Hotovostní prepaid karty -- záloha

V některých jurisdikcích:
```
1. Kup prepaid Visa/Mastercard za hotovost (supermarket, kiosek)
2. Aktivuj přes Tor (někteří provideři vyžadují telefon)
3. Použij pro platbu VPS
```

**Upozornění:** Kamerové systémy v obchodech mohou spojit nákup s obličejem.

---

## Vrstva 2: Anonymní VPS

### Provideři přijímající krypto bez KYC

| Provider | Platba | KYC | Jurisdikce | Poznámka |
|----------|--------|-----|------------|----------|
| **Njalla** | XMR, BTC | Ne | Nevis (offshore) | Registruje doménu na sebe, ne na tebe |
| **1984hosting** | BTC | Ne | Island | Silná ochrana soukromí, islandské zákony |
| **FlokiNET** | XMR, BTC | Ne | Island/Rumunsko/Finsko | Explicitně pro whistleblowery |
| **Bahnhof** | BTC | Minimální | Švédsko | Provozovatel WikiLeaks serverů |
| **Privex** | XMR, BTC | Ne | Belize | VPS a dedicated servery |
| **Incognet** | XMR | Ne | USA (ale privacy-focused) | Levné VPS |

### Registrace

```
1. Otevři Tor Browser (nebo Tails)
2. Jdi na providera přes .onion adresu (pokud existuje)
3. Použij jednorázový email (viz Vrstva 2.1)
4. Zaregistruj VPS
5. Zaplať XMR/BTC
6. Zapiš si přihlašovací údaje do offline úložiště (Tails persistent volume)
```

### Jednorázový email pro registraci

Pokud provider vyžaduje email:

| Služba | Registrace | Tor přístup |
|--------|-----------|-------------|
| **ProtonMail** | Bez telefonu (někdy) | protonmailrmez3lotccipshtkleegetolb73fuirgj7r4o4vfu7ozyd.onion |
| **Tutanota** | Bez telefonu | Ano |
| **Guerrilla Mail** | Žádná registrace | Ano (dočasný email) |

**Pravidlo:** Email použij JENOM pro registraci VPS. Nikdy pro nic jiného.

---

## Vrstva 3: Anonymní doména

### Možnost A: Čistě .onion (doporučeno)

Žádná doména potřeba. Tor hidden service generuje .onion adresu automaticky.

```
Výhody:
- Žádná registrace
- Žádná platba
- DNS není zranitelný
- End-to-end šifrováno Torem

Nevýhody:
- Přístupné jen přes Tor Browser
- Dlouhé adresy (56 znaků v3)
```

**Toto je doporučený přístup pro relay sloužící ohroženým osobám.**

### Možnost B: Anonymní doména přes Njalla

Njalla registruje doménu na sebe (proxy registrace). Ty jsi anonymní vlastník.

```
1. Zaregistruj se na Njalla přes Tor
2. Zaplať XMR
3. Vyber doménu (.org, .net -- ne .com kvůli WHOIS)
4. Nasměruj DNS na VPS IP
```

**Riziko:** DNS záznamy jsou veřejné. IP tvého VPS bude viditelná v DNS. Používej jen pro clearnet přístup, ne pro primární .onion intake.

---

## Vrstva 4: Server Setup

### 4.1 SSH přes Tor

**Nikdy se nepřipojuj k serveru přímo.** Vždy přes Tor.

```bash
# Na Tails/Whonix:
torsocks ssh root@<server-ip>

# Nebo přes .onion SSH (pokud provider nabízí):
ssh root@<server>.onion
```

### 4.2 Bootstrap skript

Po prvním přihlášení na čistý Debian/Ubuntu VPS:

```bash
# Stáhni a spusť provision script
torsocks curl -sL https://raw.githubusercontent.com/<repo>/scripts/provision-server.sh | bash
```

Nebo manuálně (viz `scripts/provision-server.sh`):

```bash
# 1. Aktualizuj systém
apt update && apt upgrade -y

# 2. Instalace
apt install -y docker.io docker-compose tor wireguard ufw

# 3. Firewall -- povolit JEN Tor + WireGuard + SSH
ufw default deny incoming
ufw default deny outgoing
ufw allow in 22/tcp        # SSH (přes Tor)
ufw allow in 51820/udp     # WireGuard
ufw allow out 9001/tcp     # Tor OR port
ufw allow out 9030/tcp     # Tor Dir port
ufw allow out 443/tcp      # HTTPS (pro Tor bootstrapping)
ufw allow out 80/tcp       # HTTP (pro Tor bootstrapping)
ufw enable

# 4. Generace klíčů
DATA_KEY=$(head -c 32 /dev/urandom | base64)
VAULT_KEY=$(head -c 32 /dev/urandom | base64)
API_TOKEN=$(head -c 24 /dev/urandom | base64)

# 5. TLS certifikát (self-signed pro .onion)
openssl req -x509 -newkey rsa:4096 -keyout /opt/relay/key.pem \
  -out /opt/relay/cert.pem -days 365 -nodes -subj "/CN=relay"

# 6. Ulož klíče
cat > /opt/relay/secrets <<EOF
DATA_ENCRYPTION_KEY_B64=$DATA_KEY
VAULT_ENCRYPTION_KEY_B64=$VAULT_KEY
DEV_API_TOKEN=$API_TOKEN
EOF
chmod 600 /opt/relay/secrets

# 7. Spusť relay
docker compose -f /opt/relay/docker-compose.production.yml up -d
```

### 4.3 Tor Hidden Service

Tor hidden service se konfiguruje automaticky přes anti-trace-relay (`TOR_ENABLED=true`). Alternativně manuálně:

```bash
# /etc/tor/torrc
HiddenServiceDir /var/lib/tor/anti-trace-relay/
HiddenServicePort 80 127.0.0.1:8090
HiddenServiceVersion 3

systemctl restart tor
cat /var/lib/tor/anti-trace-relay/hostname
# → výpis: xxxxxxxxxxxx.onion
```

### 4.4 WireGuard VPN Server

```bash
# Viz scripts/provision-wireguard.sh
wg genkey | tee /etc/wireguard/server_private | wg pubkey > /etc/wireguard/server_public

cat > /etc/wireguard/wg0.conf <<EOF
[Interface]
PrivateKey = $(cat /etc/wireguard/server_private)
Address = 10.66.66.1/24
ListenPort = 51820
PostUp = iptables -A FORWARD -i wg0 -j ACCEPT; iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
PostDown = iptables -D FORWARD -i wg0 -j ACCEPT; iptables -t nat -D POSTROUTING -o eth0 -j MASQUERADE

[Peer]
# Relay klient
PublicKey = <relay-public-key>
AllowedIPs = 10.66.66.2/32
EOF

systemctl enable wg-quick@wg0
systemctl start wg-quick@wg0
```

---

## Vrstva 5: Ongoing OPSEC

### Co dělat

| Pravidlo | Proč |
|----------|------|
| Správu vždy přes Tor (torsocks ssh) | Tvoje IP nesmí být v server logech |
| Rotuj servery každé 3-6 měsíců | Snižuje riziko dlouhodobé korelace |
| Monitoruj Tor hidden service dostupnost | Výpadek = potenciální problém |
| Používej oddělené identity pro správu a osobní život | Žádné crossover |
| Klíče zálohuj offline (papír nebo šifrovaný USB) | Server může být zabaven |

### Co nedělat

| Anti-pattern | Proč je to nebezpečné |
|-------------|----------------------|
| SSH z domácí IP | IP v server auth logu = tvoje identita |
| Platba kartou/převodem | Bankovní záznam = tvoje identita |
| Registrace s osobním emailem | Email = tvoje identita |
| Přihlášení na osobní účty ze stejného Tor exit node | Korelace aktivit |
| Zmínka o serveru na sociálních sítích | OSINT riziko |
| Přístup z telefonu s SIM na tvoje jméno | IMSI = tvoje identita |

### Incident response

Pokud máš podezření na kompromitaci:

```
1. NEPRIHLASOUJ SE na server (potvrdíš svou identitu)
2. Použij jiný VPS k ověření dostupnosti (curl přes Tor)
3. Pokud server běží normálně: může být odposloucháván, ale ne zabaven
4. Pokud server neodpovídá: pravděpodobně zabaven
5. V obou případech: NEPOUŽÍVEJ tento server znovu
6. Spusť nový server z nového VPS s novými klíči
7. Informuj uživatele o novém .onion endpointu přes bezpečný kanál
```

---

## Vrstva 6: Doporučená architektura

```
[Submitter]
    | (Tor Browser nebo amnesic submit binary)
    v
[.onion hidden service] ←── Tor network ──── [VPS #1: anti-trace-relay]
                                                |
                                          [WireGuard tunel]
                                                |
                                          [VPS #2: WireGuard server]
                                                |
                                          [Tor exit] → [privacy-gateway / SMTP]
```

### Dva servery (doporučeno)

| Server | Role | Proč oddělený |
|--------|------|---------------|
| VPS #1 | anti-trace-relay + Tor hidden service | Přijímá submissions, hostuje .onion |
| VPS #2 | WireGuard server + outbound Tor | Odděluje intake od delivery |

**Výhoda:** Kompromitace jednoho serveru neodhalí celý systém. VPS #1 nemá přímý přístup k internetu (jen přes WireGuard k VPS #2).

### Jeden server (jednodušší)

Pokud dva servery nejsou možné:

```
VPS #1: anti-trace-relay + Tor + WireGuard (klient ke komerčnímu VPN)
```

Méně bezpečné, ale funkční. `TRANSPORT_MODE=vpn+tor` stále poskytuje defense-in-depth.

---

## Honest Limitations

| Co chrání | Co nechrání |
|-----------|------------|
| Identitu operátora od VPS providera | Operátora od providera, pokud provider spolupracuje s law enforcement a má přístup k serveru |
| Traffic od network observerů | Fyzický přístup k VPS (provider má root k hardwaru) |
| Platební stopu (Monero) | Monero, pokud směnárna loguje IP (proto vždy přes Tor) |
| Přístupové vzory (SSH over Tor) | OPSEC chyby operátora (přihlášení z osobní IP) |

**Klíčový princip:** Žádný technický systém nevyrovná OPSEC chybu. Jedna přihlášení z domácí IP zruší měsíce anonymizace.
