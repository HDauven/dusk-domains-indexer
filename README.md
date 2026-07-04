# Dusk Domains Indexer

Pre-production standalone indexer and read API for Dusk Domains.

This repository was extracted from `HDauven/dusk-names` so the event ingestion, SQLite-backed read models and operator tooling can be developed and deployed independently from the web app.

## Contents

- `server/local-indexer/`: event projectors, read models, SQLite persistence, snapshots and HTTP route handlers.
- `server/local-indexer.mjs`: CLI entrypoint for serving the indexer API.
- `scripts/`: smoke checks, backfill checks, health probes, backups, disk budget checks and operator evidence helpers.
- `deploy/systemd/`: systemd unit template for hosted beta deployments.
- `docs/`: API, event and production runbook notes.

The indexer consumes the event catalog from `@hdauven/dusk-domains-sdk/event-catalog`, so event-family changes should land in the SDK first and then be consumed here by exact commit.

## Development

```bash
npm install
npm test
```

`npm run smoke` probes a running indexer, or starts an isolated one when you pass `--event-log`/`--sqlite` fixtures.

## Runtime

Run the indexer API with:

```bash
npm start -- \
  --event-log target/dusk-domains.events.jsonl \
  --sqlite target/dusk-domains.sqlite \
  --cursor target/dusk-domains.cursor.json \
  --checkpoint target/dusk-domains.checkpoint.json \
  --strict-health \
  --watch
```

The indexer is non-canonical. It decodes Dusk Domains events into JSON/read models for search, reverse lookup, activity, treasury and referral views. Canonical ownership and records remain on-chain.

For hosted deployment, see `docs/production-runbook.md`.

## License

MIT.
