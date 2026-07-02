# Storage Budget

Status: public beta guardrail

Dusk contracts currently have a 4 GB storage ceiling. Dusk Domains should stay far below that limit by keeping canonical contract state small, bounded, and typed, while leaving discovery, search, activity history, and UI state to the indexer.

## Canonical Contract State

`DuskNamesCore` stores only data that must be canonical:

| State | Growth driver | Current bound |
| --- | --- | ---: |
| Names | one `CoreNameRecord` per registered domain or subdomain | one row per node |
| Records | `(node, key) -> RecordValue` | 16 records per name |
| Record keys | record map key plus `RecordValue.key` | 64 bytes |
| Record values | typed public resolver value | 512 bytes |
| Batch record writes | one vector of set/clear mutations | 8 mutations and 4,096 bytes |
| Primary names | one public Moonlight endpoint primary record | 192-byte endpoint value |
| Commitments | one pending commit per reservation | 5 block minimum wait, 8,640 block max age |
| Subdomains | one `SubnameRecord` plus one name row per subdomain | one row per node |
| Fee config | operator-controlled annual prices and referral bps | fixed-size config |

`DuskNameTreasury` stores only money-movement state:

| State | Growth driver | Current bound |
| --- | --- | ---: |
| Totals | aggregate fee and claim counters | fixed-size counters |
| Operator | current typed operator and Moonlight payout recipient | one row |
| Allowed fee sources | allowed core contract IDs | configured deployment list |
| Referral rewards | one row per referrer with an outstanding or historical reward | one aggregate row per referrer |

## Indexer-Derived State

These are not stored as canonical contract state:

- search availability caches;
- My Domains lists;
- subdomain lists by parent;
- recent update warnings;
- activity history;
- transaction IDs, event indexes, and block metadata;
- rendered profile cards or other UI-only metadata.

The indexer derives those views from events and can rebuild them from the deployment start height. This keeps onchain storage focused on ownership, routing, resolver records, primary names, commitments, and treasury accounting.

## Planning Estimates

These estimates are conservative planning envelopes, not serialized byte proofs. The exact DuskDS/rkyv storage footprint includes collection and allocator overhead that should be measured after the contract storage API exposes stable byte accounting.

| Item | Typical planning envelope | Worst-case planning envelope |
| --- | ---: | ---: |
| Registered domain, no records | 0.5-1 KB | 2 KB |
| Registered domain with 3-4 common records and primary name | 2-4 KB | 8 KB |
| Registered domain at the current 16-record cap | 10-14 KB | 16 KB |
| Subdomain without records | 0.75-1.5 KB | 3 KB |
| Subdomain at the current 16-record cap | 11-15 KB | 18 KB |
| Pending commitment | 128-256 B | 512 B |
| Referral accrual/claim row per referrer | 128-256 B | 512 B |

Using the 16 KB worst-case domain envelope, 4 GB supports roughly 260,000 maxed-out domains before operational headroom. Using the common 2-4 KB envelope, the same ceiling supports well over 1 million ordinary domains. Public beta should monitor actual serialized storage growth rather than rely on these envelopes as hard capacity.

## Record Limits

The current hard limits live in `contracts/crates/dusk-names-core/src/lib.rs`:

| Limit | Value |
| --- | ---: |
| `MAX_RECORDS_PER_NAME` | 16 |
| `MAX_RECORD_MUTATIONS_PER_BATCH` | 8 |
| `MAX_RECORD_BATCH_PAYLOAD_BYTES` | 4,096 |
| `MAX_RECORD_KEY_BYTES` | 64 |
| `MAX_RECORD_VALUE_BYTES` | 512 |
| `MAX_ENDPOINT_VALUE_BYTES` | 192 |

These limits intentionally reject arbitrary profile blobs. Common public records such as `moonlight_address`, `website`, `avatar`, `content_pointer`, `dusk_contract`, and `evm_address` fit inside the cap. Larger documents, legal files, disclosures, images, and profile payloads should be stored offchain with a bounded pointer record.

## Test Coverage

The core contract tests must cover:

- oversized record keys;
- oversized record values;
- excessive records per name;
- excessive record mutations per batch;
- oversized batch payloads;
- oversized primary endpoint values;
- failed validation leaving existing records and pending commitments unchanged.

Run:

```bash
cargo test -p dusk-names-core
npm run check:storage-budget
```

## Migration Notes

If storage pressure grows faster than expected, keep the canonical state compatible and compact in this order:

1. Measure actual serialized bytes per map row on a deployed test contract.
2. Prune stale commitments after `MAX_COMMITMENT_AGE_BLOCKS` through a bounded cleanup call.
3. Keep record history in events and the indexer, not in contract state.
4. Intern common record keys or switch to typed record-key discriminants.
5. Pack lifecycle and status fields only after test coverage proves no behavior change.
6. Consider a storage deposit or higher renewal fee only if measured storage pressure justifies it.

Do not migrate toward arbitrary unbounded records. The public contract should remain a compact ownership and routing layer.
