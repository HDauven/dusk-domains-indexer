# Dusk Domains Indexer

Standalone indexer and read API for Dusk Domains.

The indexer turns Dusk Domains contract events into queryable read models for search, My Domains, activity, reverse lookup, treasury, referrals and marketplace discovery. It is not canonical. Contracts remain the source of truth for ownership, records, primary names, orders and funds.

## Requirements

- Node.js 24+
- npm
- An archive-enabled Rusk exposing `lastBlockPair`, `blocks` and complete, ordered, hash-bound `contractEventBatch` responses
- Optional SQLite database for durable hosted indexing

## Setup

```bash
npm install
npm test
```

## Run Locally

Start one collector per journal (Node.js uses the installed WASM data drivers; no Deno checkout is needed):

```bash
npm run indexer:collect -- --env-file .env.local --public-dir public/contracts \
  --node-url http://127.0.0.1:18180/ --from-block 1 \
  --event-log target/dusk-domains.events.jsonl --cursor-file target/dusk-domains.cursor.json
```

For a new deployment, `--from-block` may be its first deployment height; keep that value on restart. Collection processes finalized blocks in order, in batches of at most 100, polling every five seconds. Expect finality plus polling delay, rather than unfinalized live updates. The journal is synced before its hash/byte cursor; an uncommitted crash tail is truncated and refetched. Missing archive blocks or decoding errors block progress instead of silently skipping events.

**Legacy migration:** stop the old collector/API and preserve their files. Replay from at/before deployment into **new journal, cursor and SQLite paths**, then point the API at those files. Old live/proof projections lack identities needed for safe archive deduplication; they are never mixed automatically. Check `/health.ok` after catch-up. Event-log/SQLite health is degraded for missing/legacy cursors, stopped/stale collectors or incomplete replay; `finalizedBlockHeight` is null without archive coverage. Snapshot mode remains an explicit offline fallback.

`npm run backfill:check -- --node-url <archive> --json` probes the actual archive API. Availability at the head does not prove retention back to deployment. Nodes without the required archive surface must be upgraded; the collector does not silently fall back to live-only capture.

Event-log mode:

```bash
npm start -- \
  --event-log target/dusk-domains.events.jsonl \
  --cursor target/dusk-domains.cursor.json \
  --watch
```

SQLite mode:

```bash
npm start -- \
  --sqlite target/dusk-domains.sqlite \
  --event-log target/dusk-domains.events.jsonl \
  --cursor target/dusk-domains.cursor.json \
  --checkpoint target/dusk-domains.checkpoint.json \
  --strict-health \
  --watch
```

SQLite mode uses WAL and a single writer. It stores raw events, replay state, cursor metadata and checkpoints so the service can restart without a full rebuild.

## API

Common routes:

```text
GET /health
GET /search?query=
GET /names?owner=
GET /resolve?name=
GET /name?node=
GET /records?node=
GET /record?node=&key=
GET /record-history?node=&key=
GET /activity?node=
GET /reverse?type=&value=
GET /subnames?parentNode=
GET /treasury
GET /referrals?referrer=
GET /fee-config
GET /marketplace/config
GET /marketplace/fixed-sales
GET /marketplace/fixed-sale?node=
GET /marketplace/auctions
GET /marketplace/auction?node=
GET /marketplace/offers?node=&buyerAuthority=
GET /marketplace/offer?node=&buyerAuthority=
GET /marketplace/refund?authority=
```

See `docs/indexer-api.md` for response shapes.

Marketplace Lux values are accepted only while exactly representable as JSON
safe integers. Unsafe `u64` values are quarantined as replay warnings rather
than rounded into a different price or balance.

## Source Layout

```text
server/local-indexer/   API server, read models, projectors, persistence and health checks
scripts/                smoke tests, backup checks, monitoring and operator utilities
deploy/systemd/         hosted service unit template
docs/                   API, events, storage and production runbooks
```

## Operations

Useful commands:

```bash
npm start
npm run indexer:collect
npm run production:check
npm run health
npm run backup
npm run disk
```

Hosted deployments should set `DUSK_DOMAINS_INDEXER_CORS_ORIGIN` or pass `--cors-origin` so browser reads are limited to the public frontend origin.

For production setup and recovery, see:

- `docs/production-runbook.md`
- `docs/public-beta-operator-guide.md`
- `docs/storage-budget.md`

## Event Catalog

The indexer consumes event definitions from `@duskdomains/sdk/event-catalog`. Event-family changes should land in the SDK first, then be consumed here with an exact dependency update.

## License

MIT
