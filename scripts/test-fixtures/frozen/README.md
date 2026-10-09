# Frozen v1 protocol fixtures

These test-only fixtures capture the frozen protocol archive vectors and drivers.
They are excluded from npm/JSR releases. They are data drivers, not deployable
contracts. Tests exercise their actual WASM encode/decode implementations.

Reference HEAD: `58049149ba8aa0a1999bcd9d77d77a10ad3f832d` (protocol #268). Sources:

- `contracts/crates/dusk-domains-types/tests/fixtures/frozen-v1.json`
- `contracts/crates/dusk-domains-marketplace-v1/tests/market-v1.json`
- `target/frozen-drivers/wasm32-unknown-unknown/release/dusk_domains_{store,directory}.wasm`

`drivers.json` retains the SDK driver hash catalog; the store and directory WASMs are included here. The source
`schema.rs` SHA-256 is
`7f5aed0c3a27a30b310394ecd763c397b175b294f7eaa743d0165c4a003d9ebd`;
shared `driver.rs` is
`f4504328995185413e514881eb913d1c8d8033c37a004611cb3b352aa2ac831a`.
The digest tests additionally transcribe pinned results from
`dusk-domains-types/tests/frozen_wire.rs`.

Refresh fixtures from reviewed protocol output; never download deployment drivers
inside the test suite. Production drivers always come from the release manifest
and are hash-verified before instantiation.
