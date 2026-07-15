# Dusk Domains Indexer

Standalone indexer and read API for Dusk Domains.

The indexer turns Dusk Domains contract events into queryable read models for search, My Domains, activity, reverse lookup, treasury, referrals and marketplace discovery. It is not canonical. Contracts remain the source of truth for ownership, records, primary names, orders and funds.

## Requirements

- Node.js 24+
- npm
- Access to Dusk node/event data
- Optional SQLite database for durable hosted indexing

## Setup

```bash
npm install
npm test
```

## Run Locally

Event-log mode:

```bash
npm start -- \
  --event-log target/dusk-domains.events.jsonl \
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
