# Moving a host from the live collector to the archive collector

This is the one-time move for a host whose `/health` shows `cursor.source: "w3sper-live-subscription"`, as dusk.domains/api did in September 2026. The legacy journal's dates were anchored wrongly (a record from block 4,414,447 reports `updatedAt: 2028-02-17`), and its events lack identities needed to deduplicate against archive events. So the archive collector replays from the deployment height into **new files**, the API switches over, and the old files are kept untouched until the new ones are checked.

Nothing here edits the legacy journal, cursor or database.

## 0. Before you start

- The host runs a release with block-height lifecycle checks and the collector unit (`deploy/systemd/dusk-domains-collector.service`).
- You know the **deployment start height**: the block of the first contract deployment, or any height before it. The deploy output or the launch checklist records it. The legacy journal cannot provide it, because its events carry no heights (`/health` shows `deploymentStartHeight: 0`). If it is unknown, start well before the earliest height you can bound it by. An earlier start only costs replay time.
- The runtime env file (`DUSK_DOMAINS_DEPLOYMENT_ENV_FILE`) has the contract IDs and a `VITE_DUSK_DOMAINS_NODE_URL` for an **archive** node that serves `lastBlockPair`, `blocks` and `contractEventBatch`.
- The data-driver WASM for the deployed contracts is in one directory: `dusk-domains-core.data-driver.wasm`, `dusk-domains-treasury.data-driver.wasm` and, if the marketplace is configured, `dusk-domains-marketplace.data-driver.wasm`. The frontend ships them under `public/contracts/deployments/<id>/`. Use the deployment whose contract IDs match the env file.

Record what is live now:

```bash
curl -s https://dusk.domains/api/health | jq '{source: .cursor.source, events: .eventCount, names, currentBlockHeight, sqlite: .sqlite.dbFile, durability: .durability.eventLogFile}'
```

## 1. Prepare new paths

```bash
sudo -u dusk-domains mkdir -p /var/lib/dusk-domains/archive /var/lib/dusk-domains/contracts
sudo cp <frontend>/public/contracts/deployments/<id>/*.data-driver.wasm /var/lib/dusk-domains/contracts/
sudo chown dusk-domains:dusk-domains /var/lib/dusk-domains/contracts/*
```

Point `/etc/dusk-domains/indexer.env` at the new files. Keep the old values in a comment so the change can be undone:

```bash
DUSK_DOMAINS_INDEXER_EVENT_LOG=/var/lib/dusk-domains/archive/events.jsonl
DUSK_DOMAINS_INDEXER_CURSOR=/var/lib/dusk-domains/archive/cursor.json
DUSK_DOMAINS_INDEXER_SQLITE=/var/lib/dusk-domains/archive/indexer.sqlite
DUSK_DOMAINS_COLLECTOR_DRIVER_DIR=/var/lib/dusk-domains/contracts
DUSK_DOMAINS_DEPLOYMENT_START_HEIGHT=<height>
```

## 2. Replay

Stop the legacy collector, whatever runs it today, and leave the API serving the old files. Then start the archive collector:

```bash
sudo cp deploy/systemd/dusk-domains-collector.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dusk-domains-collector
journalctl -u dusk-domains-collector -f
```

Catch-up is done when the new cursor's `scannedBlockHeight` reaches the chain tip:

```bash
jq '{source, status, scannedBlockHeight, currentBlockHeight, eventCount}' /var/lib/dusk-domains/archive/cursor.json
```

`source` must read `rusk-finalized-archive`. The event count should be at least the legacy count from step 0. The legacy count includes events the archive may split or deduplicate differently, so compare names and records in step 4, not just counts.

## 3. Switch the API

```bash
sudo cp deploy/systemd/dusk-domains-indexer.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl restart dusk-domains-indexer
curl -s http://127.0.0.1:8787/health | jq '{ok, source: .cursor.source, events: .eventCount, names, lagBlocks, finalizedBlockHeight, sourceCommit: .package.sourceCommit}'
```

Expect `ok: true`, `source: rusk-finalized-archive`, a small `lagBlocks`, a non-null `finalizedBlockHeight` and the deployed commit.

## 4. Spot-check dates against the chain

For a few names, compare what the API says with the block the event landed in. Pick a recently registered name, a name with a recent record change, and the oldest name:

```bash
curl -s "http://127.0.0.1:8787/activity?node=<node>" | jq '.[] | {eventType, blockHeight, timestamp}'
curl -s "http://127.0.0.1:8787/name?node=<node>" | jq '{canonicalName, expiresAt, expiresAtBlockHeight, graceEndsAtBlockHeight, status}'
```

- An activity `timestamp` should match its block's timestamp on the explorer to within one block (about 10 seconds). Nothing should be dated in the future.
- `expiresAtBlockHeight` minus the registration block should be the registered term in blocks (about 3,153,600 per year). `expiresAt` should sit that far after the registration date.
- `/search?query=<name>` should report `registered` for every name whose `graceEndsAtBlockHeight` is above the current height, and `available` otherwise.

Compare the name list with the legacy API's before retiring it:

```bash
curl -s https://dusk.domains/api/names | jq -r '.[].canonicalName' | sort > /tmp/legacy-names
curl -s http://127.0.0.1:8787/names | jq -r '.[].canonicalName' | sort > /tmp/archive-names
diff /tmp/legacy-names /tmp/archive-names
```

A name missing from the archive side means the start height was too late or a contract ID is wrong. Stop and check before going further.

## 5. Undo

Restore the old paths in `indexer.env`, restart `dusk-domains-indexer`, and restart the legacy collector. The legacy files were never modified.

## 6. Afterwards

Keep the legacy journal, cursor and database with the backups for one release cycle, then delete them. The frontend can be redeployed from `main` once `/marketplace/fixed-sales`, `/marketplace/auctions` and `/marketplace/offers` answer on the new API (HDauven/dusk-domains-protocol#187).
