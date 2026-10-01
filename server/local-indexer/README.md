# local-indexer

HTTP read model service for Dusk Domains.

The indexer exists for search, lists, history, and fast UI reads. It is not canonical. Contracts remain the source of truth for ownership, records, primary names, and funds.

Supported sources:

- Snapshot file for lightweight local fixtures.
- Event log file for deterministic replay.
- SQLite store for durable local or hosted indexing.

The SQLite mode uses WAL and a single writer. It stores raw events, replay state, checkpoint data, and cursor metadata so the service can restart without rebuilding from scratch.

Public release boundary:

- The API is a non-canonical read model; contracts remain the source of truth for ownership, records, primary names, and funds.
- The HTTP client and response guards can be published as `@dusk-domains/indexer-client`.
- The server implementation can be published as `@dusk-domains/indexer` only when `npm run check:public-indexer-surface` passes.
- Do not ship mnemonics, private keys, privileged deployment scripts, or private RPC credentials with the indexer package.

Common routes:

- `GET /health`
- `GET /search?query=...`
- `GET /names?owner=...`
- `GET /resolve?name=...`
- `GET /name?node=...`
- `GET /records?node=...`
- `GET /record?node=...&key=...`
- `GET /record-history?node=...&key=...`
- `GET /activity?node=...`
- `GET /reverse?type=...&value=...`
- `GET /subnames?parentNode=...`
- `GET /treasury`
- `GET /referrals?referrer=...`
- `GET /fee-config`

Useful commands:

```sh
npm run indexer:local
npm run indexer:local -- --sqlite .data/dusk-domains.sqlite --watch
npm run indexer:local -- --sqlite .data/dusk-domains.sqlite --cors-origin https://dusk.domains
npm run check:public-indexer-surface
npm run check:indexer-sqlite
npm run check:indexer-production
```

Local development defaults to `Access-Control-Allow-Origin: *`. Hosted beta operators should set `DUSK_DOMAINS_INDEXER_CORS_ORIGINS` or pass `--cors-origin` so browser reads are limited to the public frontend origin at the API layer as well as at the reverse proxy.

Production HTTP policy: set `NODE_ENV=production` and configure `DUSK_DOMAINS_INDEXER_CORS_ORIGINS` with exact, comma-separated origins. Empty production allowlists deny cross-origin access. `DUSK_DOMAINS_INDEXER_RATE_LIMIT` defaults on in production; `DUSK_DOMAINS_INDEXER_RATE_LIMIT_MAX=200` and `DUSK_DOMAINS_INDEXER_RATE_LIMIT_WINDOW_MS=60000` tune it. Keep `DUSK_DOMAINS_INDEXER_TRUST_PROXY=false` unless a trusted proxy overwrites forwarding headers and the upstream is private. See the [API policy](../../docs/indexer-api.md) for pagination, 429 handling, and error request IDs.

See [Public Integration Release](../../docs/public-integration-release.md) for package boundaries and [Public Beta Operator Guide](../../docs/public-beta-operator-guide.md) for backup, restore, health, and monitoring procedures.

Reserved issuance emits the normal registry registration/ownership events followed by the router's `reserved_name_issued`. The name API exposes `issuedAsReserved` and `reservedIssuance` (operator, registry, issuance time and block height). Provenance survives transfers and renewals; a new registration resets it before any new issuance event. Search reports held reserved roots as registered, including renewal grace, and returns the reserved policy again after release. The local event classifier supports this event with the pinned SDK catalog as well as the next SDK release.
