# Production Runbook

Status: private beta operator guide

This service is the Dusk Domains read API. It is not the archive node and it does not hold wallet mnemonics. Its job is to serve read models from a Dusk Domains event journal, with SQLite/WAL as the durable local store.

## Runtime Boundary

- Source of truth: DuskDS contracts.
- Event source: decoded Dusk Domains event journal from the archive-node or collector process.
- Read store: SQLite/WAL plus cursor and checkpoint files.
- API: `/health`, `/search`, `/resolve`, `/name`, `/records`, `/record`, `/record-history`, `/names`, `/activity`, `/reverse`, `/subnames`, `/subname`, `/treasury`, `/referrals`, `/fee-config`.
- Shared schema: `@hdauven/dusk-domains-sdk/event-catalog`.

The indexer can be rebuilt from the event journal and the archive-node snapshot that covers the deployment start height.

`/health` must be treated as the SDK/indexer handshake. It exposes the indexer package version, pinned SDK dependency, API version, event schema version, read-model schema version, SQLite schema version, and the deployment binding derived from indexed event metadata.

## Server Layout

Recommended paths:

```text
/opt/dusk-domains-indexer          repository checkout
/etc/dusk-domains/indexer.env      runtime environment
/var/lib/dusk-domains              SQLite, event journal, cursor, checkpoint, deployment proof
/var/backups/dusk-domains          checksummed indexer backups
```

Create the service account and directories:

```bash
sudo useradd --system --home /var/lib/dusk-domains --shell /usr/sbin/nologin dusk-domains
sudo mkdir -p /opt/dusk-domains-indexer /etc/dusk-domains /var/lib/dusk-domains /var/backups/dusk-domains
sudo chown -R dusk-domains:dusk-domains /var/lib/dusk-domains /var/backups/dusk-domains
```

## Install

Install Node 24, clone the repo, then install dependencies from the pinned lockfile:

```bash
cd /opt/dusk-domains-indexer
npm ci
```

The current package depends on a private SDK GitHub repo. Use an SSH deploy key or an authenticated GitHub environment for `npm ci`.

Copy the environment template and edit values:

```bash
sudo cp .env.example /etc/dusk-domains/indexer.env
sudo editor /etc/dusk-domains/indexer.env
```

Install the systemd unit:

```bash
sudo cp deploy/systemd/dusk-domains-indexer.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dusk-domains-indexer
```

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

Private GitHub dependencies require BuildKit SSH forwarding:

```bash
DOCKER_BUILDKIT=1 docker build --ssh default -t dusk-domains-indexer .
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

Production gate:

```bash
npm run production:check -- \
  --event-log /var/lib/dusk-domains/events.jsonl \
  --cursor /var/lib/dusk-domains/cursor.json \
  --checkpoint /var/lib/dusk-domains/checkpoint.json \
  --sqlite /var/lib/dusk-domains/indexer.sqlite \
  --require-sqlite \
  --require-backup \
  --backup-manifest /var/backups/dusk-domains/latest/manifest.json \
  --backup-restore-dir /tmp/dusk-domains-indexer-restore
```

## Backup

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
