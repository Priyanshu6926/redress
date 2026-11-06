# Why Arkiv Instead of Traditional Postgres

---

## 1. Censorship Resistance & Verifiability
A centralized PostgreSQL database allows the server operator or hosting provider to silently alter restitution amounts, delete incident records, or falsify historical verdict outcomes. With Arkiv:
- Verdict records and incident calculations are immutably signed and timestamped.
- Borrowers do not have to trust our API server when verifying whether a liquidation was wrongful.

## 2. Multi-Party Auditability
When a protocol governance body or insurance provider settles hundreds of thousands of dollars in restitution, both victims and liquidity providers require independent auditability. Arkiv provides:
- Cryptographic proof of ownership for sentinel verifications.
- Standardized open query endpoints that any third party or DAO can run independently of our frontend.

## 3. Composable Decentralized State
Other protocols, frontends, or automated agents can query Arkiv directly without permission, API keys, or web server uptime dependencies.

