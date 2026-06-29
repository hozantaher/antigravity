# NLnet NGI Zero Commons Fund Application

**Fund:** NGI Zero Commons Fund (13th Open Call)
**Deadline:** June 1, 2026, 12:00 CEST
**URL:** https://nlnet.nl/commonsfund/

---

## Proposal Name

Anti-Trace Relay: Privacy-Hardened Communication for Conflict Zones

## Abstract

Anti-Trace Relay is an open-source communication relay that enables persecuted individuals in conflict zones to submit and receive messages without exposing their identity, location, or communication patterns. The system provides 18 defense layers including end-to-end encryption (X25519+AES-256-GCM), epoch-based forward secrecy (hourly key rotation), Shamir secret sharing (K-of-N message fragmentation), constant-rate traffic emission (eliminates volume analysis), pool-based mixing (decorrelates message ordering), dead drop delivery (eliminates sender-recipient link), and amnesic clients that leave zero persistent state on the submitter's device.

The relay is implemented as two Go services (stdlib-only, zero external dependencies) with a one-shot amnesic client binary. Both sender and receiver derive all keys from a shared passphrase — no infrastructure, no accounts, no registration. A duress mechanism (indistinguishable from a wrong password) protects against physical coercion. The system is live on Railway with verified end-to-end encrypted message roundtrips over the public internet.

The project seeks funding for: independent security audit, Tor hidden service deployment, multi-relay mix network implementation, and user testing with partner NGOs in conflict regions.

## Have you been involved with projects or organisations relevant to this project before?

The team has experience building privacy-first backend systems, secure email relay infrastructure, and cryptographic protocol implementations in Go. The existing codebase (v0.2.0, released April 2026) includes 52 Go packages, 130+ tests, 3 Architecture Decision Records totaling 2,800+ lines, and has been verified end-to-end over public internet with epoch-rotated forward secrecy and Shamir message fragmentation.

## Requested Amount

€48,000

## Explain what the requested budget will be used for

| Item | Amount | Description |
|------|--------|-------------|
| Independent security audit | €15,000 | Professional cryptographic and protocol review by qualified auditor (e.g., Cure53, Trail of Bits, or equivalent) |
| Tor hidden service infrastructure | €3,000 | VPS deployment (12 months), Tor hidden service operation, monitoring |
| Multi-relay mix network | €12,000 | Design and implementation of 3-node mix network with independent operators, cross-relay Shamir fragmentation |
| User testing with NGOs | €8,000 | Pilot deployment with 2-3 partner NGOs in conflict regions, feedback collection, UX iteration on submitter guide |
| Post-quantum cryptography | €5,000 | Hybrid X25519+Kyber key encapsulation for quantum-resistant message sealing |
| Documentation and localization | €3,000 | Additional language translations (Dari, Tigrinya, Burmese), operational guides for NGO staff |
| Project management | €2,000 | Coordination, reporting, community engagement |

## Compare your own project with existing or historical efforts

| System | Comparison |
|--------|------------|
| **SecureDrop** | SecureDrop is a whistleblower submission system designed for journalist-source communication. Anti-Trace Relay shares the threat model but adds constant-rate emission (SecureDrop has variable traffic), Shamir fragmentation (SecureDrop uses single-path delivery), epoch-based forward secrecy (SecureDrop uses static GPG keys), and amnesic clients with duress mechanisms. SecureDrop requires Tor Browser; Anti-Trace Relay's submit binary works standalone. |
| **Signal** | Signal provides excellent real-time encrypted messaging with Double Ratchet forward secrecy. Anti-Trace Relay is not a messaging app — it's an asynchronous relay for high-latency, high-security submissions. Signal requires phone number registration and a persistent app; Anti-Trace Relay has zero persistent state and derives everything from a memorizable passphrase. |
| **Briar** | Briar provides peer-to-peer encrypted messaging over Tor. Anti-Trace Relay is server-mediated (dead drop model) rather than peer-to-peer, which avoids the requirement for both parties to be online simultaneously. Briar has better real-time properties; Anti-Trace Relay has better traffic analysis resistance (constant-rate emission, pool mixing). |
| **Nym mixnet** | Nym provides network-level traffic analysis resistance through a decentralized mix network with cover traffic. Anti-Trace Relay operates at the application level with similar principles (constant-rate emission, pool mixing) but as a single deployable binary rather than a token-economic decentralized network. Nym is more comprehensive but significantly more complex to deploy and operate. |
| **OnionShare** | OnionShare enables anonymous file sharing via Tor. Anti-Trace Relay focuses on message relay with forward secrecy and Shamir fragmentation, which OnionShare does not provide. OnionShare is ephemeral (one-time share); Anti-Trace Relay maintains dead drop slots for asynchronous polling. |

## What are significant technical challenges you expect to solve?

1. **Multi-relay mix network coordination without centralized state.** Current implementation uses single-relay Shamir fragmentation. Scaling to 3+ independent relays requires a coordination protocol that does not create a centralized metadata point. We plan to use a decentralized slot discovery mechanism where each relay independently derives slot IDs from the shared epoch, eliminating inter-relay communication.

2. **Post-quantum hybrid encryption without external dependencies.** Adding CRYSTALS-Kyber (ML-KEM) alongside X25519 in Go stdlib-only is challenging because Go's standard library does not yet include a KEM primitive. We will implement a minimal ML-KEM-768 or use the experimental `crypto/mlkem` package when available, with a hybrid construction that falls back gracefully if the PQ component fails.

3. **Usability in low-connectivity, high-surveillance environments.** Submitters in conflict zones may have intermittent connectivity, restricted internet, and active monitoring. The amnesic client needs to handle: connection retries with exponential backoff through Tor, message queuing for later delivery, and a user experience that works on low-end hardware in under 60 seconds.

4. **Verifiable security properties without formal verification budget.** The system makes strong claims (forward secrecy, information-theoretic share security, constant-rate indistinguishability). We plan to develop a targeted property-based test suite using Go's built-in fuzzing that continuously verifies: epoch key isolation, Shamir reconstruction correctness, and constant-rate timing invariants.

## Describe the ecosystem of the project, and how you will engage with relevant actors

**Target users:** Human rights defenders, journalists, and civilians in conflict zones who need to communicate sensitive information (evacuation requests, evidence of violations, requests for assistance) without exposing themselves to surveillance.

**NGO partners:** We will engage with 2-3 organizations working in conflict regions (e.g., Committee to Protect Journalists, Reporters Without Borders, AccessNow) for pilot testing and feedback. The submitter guide is already translated into Arabic, Ukrainian, Farsi, and Russian.

**Security research community:** The 3 Architecture Decision Records (2,800+ lines) provide complete transparency on design decisions, threat model, and honest limitations. We will submit the project for review to relevant academic venues (PETS, USENIX Security) and engage with the Tor Project community for hidden service best practices.

**Open source ecosystem:** The project is Go stdlib-only (zero dependencies), which makes it auditable, reproducible, and free from supply chain risks. All code will be published under an open source license (MIT or Apache-2.0) upon grant approval.

**Sustainability:** The relay is designed for low-cost operation (single binary, file-based storage, €4/month VPS). NGOs can self-host with the provided provisioning scripts. No ongoing funding is required for basic operation.

---

## Technical Summary (for attachment)

### Architecture

```
Submitter (amnesic client, zero state)
    |
    v
Anti-Trace Relay (constant-rate emission, pool mixing)
    | Tor / VPN / VPN+Tor transport
    v
Dead Drop Slots (HMAC-derived, hourly rotation)
    |
    v
Recipient (polls slots, reassembles Shamir shares, decrypts)
```

### Defense Layers (18 total)

1. Content sanitization (HTML, scripts, tracking, headers)
2. Identity vault (separate AES-256-GCM key)
3. E2E encryption (X25519 + HKDF-SHA256 + AES-256-GCM)
4. Metadata minimization (15-min timestamp buckets, size-class padding)
5. Constant-rate emission (fixed interval, zero volume signal)
6. Pool-based mixing (crypto/rand uniform selection, 1/N correlation)
7. Dead drop delivery (HMAC-derived slots, hourly rotation)
8. Cover traffic (indistinguishable from real at constant rate)
9. Transport chain (direct / Tor / VPN / VPN+Tor)
10. Amnesic clients (PBKDF2 600K + HKDF, zero persistent state)
11. Secure memory (mlock, SecureBuffer, WipeAll, signal-safe cleanup)
12. Duress system (forensically indistinguishable from wrong password)
13. Epoch-based forward secrecy (hourly X25519 key rotation via HKDF)
14. Shamir Secret Sharing (K-of-N message fragmentation, GF(256))
15. Multi-path routing (shares distributed across independent relays)
16. Decoy dead drop posts (N decoys per real message, random slots)
17. Persistent encrypted pool (survives restart, eliminates timing leak)
18. Emission retry (constant rate guaranteed, requeue + cover fallback)

### Current State

- v0.2.0 released (GitHub, 16 artifacts, 5 platforms)
- Live on Railway (both services healthy)
- 52 Go packages, 130+ tests, -race clean
- 3 ADR documents (2,800+ lines)
- Submitter guide in 5 languages
- E2E verified: epoch keys + Shamir over public internet

### Milestones for Funded Work

| Month | Deliverable |
|-------|-------------|
| 1-2 | Security audit: engage auditor, provide codebase + ADRs |
| 2-3 | Tor hidden service deployment + multi-relay prototype |
| 3-5 | Multi-relay mix network (3 independent relays, cross-relay Shamir) |
| 4-6 | NGO pilot testing (2-3 partner organizations) |
| 5-7 | Post-quantum hybrid encryption |
| 6-8 | UX iteration based on NGO feedback |
| 8-10 | Documentation, additional translations, operational guides |
| 10-12 | Final audit report, public release, sustainability handoff |
