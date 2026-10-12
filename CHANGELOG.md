# Changelog

## Unreleased

- Serve a policy selected by `SetPolicy` after launch at once: its prices, premium start, referral rates, reserved and denied lists, minimum length and open flag. The collector journals the policy's deployment initialization after the admitting receipt, authenticated like the deploy tool's admission evidence: contract ID from the deployed bytecode, nonce and owner, BLAKE3 code hash, and the init hash of the arguments actually deployed. Contract IDs don't bind init arguments, so the deployment's block must be the collected chain's at its height, linked by `prevBlockHash` to blocks the collector verified, and must list the deployment transaction; an orphan or other block hash is rejected even when its init matches the admission. Replay checks the row against the admission again and serves it only while the current admission pins the same hashes; the launch policy likewise only while the selected admission pins its genesis hashes. A mismatch or a failed lookup fails closed for that policy only, never stopping collection or other projections, and the cursor's `policyInitializations` records why; an archive that does not have the deployment yet, answers for another block or fails is asked again with backoff. A collector started on an older journal catches up a missing initialization without a rebuild.
- Price `/search` by the selected policy's five length tiers; a root below the policy minimum stays at 0. Names registered under an earlier policy stay `registered` when a later policy denies their label or raises the minimum, and labels only a later policy reserves carry the reservation reason.
- Apply the snapshot's selected policy in snapshot-mode `/search`, as replay does.

- Serve `/holdings?authority=`: every root and subname an authority currently owns or manages, with its role, built from the same publication in event-log, SQLite and snapshot modes.
- File renewals paid from a market listing (`escrow_renewed`) under the renewed name, with the payer.
- Document activity row order: by block height, then `eventIndex`, the event's position in its block. List `/holdings` in the runbook and the local smoke.

- Expose owner-bound DNS website verification with scheduled proof checks and explicit capacity errors.

- Reject incomplete or ill-typed finalized cursors without synthesizing publication fields.
- Retain complete reads and degraded health when any candidate construction step throws.

- Publish frozen reads only from a complete cursor-committed journal prefix at a non-decreasing finalized height.
- Return HTTP 503 for cold frozen stores without complete committed coverage.
- Validate unpublished incremental receipts against every candidate cursor height.
- Keep retained reads and diagnostics available when committed rows contain malformed JSON values.

- Preserve auction and fixed-sale IDs through event replay, snapshots and marketplace API responses. Reject snapshots with missing or inexact marketplace IDs.

- Serve crawler HTML previews for active names with safe site defaults. ([#201])
- Render bounded, cached PNG name cards with bundled Instrument Serif fonts. ([#201])

- Collect treasury events with decimal-string Lux totals without losing following events. ([#124])
- Expose dropped-name premiums in search and name responses. ([#124])
- Preserve registrations and exact accounting totals when cumulative premiums exceed the safe-number range. ([#124])

- Validate cross-chain address records with the shared SDK validators. ([#242])
- Serve distinct primary-name set and cleared activity with recent-change warnings. ([#243])

- Give public clients separate rate-limit budgets in the shipped Caddy deployment. ([#241])
- Reject invalid resolution names before hashing with the shared search policy. ([#241])
- Clear expired subname records and primary names while retaining namespace capacity. ([#241])
- Reject reverse identities for unknown nodes and descendants of lapsed roots, including legacy snapshots. ([#241])
- Report lapsed marketplace orders as not escrowed. ([#241])
- Serve owner, manager and controller name filters from ordered authority indexes. ([#241])

- Project transfer resets for roots and subnames without clearing descendants. ([#237])

- Expose full descendant counts, ownership summaries and ancestor authorities. ([#237])

- Apply reserved-name search policy only to roots while keeping subnames out of public registration. ([#235])

[#235]: https://github.com/HDauven/dusk-domains-protocol/issues/235

[#237]: https://github.com/HDauven/dusk-domains-protocol/issues/237

[#241]: https://github.com/HDauven/dusk-domains-protocol/issues/241

[#242]: https://github.com/HDauven/dusk-domains-protocol/issues/242
[#243]: https://github.com/HDauven/dusk-domains-protocol/issues/243
[#201]: https://github.com/HDauven/dusk-domains-protocol/issues/201
[#124]: https://github.com/HDauven/dusk-domains-protocol/issues/124

## Frozen layer / SDK 0.3.0

- Retain the last complete finalized view and lifecycle clock across blocked replay and live journal rebuilds.
- Return HTTP 503 for data routes when cold reconstruction blocks without a retained publication.
- Block publication on malformed journal rows in event-log and SQLite stores.
- Publish populated frozen views with grouped lookups instead of per-entity table scans.
- Append retained histories in receipt order and publish newest-first without shifting on every edit.
- Accept exact UTF-8 record selector keys of 1–64 bytes under SDK validation.
- Describe permissionless renewal during marketplace custody until grace ends.

- Collect finalized, rollback-filtered receipt journals for directory, policy, store,
  resolver, vault and marketplace; follow committed directory admissions on restart
  and during the same receipt.
- Use SDK transaction projection for names, generations, custody, staged/atomic
  moves, permanent forwarding, cooldowns, records, primaries, orders and liabilities.
- Preserve the HTTP routes with documented frozen fields and decimal Lux strings.
  See `docs/indexer-api.md`; rebuild fresh journal/cursor/SQLite paths at cutover.
- Consume deployment `indexer.env` and hash-verified immutable local drivers.
  Pin the published SDK 0.3.0 npm alias and handle in-place receipt projection.
  Publish independent history collections so later receipts leave earlier views unchanged.
