# Dusk Domains Indexer

Node read API and finalized archive collector for `.dusk` names. It projects
contract events into search, owner lists, records, primary names, history,
treasury/referral balances and marketplace discovery. Contracts remain canonical.

## Run and test

Use Node 24. From this repository's root:

```sh
npm ci
npm test
npm run indexer:collect -- --env-file release/indexer.env --public-dir release/contracts --event-log target/events.jsonl --cursor-file target/cursor.json
```

Copy the deployment bundle's `indexer.env`, `manifest.json` and `contracts/` together.
The collector reads the six frozen contract IDs, immutable driver filenames, schema
version and first deployment block from `indexer.env`; retain that block on restart.
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

The publication interleaving test uses fixed seed `0x53c091e7` and 96 generated
actions per store mode by default. Each shuffled action deck mutates every required
cursor field (missing, null, wrong type and out-of-range values), checks cross-field
constraints, and injects receipts that pass replay but fail finalization through
missing snapshots or mismatched digests. It also covers bad counts/byte offsets,
rejected candidates followed by lower cursors, and malformed rows of every JSON
value kind, including repeated live retention, cold starts and repair.
Each transition checks the committed prefix, lifecycle clock, history and routes.
Separate fault injection checks exceptions at each candidate stage, including view
construction after finalization. The bounded default targets roughly one minute in CI.
For a longer local run, increase the action budget per mode:

```sh
PUBLICATION_STEPS=2048 npm test -- server/local-indexer/publication-interleaving.test.mjs
```

Failures report the seed, store mode, action index and recent transition trace.

## Documentation

- [HTTP API, pagination, rate limits and CORS](docs/indexer-api.md)
- [Production operation, monitoring and recovery](docs/production-runbook.md)
- [Caddy deployment and proxy trust](deploy/README.md)
- [Legacy journal migration](docs/archive-migration.md)
- [Shared SDK event schema](https://github.com/HDauven/dusk-domains-sdk/blob/main/docs/indexer-events.md)

`server/local-indexer` owns persistence, health, HTTP and chain-height read views.
`scripts` owns collection and operator utilities; `deploy/systemd` supplies service
units. Event projection comes from `@duskdomains/sdk/projection`, topic definitions from
`@duskdomains/sdk/event-catalog`, and policy from the selected policy initialization.

For separate mainnet and testnet releases, see [the two-instance deployment guide](deploy/README.md).

Licensed under [MIT](LICENSE).

The frozen collector follows the directory, policy, admitted store/resolver shards, vault and marketplace from the first deployment block. SDK 0.3.0 projects complete finalized receipts. See [API migration shapes](docs/indexer-api.md) and [cutover instructions](deploy/README.md#frozen-deployment-cutover). The SDK is pinned to the published JSR 0.3.0 package through its npm alias.
