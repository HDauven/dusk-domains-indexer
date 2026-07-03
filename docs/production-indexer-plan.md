# Production Indexer Plan

Status: P1 readiness plan with SQLite/WAL event-store gate and operator commands
Owner issue: [#114 Production indexer and event pipeline](https://github.com/HDauven/dusk-names/issues/114)

The current indexer is good enough for local and devnet proof work: it can serve a snapshot, replay a JSONL event log, persist the observed event ledger into SQLite/WAL, expose stable API routes, and support browser refetches after writes. It now has an initial durable gate for observed events: append-only JSONL ingestion, SQLite event storage, atomic live cursor writes, persisted replay checkpoint metadata, strict health, and operator check commands. It is still not a full production indexer with normalized database projections or archive-node historical extraction.

## Current State

Implemented:

- `server/local-indexer.mjs` serves `/health`, `/search`, `/resolve`, `/name`, `/records`, `/record`, `/record-history`, `/names`, `/activity`, `/reverse`, `/subnames`, `/subname`, `/treasury`, and `/referrals`.
- Snapshot, JSONL event-log, and SQLite/WAL event-store modes are supported.
- `/health` exposes source mode, generated timestamp, routes, schema version, event count, name count, current/finalized block height, lag, last event, optional cursor, optional replay checkpoint, optional durable checkpoint state, and warnings.
- Event projectors cover lifecycle, commitments, resolver records, reverse records, subnames, treasury events, and referral events.
- Data-driver event normalization is extracted to `scripts/indexer-operator/event-decoder.mjs`; the local collector now subscribes and appends normalized envelopes instead of owning decode semantics inline.
- `server/local-indexer/projector-parity.test.mjs` compares local-indexer replay with the shared SDK projector using the same normalized fixture events.
- `npm run indexer:checkpoint` rebuilds `target/dusk-names-devnet-indexer.checkpoint.json` from the observed event journal.
- `npm run indexer:local -- --sqlite <db> --event-log <events.jsonl>` imports the event journal into a SQLite/WAL ledger and serves the same API routes from that durable store.
- `npm run check:indexer-sqlite` smoke-checks the SQLite path against the local event journal.
- `npm run check:indexer-production` reloads the journal in strict mode and fails if cursor/checkpoint/replay/finality health is unsafe.
- `npm run check:indexer-production -- --sqlite <db> --require-sqlite --require-archive-snapshot --require-backup --require-sqlite-backup --deployment-start-height <height> --archive-snapshot-height <height> --archive-snapshot <file> --backup-manifest <manifest> --backup-restore-dir <dir> --max-source-age-minutes 10` proves the event journal starts at the intended deployment window, the SQLite/WAL serving cache is strict-health safe, the live collector source is fresh, a retained archive-node snapshot artifact exists, and the indexer backup includes/restores the SQLite database.
- `npm run indexer:health` probes a running `/health` endpoint for safe serving status, lag, event count, route manifest, schema version, and last-event metadata.
- `npm run indexer:monitor` runs the same health contract from a supervisor/scheduler and can send webhook alerts on unsafe health.
- `npm run indexer:backup -- --sqlite <db>` creates a checksumed backup bundle for the event journal, cursor, checkpoint, SQLite database/WAL sidecars, runtime env, deployment proof, and browser write proof.
- The live event collector writes cursor files atomically.
- Smoke tests cover route manifest, direct route parameter errors, owner-filtered `My Domains`, Phoenix reverse exclusion, snapshot/event-log fallback, and event-log replay boundaries.

Known production gaps:

- Initial SQLite event-ledger schema exists with a `schema_migrations` baseline; normalized read-model tables and future migrations are still pending.
- No database-backed archive-node replay from deployment height yet.
- No chain-level event-envelope metadata capture yet; W3sper's convenience contract event API decodes payloads but does not currently pass through raw RUES tx/block/event-index headers to the collector.
- No hosted alerting target is configured in this repo.
- Strict health, the health probe, and the monitor can detect stale/missing cursor/checkpoint state, but production still needs the process supervisor or monitoring provider wired to `npm run indexer:monitor` with `DUSK_DOMAINS_INDEXER_ALERT_WEBHOOK_URL`.
- No hosted deployment topology.

Current operating recommendation:

- Keep the event-journal/cursor/checkpoint indexer as the devnet collector source, and serve public beta from SQLite/WAL once the hosted deployment is in place.
- For public beta, run a project-owned archive node, preserve a snapshot from at or before the deployment height, and start the event collector from the deployment window.
- Do not block public beta on old split-stack support or generic historical backfill from genesis. The launch gate should prove replay from the deployment height plus retained archive snapshot evidence.
- Keep normalized database projection tables as the next hardening slice once the hosted beta topology and raw event envelope access are stable.

## Open Operator Decisions

These decisions should be made before public beta:

| Decision | Recommendation |
| --- | --- |
| Hosted indexer topology | One primary hosted event collector/API plus retained archive-node snapshot and backup bundle. |
| Archive snapshot retention | Snapshot at or before deployment start height; record artifact path and retention location in the launch checklist. |
| Alerting destination | Configure `DUSK_DOMAINS_INDEXER_ALERT_WEBHOOK_URL` in the host scheduler or process supervisor. |
| Backup retention | Keep event journal, cursor, checkpoint, runtime env, deployment proof, browser proof, and archive snapshot together; move older verified bundles off-host before the API disk reaches 70% usage. |
| Database timing | Use SQLite/WAL for public-beta event storage; add normalized projection tables and migrations before mainnet or broader production usage. |

## Target Architecture

```text
Dusk archive node / RUES event source
  -> event collector
  -> data-driver event decoder
  -> SQLite/WAL event store
  -> deterministic projector
  -> read-model API
  -> future normalized projection tables
  -> HTTP API
  -> web app / SDK / wallet / explorer
```

Canonical state remains in DuskDS contracts. The indexer is a read model and must fail closed when it is stale, inconsistent, or missing required event history.

## Durable Data Model

Initial SQLite tables:

| Store | Key | Purpose |
| --- | --- | --- |
| `events` | `event_key` plus block/tx/event metadata | Raw normalized event ledger for replay and audit. |
| `indexer_kv` | `key` | Cursor, checkpoint, import metadata, warnings, and source metadata. |

Future normalized tables:

| Store | Key | Purpose |
| --- | --- | --- |
| `names` | `node` | Lifecycle state, owner, manager, resolver, expiry, status. |
| `name_records` | `(node, record_key)` | Current typed resolver record state. |
| `name_record_events` | `(node, record_key, block_height, tx_id, event_index)` | Append-only resolver record set/clear history, including previous/current payloads where available. |
| `reverse_records` | `(endpoint_type, endpoint_value)` | Public primary-name state. |
| `subnames` | `node` | Subname lifecycle, parent node, owner, manager, resolver, policy. |
| `activity` | `(node, block_height, tx_id, event_index)` | User-facing lifecycle and mutation history. |
| `commitments` | `commitment` | Commit/reveal UI recovery state. |
| `treasury` | `chain_id` | Protocol fee accounting read model. |
| `treasury_claims` | `(tx_id, event_index)` | Recent operator claim history. |
| `referrals` | `referrer` | Claimable and claimed referral reward totals. |
| `referral_activity` | `(referrer, tx_id, event_index)` | Recent referral accrual/claim history. |

All projected tables must be rebuildable from `events`.

## Event Ingestion Rules

- Normalize every decoded contract event into a stable event envelope before projection. For beta, `scripts/indexer-operator/event-decoder.mjs` is the reference decoder used by the local collector.
- Preserve chain ID, contract ID, contract key, event type, block height, tx ID, event index, observed timestamp, and decoded payload.
- Reject malformed event rows into a warning/dead-letter path without corrupting the read model.
- Apply events idempotently using `(chain_id, block_height, tx_id, event_index)` or the strongest available unique key.
- Treat Phoenix endpoints as unsupported public primary identities even if a malformed event appears.
- Clear stale derived active records when lifecycle events release or expire a name beyond grace.
- Preserve enough deployment metadata to reject stale proof artifacts from older contract IDs, chain IDs, source commits, or deployment timestamps.

## Canonical Read Cross-Checks

The production indexer should not be the only proof of value-bearing state. For launch-critical reads, add contract-read cross-checks or explicit confidence states:

| Read | Required cross-check |
| --- | --- |
| Search availability | Registrar/core active/grace state when a user is about to purchase. |
| Owned domains | Owner field from indexed lifecycle event plus latest contract read in live write flows. |
| Forward record | Resolver/core readback after set/clear writes. |
| Reverse primary | Reverse/core readback plus SDK forward/reverse verification. |
| Treasury claimable | Treasury/core readback before claim submission and after indexed confirmation. |
| Referral claimable | Referral/core readback before claim submission and after indexed confirmation. |

If contract cross-checks are unavailable, the API should expose a lower confidence state and the UI should avoid showing final value-bearing success.

## Finality And Reorg Policy

Production policy:

- Run a project-owned archive node and keep a snapshot from slightly before the Dusk Domains deployment height.
- Rebuild from the archive node starting at the deployment height or a small configured safety window before it.
- Record `deploymentStartHeight`, `archiveSnapshotHeight`, and the snapshot artifact location in the launch checklist. The archive snapshot height must be less than or equal to the deployment start height.
- Treat RUES events from ratified DuskDS blocks as finalized for read-model projection. Dusk docs describe Succinct Attestation as deterministic once a block is ratified, with no user-facing reorgs in normal operation.
- Preserve raw RUES envelope metadata in the event store: block height, tx ID, event index or deterministic per-transaction event ordinal, contract ID, event topic, and observed timestamp.
- Until the collector captures raw RUES metadata directly, production health must remain degraded for live-subscription-only journals that lack block height or tx ID.

Alternative modes kept for future review:

| Mode | Behavior | Product implication |
| --- | --- | --- |
| Conservative finalized-only | Project only blocks considered final. | Slower UI confirmation, stronger correctness. |
| Optimistic with confirmations | Project recent blocks as pending, promote after N confirmations. | Faster UI, requires pending/final state in API. |
| Node-guaranteed finality | Trust Dusk finality once event is returned by the node. | Simplest if Dusk devnet/mainnet event API guarantees this. |

The current MVP should keep displaying transaction confirmation separately from indexed confirmation until archive replay and raw envelope metadata are in place.

## API Health Contract

`GET /health` should expose:

| Field | Requirement |
| --- | --- |
| `ok` | `false` when reads are unsafe or the indexer is too stale. |
| `mode` | `database`, `snapshot`, `event-log`, or `degraded`. |
| `chainId` | Active chain. |
| `schemaVersion` | Read-model schema version. |
| `apiVersion` | HTTP API version. |
| `eventSchemaVersion` | Dusk Domains event schema version. |
| `readModelSchemaVersion` | Read-model response version. |
| `package` | Package name/version, source commit when configured, and SDK dependency. |
| `deployment` | Derived chain ID, core/treasury contract IDs, event counts, first/last heights, missing contracts and conflicts. |
| `sqlite` | SQLite mode metadata including schema migration version and WAL mode. |
| `currentBlockHeight` | Best observed node height. |
| `finalizedBlockHeight` | Best finalized/projected block. |
| `lagBlocks` | `currentBlockHeight - finalizedBlockHeight`, when known. |
| `eventCount` | Applied event count. |
| `lastEvent` | Contract, type, tx ID, block height. |
| `degradedReason` | Machine-readable reason code and operator-facing message when `ok=false`. |
| `warnings` | Malformed events, source gaps, degraded mode. |
| `routes` | Route manifest. |

Wallets and value-bearing app flows should refuse indexed success if `ok` is false or lag exceeds the launch threshold.

## Rebuild And Recovery

Initial operator commands:

```text
npm run indexer:collect -- --env-file .env.devnet.local --event-log target/dusk-names-devnet-indexer.events.jsonl --cursor-file target/dusk-names-devnet-indexer.cursor.json
npm run check:indexer-production -- --rebuild --json --sqlite target/dusk-names-devnet-indexer.sqlite --require-sqlite --require-archive-snapshot --require-backup --require-sqlite-backup --derive-deployment-start-height --archive-snapshot-height <snapshot-height> --archive-snapshot <snapshot-file> --backup-manifest <backup-manifest> --backup-restore-dir <restore-dir> --max-source-age-minutes 10
npm run indexer:local -- --sqlite target/dusk-names-devnet-indexer.sqlite --event-log target/dusk-names-devnet-indexer.events.jsonl --cursor target/dusk-names-devnet-indexer.cursor.json --strict-health
npm run check:indexer-sqlite -- --json
npm run indexer:local -- --event-log target/dusk-names-devnet-indexer.events.jsonl --cursor target/dusk-names-devnet-indexer.cursor.json --checkpoint target/dusk-names-devnet-indexer.checkpoint.json --strict-health
npm run indexer:health -- --health-url http://127.0.0.1:8787/health --max-lag-blocks 12 --max-source-age-minutes 10
npm run indexer:monitor -- --health-url http://127.0.0.1:8787/health --require-alert-webhook --alert-webhook-url https://alerts.example/dusk-domains --max-source-age-minutes 10
npm run indexer:disk -- --live-dir /var/lib/dusk-domains --backup-dir /var/backups/dusk-domains --out target/dusk-names-devnet-indexer.disk.json
npm run indexer:backup -- --output-dir target/indexer-backups --sqlite target/dusk-names-devnet-indexer.sqlite
npm run indexer:backup -- --verify --manifest target/indexer-backups/<backup-id>/manifest.json --restore-dir target/indexer-backups/restore-stage
```

For the current controlled devnet beta evidence, `check:public-beta-readiness` uses stable local paths:

```text
target/archive-snapshots/public-beta-devnet-archive-marker.json
target/indexer-backups/public-beta-devnet/manifest.json
target/indexer-backups/restore-stage-public-beta-devnet
```

Hosted operators can keep using the explicit `check:indexer-production` arguments above with their archive
snapshot and backup locations.

The production check validates the observed journal against the two-contract deployment surface (`core` and `treasury`) and fails if legacy split-contract rows, mismatched contract IDs, pre-deployment events, stale checkpoints, stale collector source timestamps, or missing block-height/finality metadata are present. Proof-generated event logs and live collector events must include `meta.blockHeight`; otherwise the strict finality gate remains unsafe. Operators can pass `--derive-deployment-start-height` to use the earliest active core/treasury journal event as the deployment start height, while still supplying the retained archive snapshot height and artifact path.

## Disk Budget And Retention

For public beta, the event journal and SQLite/WAL database are deliberately small enough for a 2 vCPU / 4 GB / 80 GB API VM when the archive node is hosted elsewhere. The operator still needs a hard disk policy:

- Keep live state under `/var/lib/dusk-domains` and backups under `/var/backups/dusk-domains` or equivalent persistent paths.
- Alert when either path exceeds 70% usage.
- Treat 85% usage as an incident: disable live writes, preserve the latest journal/cursor/checkpoint/database/proof bundle, and move verified older backup bundles off-host.
- Do not prune the append-only event journal or retained archive snapshot unless the replacement backup has passed `npm run indexer:backup -- --verify` and the production gate passes with that backup manifest.
- Store backup manifests with source commit, chain ID, core contract ID, treasury contract ID, deployment start height, archive snapshot height, event count, and SQLite/WAL sidecar checksums.

Quick operator checks:

```text
df -h /var/lib/dusk-domains /var/backups/dusk-domains
du -sh /var/lib/dusk-domains /var/backups/dusk-domains
npm run indexer:disk -- --live-dir /var/lib/dusk-domains --backup-dir /var/backups/dusk-domains --out /var/lib/dusk-domains/disk-budget.json
npm run indexer:backup -- --verify --manifest /var/backups/dusk-domains/<backup-id>/manifest.json --restore-dir /var/tmp/dusk-domains-restore
```

Hosted beta requirements:

- Run an archive node and retain a snapshot from at or before the core/treasury deployment height.
- Record `deploymentStartHeight`, `archiveSnapshotHeight`, snapshot artifact path, core contract ID, treasury contract ID, chain ID, source commit, and operator recipient in the launch checklist.
- Start event ingestion from the deployment height, not from "latest".
- Keep the append-only event journal, cursor, checkpoint, SQLite database/WAL sidecars, env handoff, devnet proof, and browser write proof in backup bundles.
- Verify each retained backup with `npm run indexer:backup -- --verify ...` and stage restores before replacing live data.
- Run `npm run indexer:monitor -- --require-alert-webhook ...` from the host scheduler or process supervisor with `DUSK_DOMAINS_INDEXER_ALERT_WEBHOOK_URL` configured.
- Treat `/health.ok=false`, replay warnings, cursor/checkpoint mismatch, legacy split-contract rows, lag above the configured threshold, or stale cursor/checkpoint source timestamps as unsafe for value-bearing UI success.

Future normalized-projection commands still needed:

```text
indexer backfill --from-block <height> --to-block <height|latest>
indexer rebuild-projections --from-sqlite
indexer verify --name <name.dusk>
indexer export --out <snapshot.json>
```

## Testing Matrix

| Area | Required coverage |
| --- | --- |
| Event normalization | malformed payload, missing tx ID, missing block, unknown event, every current core/treasury event name. |
| Projector parity | same normalized fixture events produce matching SDK projector and server replay state. |
| Idempotency | duplicate event rows do not double-count names, treasury, or referrals. |
| Lifecycle | active, grace, expired, released, re-registered name. |
| Resolver | set, overwrite, clear, bounded batch set/clear, malformed record, high-risk recent-change warning. |
| Reverse | set, clear, mismatch, Phoenix rejected/ignored. |
| Subnames | create, delegate, revoke, parent expiry/release clears active lists. |
| Treasury | fee received, claim, over-claim not projected as success. |
| Referrals | accrual, claim, unsupported deployment, supported empty referrer. |
| Health | stale cursor, missing source, replay warnings, schema mismatch. |
| Browser | write -> transaction confirmed -> indexer refetched -> UI updates only after indexed confirmation. |

## Delivery Slices

1. **IDX-01: Durable Store Adapter**
   Add a production storage abstraction and initial SQLite/Postgres-compatible schema.

2. **IDX-02: Event Envelope And Idempotency**
   Normalize every observed event into a stable envelope and dedupe before projection.

3. **IDX-03: Cursor, Checkpoint, And Health**
   Persist cursor/checkpoint state, expose lag/finality health, and return unsafe health when source state is stale, incomplete, or not production-grade.

4. **IDX-04: Rebuild And Replay**
   Add deterministic rebuild from event store and replay from JSONL.

5. **IDX-05: Devnet Continuous Event Pipeline**
   Run collector during installed-wallet browser writes and prove indexed state without manual snapshot edits.

6. **IDX-06: Production Runbook**
   Document start, stop, rebuild, verify, export, and incident recovery steps.

## Readiness Gate

Production-indexer readiness requires:

```text
npm run test -- --run src/names/indexer.test.ts src/names/indexerClient.test.ts
npm run check:indexer-local-event-log
npm run check:indexer-sqlite
npm run check:indexer-local-snapshot
npm run check:indexer-backfill
npm run check:indexer-production
npm run indexer:monitor
npm run check:browser-devnet-write
npm run check:devnet-complete
```

`check:indexer-production` proves the observed-event durable journal gate, deployment binding, route manifest including `/fee-config`, SQLite/WAL strict-health serving state when run with `--sqlite <db> --require-sqlite`, live source freshness when run with `--max-source-age-minutes`, archive-snapshot retention evidence when run with `--require-archive-snapshot`, and backup/restore evidence when run with `--require-backup --require-sqlite-backup --backup-manifest <manifest> --backup-restore-dir <dir>`. `check:indexer-backfill` still proves the historical-backfill boundary, not historical backfill completion. True production readiness still requires either a decoded historical range event source or a documented finality/event-source guarantee plus hosted alerting.

## Operator Runbook

The concrete beta operating procedure is defined in [Public Beta Operator Guide](public-beta-operator-guide.md).
