# Changelog

## Unreleased

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
