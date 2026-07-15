# Public Beta Operator Guide

Status: beta operations guide

This guide is the operator-facing companion to the launch runbook. It covers the minimum process for running Dusk Domains in public beta: environment setup, indexer operations, treasury/referral policy, recovery, and known limitations.

## Environment Setup

Required services:

- Dusk archive/full node endpoint for the selected network.
- Dusk Domains Core contract ID.
- Dusk Domains Treasury contract ID.
- Dusk Domains Marketplace contract ID when marketplace routes are enabled.
- Matching data-driver WASM files for every deployed contract.
- Continuous event collector writing an append-only event journal.
- Read API serving the projected indexer state.
- Web app configured with the same contract IDs and indexer URL.
- Public artifact bundle containing the release manifest, package manifest, method manifest, call examples, and data-driver WASM files.

Use [.env.indexer.example](../.env.indexer.example) as the private operator environment template for the hosted indexer processes. It is separate from [.env.public-beta.example](../.env.public-beta.example), which is the public frontend runtime handoff. Do not publish the indexer env file; it may contain alerting URLs or private infrastructure references.

## Minimum Host Sizing

For a controlled devnet/testnet beta with the archive node hosted separately, the indexer/API can start on a small persistent VM:

| Component | Minimum beta target | Notes |
| --- | ---: | --- |
| CPU | 2 vCPU | Enough for one collector, one SQLite/WAL writer, and the read API. |
| Memory | 4 GB RAM | Keep process memory, SQLite page cache, and Node/Vite tooling separate. |
| Disk | 80 GB SSD | Sufficient for beta event journal, SQLite database/WAL files, checkpoints, proofs, and several backup bundles. |
| Filesystem | Persistent local SSD/block storage | Avoid network filesystems for the SQLite write path. |

This sizing assumes:

- the Dusk archive node runs elsewhere;
- ingestion starts from the Dusk Domains deployment height or a small safety window before it;
- archive snapshots are stored separately from the API VM or copied off-host after capture;
- backups are rotated before disk usage reaches 70%;
- only one process writes to SQLite.

Use a larger machine if the archive node is co-located, if event history is backfilled from a much earlier height, or if public traffic grows beyond invited beta usage.

Public runtime config must expose only:

```text
VITE_DUSK_DOMAINS_CORE_CONTRACT_ID
VITE_DUSK_DOMAINS_TREASURY_CONTRACT_ID
VITE_DUSK_DOMAINS_MARKETPLACE_CONTRACT_ID
VITE_DUSK_DOMAINS_CORE_DRIVER_URL
VITE_DUSK_DOMAINS_TREASURY_DRIVER_URL
VITE_DUSK_DOMAINS_MARKETPLACE_DRIVER_URL
VITE_DUSK_DOMAINS_NODE_URL
VITE_DUSK_DOMAINS_CHAIN_ID
VITE_DUSK_DOMAINS_INDEXER_URL
VITE_DUSK_DOMAINS_ENABLE_MARKETPLACE
```

Do not publish old split-contract IDs for registry, registrar, controller, resolver, or reverse registry as active public write targets.

Before public beta, run `npm run check:storage-budget` and confirm the contract record limits in `docs/storage-budget.md` match the audited source commit.

Generate and verify public integration artifacts before linking third-party docs:

```text
npm run release:artifacts -- \
  --network <network> \
  --chain-id <chain-id> \
  --env-file .env.devnet.local

npm run check:release-artifacts -- --source-commit current
npm run check:public-indexer-surface
```

Publish artifact URLs alongside the runtime config so wallets and explorers can validate the same contract IDs and data-driver hashes. The full public/private package boundary is defined in [Public Integration Release](public-integration-release.md).

## Indexer Operations

The event journal, SQLite/WAL database, cursor, checkpoint, runtime env, deployment proof, and browser proof are the minimum recovery set.

Start collector:

```text
npm run indexer:collect -- \
  --env-file .env.production.local \
  --event-log /var/lib/dusk-domains/events.jsonl \
  --cursor-file /var/lib/dusk-domains/cursor.json
```

Build the SQLite store and replay checkpoint, then run the production checks:

```text
npm run check:indexer-production -- \
  --event-log /var/lib/dusk-domains/events.jsonl \
  --cursor /var/lib/dusk-domains/cursor.json \
  --checkpoint /var/lib/dusk-domains/checkpoint.json \
  --sqlite /var/lib/dusk-domains/indexer.sqlite \
  --env-file .env.production.local \
  --proof-report /var/lib/dusk-domains/deployment-proof.json \
  --derive-deployment-start-height \
  --require-sqlite \
  --rebuild
```

Serve API:

```text
npm run indexer:local -- \
  --sqlite /var/lib/dusk-domains/indexer.sqlite \
  --event-log /var/lib/dusk-domains/events.jsonl \
  --cursor /var/lib/dusk-domains/cursor.json \
  --strict-health \
  --host 0.0.0.0 \
  --port 8787 \
  --watch
```

`--sqlite` enables WAL mode and imports the append-only event journal before serving. The API still projects deterministically from the event ledger on startup; normalized read-model tables are a later optimization.

SQLite/WAL operating rules:

- Run exactly one collector/importer writer per SQLite database.
- Keep the database, `-wal`, and `-shm` files on the same persistent disk.
- Stop the API or use a filesystem snapshot before copying raw SQLite files.
- Prefer `npm run indexer:backup` plus a staged restore proof for routine backups.
- Keep the append-only JSONL event journal even when SQLite is healthy; it is the easiest audit/replay source.
- Treat the SQLite database as rebuildable from the event journal and contract/archive evidence, not as canonical protocol state.

### Disk Budget And Rotation

Keep `/var/lib/dusk-domains` for live state and `/var/backups/dusk-domains` for retained bundles. They can be separate disks, but both need persistent storage and both should be monitored.

Operational rules:

- Alert when either live data or backup storage reaches 70% usage.
- Before deleting anything, create a fresh backup, verify it, and stage a restore directory.
- Move older verified backup bundles off-host before pruning local copies.
- Never delete the append-only event journal, latest cursor, latest checkpoint, current SQLite database/WAL sidecars, current deployment proof, latest installed-wallet browser proof, or retained archive-node snapshot unless a newer verified backup bundle contains them.
- If live storage approaches 85%, disable live writes, keep the read API online only when strict health is safe, move verified backup bundles off-host, and restart from a staged restore only after `npm run check:indexer-production` passes.

Quick local inspection:

```text
df -h /var/lib/dusk-domains /var/backups/dusk-domains
du -sh /var/lib/dusk-domains /var/backups/dusk-domains
npm run indexer:disk -- \
  --live-dir /var/lib/dusk-domains \
  --backup-dir /var/backups/dusk-domains \
  --out /var/lib/dusk-domains/disk-budget.json
```

`indexer:disk` fails when live or backup storage reaches the configured warning threshold, which defaults to 70% usage. Keep the JSON output with the operator evidence bundle; it is host-local evidence and does not contain secrets.

Health probe:

```text
npm run --silent indexer:health -- \
  --health-url https://indexer.example/health \
  --max-lag-blocks 12 \
  --max-source-age-minutes 10 \
  --min-events 1 \
  --deployment-start-height <deploy-height> \
  --archive-snapshot-height <snapshot-height> \
  --archive-snapshot /var/snapshots/dusk-archive-before-launch \
  --out /var/lib/dusk-domains/indexer-health.json
```

Use the same `deploymentStartHeight`, `archiveSnapshotHeight`, and retained snapshot artifact path recorded in the launch checklist. The health probe must fail if the running indexer cannot prove current/last-event block metadata at or after deployment start, if the retained archive snapshot starts after deployment, or if the latest cursor/checkpoint source timestamp is older than the configured `--max-source-age-minutes` window.
Keep the captured JSON with the launch evidence bundle and pass it to `npm run launch:evidence -- --indexer-health-report <file>`.

Monitor and alert:

```text
DUSK_DOMAINS_INDEXER_ALERT_WEBHOOK_URL=https://alerts.example/dusk-domains \
npm run indexer:monitor -- \
  --health-url https://indexer.example/health \
  --require-alert-webhook \
  --max-lag-blocks 12 \
  --max-source-age-minutes 10 \
  --min-events 1 \
  --deployment-start-height <deploy-height> \
  --archive-snapshot-height <snapshot-height> \
  --archive-snapshot /var/snapshots/dusk-archive-before-launch \
  --interval-ms 60000 \
  --iterations 1
```

Run the monitor from the process supervisor or hosting platform scheduler. `--require-alert-webhook` should be enabled for public beta so unsafe health cannot pass silently. The monitor must exit non-zero on unsafe health even when the alert is delivered successfully.

## Process Supervisor Layout

Use whichever supervisor your host already supports, but keep the process boundaries explicit:

| Process | Purpose | Restart policy |
| --- | --- | --- |
| `dusk-domains-collector` | Runs `npm run indexer:collect` and appends decoded events to `events.jsonl`. | Restart on failure with a short delay. |
| `dusk-domains-api` | Runs `npm run indexer:local -- --sqlite ... --watch` and serves `/health` plus read routes. | Restart on failure after the collector is healthy. |
| `dusk-domains-monitor` | Runs `npm run indexer:monitor -- --require-alert-webhook ...` from a timer or long-running loop. | Alert on failure; do not mask non-zero exits. |

Minimal systemd-style shape:

```text
[Unit]
Description=Dusk Domains event collector
After=network-online.target

[Service]
WorkingDirectory=/srv/dusk-domains
EnvironmentFile=/etc/dusk-domains/indexer.env
ExecStart=/usr/bin/npm run indexer:collect -- \
  --env-file ${DUSK_DOMAINS_RUNTIME_ENV_FILE} \
  --event-log /var/lib/dusk-domains/events.jsonl \
  --cursor-file /var/lib/dusk-domains/cursor.json
Restart=on-failure
RestartSec=5

[Unit]
Description=Dusk Domains indexer API
After=network-online.target dusk-domains-collector.service

[Service]
WorkingDirectory=/srv/dusk-domains
EnvironmentFile=/etc/dusk-domains/indexer.env
ExecStart=/usr/bin/npm run indexer:local -- \
  --sqlite /var/lib/dusk-domains/indexer.sqlite \
  --event-log /var/lib/dusk-domains/events.jsonl \
  --cursor /var/lib/dusk-domains/cursor.json \
  --checkpoint /var/lib/dusk-domains/checkpoint.json \
  --strict-health \
  --cors-origin https://dusk.domains \
  --host 0.0.0.0 \
  --port 8787 \
  --watch
Restart=on-failure
RestartSec=5

[Unit]
Description=Dusk Domains indexer monitor
After=network-online.target dusk-domains-api.service

[Service]
WorkingDirectory=/srv/dusk-domains
EnvironmentFile=/etc/dusk-domains/indexer.env
ExecStart=/usr/bin/npm run indexer:monitor -- \
  --health-url ${DUSK_DOMAINS_INDEXER_HEALTH_URL} \
  --require-alert-webhook \
  --max-lag-blocks 12 \
  --max-source-age-minutes 10 \
  --min-events 1 \
  --deployment-start-height ${DUSK_DOMAINS_DEPLOYMENT_START_HEIGHT} \
  --archive-snapshot-height ${DUSK_DOMAINS_ARCHIVE_SNAPSHOT_HEIGHT} \
  --archive-snapshot ${DUSK_DOMAINS_ARCHIVE_SNAPSHOT}
Restart=on-failure
RestartSec=60
```

Do not store mnemonics, private keys, wallet backups, or operator credentials in `indexer.env`. Keep public node/contract/data-driver values in the separate runtime env file referenced by `DUSK_DOMAINS_RUNTIME_ENV_FILE`, and keep alert webhook credentials in the monitor process environment, not in public frontend env.

For hosted beta, set `DUSK_DOMAINS_INDEXER_CORS_ORIGIN=https://dusk.domains` in `indexer.env` or pass `--cors-origin https://dusk.domains` to `npm run indexer:local`. Set `DUSK_DOMAINS_INDEXER_HEALTH_URL` for health/monitor commands and `DUSK_DOMAINS_INDEXER_ALERT_WEBHOOK_URL` only for the monitor process. Local development can keep the default wildcard origin; hosted deployments should return the public frontend origin from the Node API even when a reverse proxy also enforces CORS.

Restart order for routine deploys:

1. Stop monitor alerts or put the deployment in maintenance mode.
2. Stop the API.
3. Stop the collector only if changing event source, cursor, deployment env, or archive-node settings.
4. Deploy the new frontend/artifact bundle and verify env fingerprints.
5. Start collector, then rebuild checkpoint, then start API.
6. Run `npm run indexer:health`, `npm run check:indexer-production`, `npm run release:artifacts`, `npm run check:release-artifacts`, and `npm run check:public-beta-readiness`.
7. Re-enable monitor alerts and live writes only after health and public-beta readiness are safe.

Run `npm run launch:evidence` only after the release artifact bundle has been regenerated and verified for the source commit being released. The evidence collector inventories the manifest files already on disk; it does not rebuild release artifacts for the operator. Include `--security-review-report target/security-review-status.json` so the release bundle records the controlled-beta security-review disposition for the same source commit.

## Network Edge And TLS

Run the Node indexer behind a reverse proxy for hosted beta. The proxy owns public TLS, request logging, compression, and security headers; the Node process should focus on deterministic read-model serving.

Recommended edge shape:

```text
internet
  -> HTTPS reverse proxy / load balancer
  -> 127.0.0.1:8787 or private VPC address
  -> dusk-domains-api
```

Operator rules:

- Expose only HTTPS publicly.
- Prefer binding `dusk-domains-api` to `127.0.0.1` when the reverse proxy runs on the same host.
- If binding to `0.0.0.0`, restrict the port with a firewall or private VPC security group.
- Do not expose the Dusk archive/full node endpoint directly to browsers.
- Do not expose `.env` files, backup directories, event journals, cursor files, checkpoint files, SQLite files, or data-driver build directories from the web root.
- Keep `/health` public enough for uptime monitoring, but never include secrets, mnemonics, private RPC credentials, or wallet material in health output.
- Use `Cache-Control` from the API for read routes. Do not add proxy caches that outlive the response TTL.
- Forward the original host/protocol headers if the hosting provider requires them for logs, but do not trust them as protocol state.
- Set a specific CORS origin on the Node API with `DUSK_DOMAINS_INDEXER_CORS_ORIGIN` or `--cors-origin`, then mirror or narrow that policy at the reverse proxy.

Minimal proxy headers:

```text
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: geolocation=(), microphone=(), camera=()
```

Before routing public traffic, run:

```text
npm run indexer:health -- \
  --health-url https://indexer.example/health \
  --max-lag-blocks 12 \
  --max-source-age-minutes 10 \
  --min-events 1

npm run check:public-beta-readiness
```

Backup:

```text
npm run indexer:backup -- \
  --output-dir /var/backups/dusk-domains \
  --event-log /var/lib/dusk-domains/events.jsonl \
  --cursor /var/lib/dusk-domains/cursor.json \
  --checkpoint /var/lib/dusk-domains/checkpoint.json \
  --sqlite /var/lib/dusk-domains/indexer.sqlite \
  --env-file .env.production.local \
  --deployment-proof /var/lib/dusk-domains/deployment-proof.json \
  --browser-write-proof /var/lib/dusk-domains/browser-write-proof.json
```

`--sqlite` copies the SQLite database and any matching `indexer.sqlite-wal` / `indexer.sqlite-shm` sidecars that exist at backup time. Store the checksummed backup directory with the archive-node snapshot taken shortly before deployment.

Verify and stage a restore copy before relying on a backup during recovery:

```text
npm run indexer:backup -- \
  --verify \
  --manifest /var/backups/dusk-domains/<backup-id>/manifest.json \
  --restore-dir /var/tmp/dusk-domains-restore
```

Only move staged files into `/var/lib/dusk-domains` after checksum verification passes and the collector/API are stopped.

### Restore Cutover Drill

Use this drill before the first public beta window and after every backup-tooling change. It proves the backup can become the live indexer state without inventing manual recovery steps during an incident.

1. Put the hosted app in read-only/degraded mode if the drill touches live infrastructure:
   `VITE_DUSK_DOMAINS_ENABLE_LIVE_WRITES=false`.
2. Stop the collector and API through the process supervisor. The exact command is host-specific, but both processes must be fully stopped before replacing files.
3. Verify the selected backup and stage it into an empty directory:

   ```text
   npm run indexer:backup -- \
     --verify \
     --require-sqlite \
     --manifest /var/backups/dusk-domains/<backup-id>/manifest.json \
     --restore-dir /var/tmp/dusk-domains-restore
   ```

4. Record the manifest checksum, restored event count, restored cursor, restored checkpoint, and restored SQLite/WAL file paths in the incident or launch evidence.
5. Move the staged event journal, cursor, checkpoint, SQLite database, and any `-wal` / `-shm` sidecars into `/var/lib/dusk-domains`.
6. Start the API against the restored files in strict-health mode:

   ```text
   npm run indexer:local -- \
     --sqlite /var/lib/dusk-domains/indexer.sqlite \
     --event-log /var/lib/dusk-domains/events.jsonl \
     --cursor /var/lib/dusk-domains/cursor.json \
     --checkpoint /var/lib/dusk-domains/checkpoint.json \
     --strict-health \
     --host 0.0.0.0 \
     --port 8787
   ```

7. Probe `/health` and run the production gate before reconnecting write-confirmation paths:

   ```text
   npm run indexer:health -- \
     --health-url https://indexer.example/health \
     --max-lag-blocks 12 \
     --max-source-age-minutes 10 \
     --min-events 1

   npm run check:indexer-production -- \
     --sqlite /var/lib/dusk-domains/indexer.sqlite \
     --require-sqlite \
     --require-archive-snapshot \
     --require-backup \
     --require-sqlite-backup \
     --derive-deployment-start-height \
     --archive-snapshot-height <snapshot-height> \
     --archive-snapshot /var/snapshots/dusk-archive-before-launch \
     --backup-manifest /var/backups/dusk-domains/<backup-id>/manifest.json \
     --backup-restore-dir /var/tmp/dusk-domains-restore \
     --max-source-age-minutes 10
   ```

8. Restart the collector only after the restored cursor and checkpoint are accepted by health checks.
9. Re-enable live writes only after the app, indexer, and support/status links all point at the restored deployment evidence.

Public beta readiness should also verify that the current production indexer bundle can be restored:

```text
npm run check:indexer-production -- \
  --sqlite /var/lib/dusk-domains/indexer.sqlite \
  --require-sqlite \
  --require-archive-snapshot \
  --require-backup \
  --require-sqlite-backup \
  --derive-deployment-start-height \
  --archive-snapshot-height <snapshot-height> \
  --archive-snapshot /var/snapshots/dusk-archive-before-launch \
  --backup-manifest /var/backups/dusk-domains/<backup-id>/manifest.json \
  --backup-restore-dir /var/tmp/dusk-domains-restore \
  --max-source-age-minutes 10
```

## Monitoring Policy

Page the operator when:

- `/health.ok` is not `true`.
- `lagBlocks` is unknown or greater than the launch threshold.
- The latest cursor/checkpoint source timestamp is older than the configured source-age threshold.
- `npm run indexer:health` fails deployment-start or archive-snapshot validation.
- `npm run indexer:monitor -- --require-alert-webhook` fails or cannot deliver to `DUSK_DOMAINS_INDEXER_ALERT_WEBHOOK_URL`.
- `eventCount` unexpectedly decreases.
- `schemaVersion` changes without a planned deploy.
- Required routes disappear from `/health.routes`.
- The checkpoint no longer matches the event journal.
- The collector cursor stops advancing while the chain height advances.

Public write flows should not show final indexed success while health is unsafe. The UI can show submitted transaction state, but it should wait for healthy indexed confirmation before showing final ownership, record, primary, treasury, or referral success.

## Treasury Policy

Beta treasury policy:

- Fees are stored in the treasury contract.
- The configured operator principal can claim.
- The configured Moonlight recipient receives claimed funds.
- There is no MVP fee split, burn, DAO treasury, marketplace royalty, arbitrary payout destination, or user-controlled treasury routing.
- Operator proceeds are intended for protocol-owned liquidity.

Before claiming:

1. Confirm the connected wallet matches the operator principal shown in the UI.
2. Confirm the recipient Moonlight address.
3. Confirm available amount against indexed treasury state.
4. Submit claim.
5. Preserve transaction ID, amount, recipient, remaining balance, and indexed event.

Non-operator wallets must remain read-only.

## Referral Policy

Beta referral policy:

- A referral is supplied by URL or manual input before registration.
- The buyer pays the normal registration fee; referrals do not add buyer cost.
- Referral rewards accrue in treasury/referral accounting and are claimable by the referrer.
- Self-referrals are not blocked in the current policy.
- Referral basis points are operator-configurable within contract bounds.

Before enabling referrals publicly, verify:

```text
npm run check:browser-referrals
npm run check:browser-referral-rewards
npm run check:browser-referral-rewards-unauthorized-claim
```

For devnet or production write proof, also run installed-wallet claim coverage when rewards are enabled.

## Recovery Procedures

### Indexer Lag Or Unsafe Health

1. Remove the indexer from write-confirmation paths.
2. Keep read-only routes online only if the UI clearly shows pending/degraded state.
3. Inspect `/health`, cursor, checkpoint, and collector logs.
4. Rebuild checkpoint from the event journal.
5. Verify and stage the latest backup if the journal or cursor is corrupt:
   `npm run indexer:backup -- --verify --manifest /var/backups/dusk-domains/<backup-id>/manifest.json --restore-dir /var/tmp/dusk-domains-restore`.
6. Move staged files into the data directory only after verification passes.
7. Rerun `npm run check:indexer-production`.
8. Return service only after health is safe.

### Lost Or Corrupt Event Journal

1. Stop collector and API.
2. Verify and stage the most recent backup bundle.
3. Move staged journal, cursor, checkpoint, env, and proof files into the data directory.
4. Replay from the archive-node snapshot or deployment height once historical event extraction is available.
5. Rebuild checkpoint.
6. Compare event count and last event against the pre-incident manifest.

### Failed Registration Transaction

1. Preserve the transaction ID.
2. Check the explorer before retrying.
3. If commit succeeded but reveal failed, keep the reservation visible in My Domains until stale.
4. If registration failed before fee acceptance, do not show ownership success.

### Treasury Or Referral Claim Failure

1. Preserve transaction ID and connected principal.
2. Check indexed treasury/referral state before retrying.
3. Do not retry if a claim event already reduced the balance.
4. For suspected unauthorized claim attempts, preserve wallet principal, tx ID, and event/indexer state.

### App Or DNS Outage

1. Publish a short status update with the affected URL, start time, and current read/write recommendation.
2. Disable live writes in the hosted app configuration if users cannot reliably reach the same frontend build and runtime env:
   `VITE_DUSK_DOMAINS_ENABLE_LIVE_WRITES=false`.
3. Keep the indexer/API online when healthy so wallets, explorers, and support can still verify state.
4. Do not ask testers to use an alternate domain unless it points at the same audited build, runtime config, support links, and contract IDs.
5. After recovery, run `npm run check:production-surface -- --require-launch-links` against the hosted env and capture the status update/resolution time.

### Wallet Provider Outage

1. Publish a status update that value-bearing actions are paused.
2. Keep read-only search, domain details, referrals, and treasury accounting available only if indexer health is safe.
3. Do not route users to manual transaction payloads during beta unless a separate operator-approved proof path exists.
4. Preserve screenshots, provider errors, affected wallet version, chain ID, and transaction IDs for support.
5. Re-enable live writes only after wallet connect, locked-wallet recovery, reservation, purchase, record save, primary-domain, referral claim, and treasury claim smoke paths pass.

### Rollback And Mitigation

1. Treat contract state as canonical; the web app cannot roll back a completed contract transaction.
2. Roll back web/app changes by redeploying the previous known-good frontend build and env handoff.
3. Roll back indexer state by stopping collector/API, verifying a backup, staging restore files, and replaying the event journal before serving.
4. Mitigate unsafe writes by disabling live writes, showing degraded status, and keeping support/security paths visible.
5. Preserve old and new source commits, runtime env fingerprints, proof artifacts, health responses, and status updates in the incident record.

## Known Public Beta Limitations

- Indexer state is a read model; contract state remains canonical.
- SQLite/WAL event storage exists; normalized projection tables and archive-node historical extraction are still future hardening items.
- Unicode names, private records, organization verification and Citadel integration are out of the core MVP scope. Marketplace auctions are an optional third-contract extension.
- The app supports public Moonlight primary names; Phoenix endpoints are not public primary identities.
- External audit is not part of the devnet MVP proof package.
