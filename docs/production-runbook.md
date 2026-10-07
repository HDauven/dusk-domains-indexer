# Production Runbook

This service is the Dusk Domains read API. It is not the archive node and it does not hold wallet mnemonics. Its job is to serve read models from a Dusk Domains event journal, with SQLite/WAL as the durable local store.

## Runtime Boundary

- Source of truth: DuskDS contracts.
- Event source: decoded Dusk Domains event journal from the archive-node or collector process.
- Read store: SQLite/WAL plus cursor and checkpoint files.
- API: `/health`, `/search`, `/resolve`, `/name`, `/records`, `/record`, `/record-history`, `/names`, `/activity`, `/reverse`, `/subnames`, `/subname`, `/treasury`, `/referrals`, `/fee-config` and marketplace routes.
- Shared projection/decoder: `@duskdomains/sdk/projection`; topics: `@duskdomains/sdk/event-catalog`.

The indexer can be rebuilt from the event journal and the archive-node snapshot that covers the deployment start height.

`/health` must be treated as the SDK/indexer handshake. It exposes the indexer package version, pinned SDK dependency, API version, event schema version, read-model schema version, SQLite schema version, and the deployment binding derived from indexed event metadata.

## Public HTTP configuration

Set `NODE_ENV=production` (the shipped systemd unit and Docker image do this).
Configure `DUSK_DOMAINS_INDEXER_CORS_ORIGINS=https://dusk.domains`; multiple exact
origins are comma-separated. Empty production allowlists disable cross-origin
browser access and emit a startup warning. The older singular
`DUSK_DOMAINS_INDEXER_CORS_ORIGIN` is still accepted if the plural variable is absent.

The app limiter defaults on in production. `DUSK_DOMAINS_INDEXER_RATE_LIMIT`,
`DUSK_DOMAINS_INDEXER_RATE_LIMIT_MAX` (200), and
`DUSK_DOMAINS_INDEXER_RATE_LIMIT_WINDOW_MS` (60000) configure it. Count monitoring
and OPTIONS traffic in the budget. Clients should wait for `Retry-After` on 429.
Place an additional limit at the reverse proxy, particularly with multiple API
processes. Set `DUSK_DOMAINS_INDEXER_TRUST_PROXY=true` only with a private upstream
and a single proxy that appends the client address to `X-Forwarded-For`; the
indexer uses the last entry. The shipped systemd unit and environment template
enable this setup for Caddy on loopback; see [deployment configuration](../deploy/README.md).
Non-loopback listeners require `DUSK_DOMAINS_INDEXER_ALLOW_PUBLIC_PROXY_TRUST=true`
and network access restricted to the proxy. Otherwise keep proxy trust false.

Update HTTP consumers for the named pagination envelopes before deploying the
server. See [the complete API policy and 24-route inventory](indexer-api.md).
Server failures expose `internal_error` and a request ID; correlate that ID in the
service journal for details. Public health diagnostics redact internal messages
and paths, and page warnings. The local health/replay helpers retain full details.

## Server Layout

For mainnet and testnet on one server, use the [instance templates and migration checklist](../deploy/README.md). The following layout describes the original single-instance units.

Single-instance paths:

```text
/opt/dusk-domains-indexer          repository checkout
/etc/dusk-domains/indexer.env      runtime environment
/var/lib/dusk-domains              SQLite, event journal, cursor, checkpoint, deployment proof
/var/backups/dusk-domains          checksummed indexer backups
```

Create the service account and directories:

```bash
sudo useradd --system --home /var/lib/dusk-domains --shell /usr/sbin/nologin dusk-domains
sudo mkdir -p /opt/dusk-domains-indexer /etc/dusk-domains /var/lib/dusk-domains /var/backups/dusk-domains /var/log/dusk-domains
sudo chown -R dusk-domains:dusk-domains /var/lib/dusk-domains /var/backups/dusk-domains /var/log/dusk-domains
```

## Install

Install Node 24, clone the repo, then install dependencies from the pinned lockfile:

```bash
cd /opt/dusk-domains-indexer
npm ci
```

The SDK is pinned to `npm:@jsr/duskdomains__sdk@0.3.0`. Run `npm ci` with the committed lockfile and `.npmrc` to install the published JSR package.

Replay retains the SDK effect log to build history from exactly the accepted projection effects, including emitters admitted within a receipt. Effects, receipt membership and indexer activity/history accumulate for the process lifetime. Plan memory for retained history; restarting replays it rather than pruning it. History ingestion appends in receipt order; publication copies histories into newest-first order, avoiding repeated shifts for concentrated edits. No full projection snapshot is taken per receipt.

Blocked live rebuilds preserve the prior publication and its finalized clock. After restart there is no retained publication: an incomplete reconstruction returns HTTP 503 on data/share routes while `/health` reports degraded status. Repair and atomically replace the journal before resuming; malformed rows block publication just like rejected receipts. Benchmark broad state with `npm run bench:incremental -- --population 1000 5000 10000` and concentrated record histories with `npm run bench:incremental -- --concentrated 1000 5000 10000`.

Copy the environment template and edit values:

```bash
sudo cp .env.example /etc/dusk-domains/indexer.env
sudo editor /etc/dusk-domains/indexer.env
```

Install the systemd units. The collector writes the journal and cursor; the API reads them:

```bash
sudo cp deploy/systemd/dusk-domains-collector.service deploy/systemd/dusk-domains-indexer.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dusk-domains-collector dusk-domains-indexer
```

The collector needs `DUSK_DOMAINS_DEPLOYMENT_ENV_FILE` pointing at the release bundle's `indexer.env`, and `DUSK_DOMAINS_COLLECTOR_DRIVER_DIR` pointing at its `contracts/` directory. The release file supplies `DUSK_DOMAINS_FROM_BLOCK` and `DUSK_DOMAINS_EVENT_SCHEMA_VERSION=1`. Missing or invalid heights/schema versions and driver hash mismatches refuse startup. The service uses this first block without a command-line override.

## Run Locally

```bash
npm start -- \
  --host 127.0.0.1 \
  --port 8787 \
  --sqlite /var/lib/dusk-domains/indexer.sqlite \
  --event-log /var/lib/dusk-domains/events.jsonl \
  --cursor /var/lib/dusk-domains/cursor.json \
  --checkpoint /var/lib/dusk-domains/checkpoint.json \
  --strict-health \
  --watch \
  --cors-origin https://dusk.domains
```

Use a 5-10 second collector cadence for public beta unless node load or finality observations say otherwise.

## Docker

The Dockerfile installs locked dependencies and serves SQLite from `/data`:

```bash
docker build -t dusk-domains-indexer .
docker run --rm -p 8787:8787 -v /var/lib/dusk-domains:/data dusk-domains-indexer
```

## Health

Basic health:

```bash
npm run health -- \
  --health-url http://127.0.0.1:8787/health \
  --max-lag-blocks 12 \
  --max-source-age-minutes 10
```

Production gate (replace `<backup-id>` with the bundle selected below). The
checker needs explicit deployment paths; it does not read `indexer.env` itself.
`--rebuild` refreshes the JSON checkpoint from the journal already served by SQLite:

```bash
sudo -u dusk-domains npm run production:check -- --rebuild \
  --env-file /var/lib/dusk-domains/.env.testnet.local \
  --proof-report /var/lib/dusk-domains/deployment-proof.json \
  --event-log /var/lib/dusk-domains/events.jsonl \
  --cursor /var/lib/dusk-domains/cursor.json \
  --checkpoint /var/lib/dusk-domains/checkpoint.json \
  --sqlite /var/lib/dusk-domains/indexer.sqlite \
  --require-sqlite \
  --require-backup \
  --backup-manifest /var/backups/dusk-domains/<backup-id>/manifest.json \
  --backup-restore-dir /tmp/dusk-domains-indexer-restore
```

## Backup

Stop the API and collector, or take a coherent filesystem snapshot, before copying
the journal, cursor, checkpoint and SQLite database/WAL sidecars. The backup command
copies files; it does not quiesce running writers. Keep deployment env/proof and
archive-retention evidence with the bundle. Do not serve these files from the web root.

Create a checksummed backup:

```bash
npm run backup -- \
  --output-dir /var/backups/dusk-domains \
  --event-log /var/lib/dusk-domains/events.jsonl \
  --cursor /var/lib/dusk-domains/cursor.json \
  --checkpoint /var/lib/dusk-domains/checkpoint.json \
  --sqlite /var/lib/dusk-domains/indexer.sqlite \
  --env-file /var/lib/dusk-domains/.env.testnet.local \
  --deployment-proof /var/lib/dusk-domains/deployment-proof.json
```

Verify and stage restore:

```bash
npm run backup -- \
  --verify \
  --require-sqlite \
  --verify-sqlite-boot \
  --manifest /var/backups/dusk-domains/<backup-id>/manifest.json \
  --restore-dir /tmp/dusk-domains-indexer-restore
```

## Upgrade

1. Pin the desired SDK and indexer commits.
2. Run `npm ci`.
3. Run `npm test`.
4. Run `npm run production:check` against a copy of the current event journal.
5. Verify a staged backup with `--verify-sqlite-boot`.
6. Restart the service.
7. Confirm `/health` reports `ok: true` and that SDK compatibility checks report `compatible`.

## Incident Checklist

- If `/health` is unsafe, remove the API from write-confirmation paths.
- Check collector freshness, cursor, checkpoint and archive node sync.
- Verify disk budget with `npm run disk`.
- Rebuild SQLite from the event journal if the database is corrupt.
- Restore from the latest verified backup only if replay from the event journal is not viable.

## Monitoring and disk

```sh
npm run monitor -- --health-url http://127.0.0.1:8787/health --max-lag-blocks 12 --max-source-age-minutes 10 --interval-ms 60000 --iterations 1
npm run disk -- --live-dir /var/lib/dusk-domains --backup-dir /var/backups/dusk-domains
```

Run monitoring from the host supervisor/scheduler. The monitor exits nonzero for
unsafe health. `DUSK_DOMAINS_INDEXER_ALERT_WEBHOOK_URL` and `--require-alert-webhook`
configure its optional alert delivery. Missing routes, lag, stale cursor/checkpoint,
replay warnings and deployment conflicts invalidate indexed confirmation.
The disk command's default warning threshold is 70%; retain verified backups off-host
and preserve the journal/archive coverage needed to rebuild.

## Restore or rebuild

1. Stop the collector and API before replacing their inputs. Preserve the current files.
2. Verify the selected backup into an empty staging directory using the command above.
   Include `--require-sqlite --verify-sqlite-boot` for a SQLite restore check.
3. Move the verified journal, cursor, checkpoint and matching SQLite/WAL sidecars
   into the configured data paths. Restart the collector with the same start height.
4. Start the API, wait for finalized catch-up, and run the health/production checks
   against these exact paths. A quiesced backup can have valid checksums without
   meeting live freshness requirements.
5. Reconnect indexed confirmation only after health is safe. Contract state remains
   authoritative; restoring the indexer cannot undo a contract transaction.

To rebuild a damaged database from a verified journal, use the following procedure.
The paths below match the shipped environment template; substitute your configured
paths throughout. Keep the API out of public traffic until the final health check.
Missing committed journal data requires a verified backup or
[archive replay into new files](archive-migration.md).

1. From the repository root, stop both managed services. The API unit wants the
   collector, so starting the API later also starts collection.

   ```sh
   cd /opt/dusk-domains-indexer
   sudo systemctl stop dusk-domains-indexer dusk-domains-collector
   ```

2. Preserve the database and any WAL/SHM sidecars together in a new directory.
   Retain the verified journal and cursor at their configured paths.

   ```sh
   recovery_dir=$(sudo -u dusk-domains mktemp -d /var/lib/dusk-domains/rebuild.XXXXXX)
   for file in /var/lib/dusk-domains/indexer.sqlite /var/lib/dusk-domains/indexer.sqlite-wal /var/lib/dusk-domains/indexer.sqlite-shm; do
     if sudo test -e "$file"; then sudo mv "$file" "$recovery_dir/"; fi
   done
   ```

3. Start a temporary API in terminal A as the service account. `--sqlite` with
   `--event-log` replays the journal into the new database before listening;
   `--watch` applies subsequent journal entries when requests arrive. Leave it
   running in the foreground. SQLite stores its checkpoint inside the database.

   ```sh
   sudo -u dusk-domains node server/local-indexer.mjs \
     --sqlite /var/lib/dusk-domains/indexer.sqlite \
     --event-log /var/lib/dusk-domains/events.jsonl \
     --cursor /var/lib/dusk-domains/cursor.json \
     --strict-health --watch --host 127.0.0.1 --port 8788
   ```

4. In terminal B, from the same repository root, start only the managed collector
   with its unchanged deployment start height. Repeat the health command until
   finalized catch-up completes and it passes.

   ```sh
   sudo systemctl start dusk-domains-collector
   npm run health -- --health-url http://127.0.0.1:8788/health --max-lag-blocks 12 --max-source-age-minutes 10
   ```

5. With the managed collector and temporary API still running, verify the rebuilt
   database and deployment evidence from terminal B. `--rebuild` below writes the
   separate JSON replay checkpoint; it does not create SQLite. Run after the health
   request has applied the latest entries. If collection advances during the check,
   repeat the health request and verification. Do not stop the collector for this
   gate: strict health rejects a stopped or stale archive cursor.

   ```sh
   sudo -u dusk-domains npm run production:check -- --rebuild \
     --sqlite /var/lib/dusk-domains/indexer.sqlite --require-sqlite \
     --event-log /var/lib/dusk-domains/events.jsonl \
     --cursor /var/lib/dusk-domains/cursor.json \
     --checkpoint /var/lib/dusk-domains/checkpoint.json \
     --env-file /var/lib/dusk-domains/.env.testnet.local \
     --proof-report /var/lib/dusk-domains/deployment-proof.json
   ```

6. Once verification passes, stop the temporary API with Ctrl-C in terminal A and
   wait for its command to exit. Leave the managed collector running. Start the
   managed API, which resumes SQLite replay with that same collector. Repeat health
   checks until safe before restoring public traffic. Create and verify a new
   coherent backup using the backup procedure above.

   ```sh
   sudo systemctl start dusk-domains-indexer
   npm run health -- --health-url http://127.0.0.1:8787/health --max-lag-blocks 12 --max-source-age-minutes 10
   ```

The production checker also accepts `--require-archive-snapshot`,
`--deployment-start-height`, `--archive-snapshot-height`, `--archive-snapshot`,
`--require-sqlite-backup` and `--backup-restore-dir` to check retained evidence.
These checks depend on the supplied artifacts; a successful head probe alone
cannot prove archive retention back to deployment.
