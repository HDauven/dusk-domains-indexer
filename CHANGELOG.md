# Changelog

## Unreleased

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
