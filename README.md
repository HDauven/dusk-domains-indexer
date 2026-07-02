# Dusk Domains Indexer

Private standalone indexer and read API for Dusk Domains.

This repository was extracted from `HDauven/dusk-names` so the event ingestion, SQLite-backed read models and operator tooling can be developed and deployed independently from the web app.

## Contents

- `server/local-indexer/`: event projectors, read models, SQLite persistence, snapshots and HTTP route handlers.
- `server/local-indexer.mjs`: CLI entrypoint for serving the indexer API.
- `scripts/`: smoke checks, backfill checks, health probes, backups, disk budget checks and operator evidence helpers.
- `docs/`: API, event and production-indexer notes from the app repo.
- `src/names/indexerEventCatalog.mjs`: copied event catalog used by the current projector tests. This should become an SDK dependency once the public package boundary is stable.

## Development

```bash
npm install
npm test
npm run smoke
```

## Runtime

Run the indexer API with:

```bash
npm start -- --event-log target/dusk-domains.events.jsonl --sqlite target/dusk-domains.sqlite
```

The indexer is non-canonical. It decodes Dusk Domains events into JSON/read models for search, reverse lookup, activity, treasury and referral views. Canonical ownership and records remain on-chain.
