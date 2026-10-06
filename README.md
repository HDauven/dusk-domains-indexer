# Dusk Domains Indexer

Node read API and finalized archive collector for `.dusk` names. It projects
contract events into search, owner lists, records, primary names, history,
treasury/referral balances and marketplace discovery. Contracts remain canonical.

## Run and test

Use Node 24. From this repository's root:

```sh
npm ci
npm test
npm run indexer:collect -- --env-file .env.local --public-dir public/contracts --from-block 1 --event-log target/events.jsonl --cursor-file target/cursor.json
```

Supply the deployment's node URL and router/core/treasury IDs in `.env.local`,
plus marketplace when configured, and matching data-driver Wasm in `public/contracts`.
Use the deployment start height (or earlier) in place of `1`, retaining it on restart.
The archive must serve `lastBlockPair`/`blocks` and either `contractEventBatch`
or finalized `checkBlock`/`contractEvents`. `npm run backfill:check -- --node-url <archive> --json`
probes that API; it does not prove historical retention.

Run the API in a second terminal:

```sh
npm start -- --sqlite target/indexer.sqlite --event-log target/events.jsonl --cursor target/cursor.json --checkpoint target/checkpoint.json --strict-health --watch --host 127.0.0.1 --port 8787
```

One collector writes each journal; one API process writes its SQLite/WAL cache.
The collector syncs the journal before its hash/byte cursor and refetches an
uncommitted crash tail. Gaps or decoding failures stop progress. The API replays
on startup, then applies appended lines; a replaced/shrunken journal is rebuilt.
Snapshot mode is an explicit fixture/offline source, not finalized archive coverage.
`npm test` includes the check for missing npm commands in tracked Markdown.

## Documentation

- [HTTP API, pagination, rate limits and CORS](docs/indexer-api.md)
- [Production operation, monitoring and recovery](docs/production-runbook.md)
- [Caddy deployment and proxy trust](deploy/README.md)
- [Legacy journal migration](docs/archive-migration.md)
- [Shared SDK event schema](https://github.com/HDauven/dusk-domains-sdk/blob/main/docs/indexer-events.md)

`server/local-indexer` owns persistence, health, HTTP and chain-height read views.
`scripts` owns collection and operator utilities; `deploy/systemd` supplies service
units. Event normalization, projection and reserved-name policy come from
`@duskdomains/sdk/projection`; subscriptions use `@duskdomains/sdk/event-catalog`.

For separate mainnet and testnet releases, see [the two-instance deployment guide](deploy/README.md).

Licensed under [MIT](LICENSE).
