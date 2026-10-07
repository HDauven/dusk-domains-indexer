# Replaying a legacy journal from the archive

Legacy live/proof journals lack stable archive event identities and cannot be
appended to the finalized archive journal safely. This procedure preserves the
old inputs and replays into new journal, cursor and SQLite paths.

1. Record the existing deployment IDs, configured paths and deployment start height.
   Choose the first deployment block or an earlier height; retain that start on restart.
2. Remove the API from public traffic and stop both managed units. The shipped API
   unit wants the collector, so keep both stopped throughout the temporary replay.
   Keep the old journal, cursor and database/sidecars as a coherent backup.

   ```sh
   sudo systemctl stop dusk-domains-indexer dusk-domains-collector
   ```
3. Copy the frozen deployment's complete `indexer.env`, `manifest.json` and
   `contracts/` into the release directory. The six role IDs and immutable driver
   names must match that release. Directory admissions extend collection later.
4. Select unused paths under `/var/lib/dusk-domains`, which the shipped units can
   write. Ensure the service account can read the deployment env and drivers.
   From the indexer repository root in terminal A, start the replay collector as
   that account and leave it running in the foreground:

   ```sh
   sudo -u dusk-domains mkdir /var/lib/dusk-domains/archive
   sudo -u dusk-domains npm run indexer:collect -- --env-file /var/lib/dusk-domains/release/indexer.env --public-dir /var/lib/dusk-domains/release/contracts --event-log /var/lib/dusk-domains/archive/events.jsonl --cursor-file /var/lib/dusk-domains/archive/cursor.json
   ```

   Keep `DUSK_DOMAINS_FROM_BLOCK` in the release env at the chosen start height. The archive must retain complete finalized
   events from there. The collector supports `contractEventBatch` or the finalized
   `checkBlock`/`contractEvents` adapter. Missing history fails closed.
5. Once the journal and cursor exist, start a temporary API in terminal B from the
   same repository root. It replays the journal into a new SQLite database:

   ```sh
   sudo -u dusk-domains npm start -- --sqlite /var/lib/dusk-domains/archive/indexer.sqlite --event-log /var/lib/dusk-domains/archive/events.jsonl --cursor /var/lib/dusk-domains/archive/cursor.json --strict-health --watch --host 127.0.0.1 --port 8788
   ```

   Leave that API running. In terminal C, from the same repository root, run:

   ```sh
   npm run health -- --health-url http://127.0.0.1:8788/health --max-lag-blocks 12 --max-source-age-minutes 10
   ```

6. Wait for finalized catch-up. Confirm `cursor.source: rusk-finalized-archive`,
   non-null finalized height, expected deployment binding and `ok: true`. Compare
   canonical records and representative activity dates with chain evidence. Event
   counts can differ after archive deduplication; equality with legacy counts is not
   a correctness criterion.
7. Stop the replay collector with Ctrl-C in terminal A and wait for its command to
   exit. Then stop the temporary API with Ctrl-C in terminal B and wait for it to
   exit. Both temporary processes must be gone before starting either managed
   unit: two collectors can corrupt the journal or race on `cursor.json.tmp`.
   Health is expected to be unsafe while the archive cursor says `stopped`.
8. Edit `/etc/dusk-domains/indexer.env` so `DUSK_DOMAINS_INDEXER_EVENT_LOG`,
   `DUSK_DOMAINS_INDEXER_CURSOR`, `DUSK_DOMAINS_INDEXER_SQLITE` and
   `DUSK_DOMAINS_INDEXER_CHECKPOINT` point to `events.jsonl`, `cursor.json`,
   `indexer.sqlite` and `checkpoint.json` under `/var/lib/dusk-domains/archive`.
   Retain the release env and its `DUSK_DOMAINS_FROM_BLOCK` from step 4,
   and point `DUSK_DOMAINS_COLLECTOR_DRIVER_DIR` at its `contracts/`:

   ```sh
   sudo editor /etc/dusk-domains/indexer.env
   ```

9. Start the managed API. Its `Wants=` starts the managed collector, which resumes
   the new cursor. The API applies any journal entries left at cutover. Repeat
   health checks until safe, then rebuild the separate JSON checkpoint and run the
   production gate against the new paths. Keep both managed services running during
   verification. If collection advances during the check, repeat the health request
   and production check. Restore public traffic only after both pass.
   Keep the original files until the
   [backup/restore procedure](production-runbook.md#backup) has passed.

   ```sh
   sudo systemctl start dusk-domains-indexer
   npm run health -- --health-url http://127.0.0.1:8787/health --max-lag-blocks 12 --max-source-age-minutes 10
   sudo -u dusk-domains npm run production:check -- --rebuild --event-log /var/lib/dusk-domains/archive/events.jsonl --cursor /var/lib/dusk-domains/archive/cursor.json --checkpoint /var/lib/dusk-domains/archive/checkpoint.json --sqlite /var/lib/dusk-domains/archive/indexer.sqlite --require-sqlite --env-file /var/lib/dusk-domains/release/indexer.env --proof-report /var/lib/dusk-domains/deployment-proof.json
   ```

Collection responses are paginated. For comparisons, follow every `nextCursor`
using the same filters; `/names` exposes `names`, and `/activity` exposes `activity`.
Comparing only the first page cannot establish that all names survived replay.
Released reserved names remain reserved; active and grace-held names are registered.

To undo a cutover, stop the new API/collector and restore the old configured paths.
This restores the previous read service, not finalized archive guarantees: legacy
health can remain degraded. See [production recovery](production-runbook.md).

Frozen-layer cutovers always need fresh journal/cursor/SQLite paths, even if the previous collector also used the finalized archive. Copy the complete release hand-off and retain its immutable driver filenames; see [deployment instructions](../deploy/README.md#frozen-deployment-cutover).
