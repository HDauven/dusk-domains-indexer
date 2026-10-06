# Run mainnet and testnet side by side

Each network has its own collector, API, release directory, env file and data.
The templates run as `duskdomains` with the single-instance units' flags and
hardening. The original units, which run as `dusk-domains`, remain available for
existing installations.

| Instance | Site | API listener | Code | Runtime env | Data |
| --- | --- | --- | --- | --- | --- |
| mainnet | `https://dusk.domains` | `127.0.0.1:8787` | `/opt/dusk-domains-indexer-mainnet` | `/etc/dusk-domains/mainnet.env` | `/var/lib/dusk-domains/mainnet` |
| testnet | `https://testnet.dusk.domains` | `127.0.0.1:8788` | `/opt/dusk-domains-indexer-testnet` | `/etc/dusk-domains/testnet.env` | `/var/lib/dusk-domains/testnet` |

Testnet can run a newer commit before mainnet. Never share a journal, cursor,
SQLite database, checkpoint, deployment evidence or backup directory between
networks. Code rollback preserves all data; it requires a release compatible with
the existing journal and database.

## First-time setup of an instance

1. Install Node 24 or newer, npm, Git, Bash, OpenSSH, curl, util-linux (`flock`),
   systemd and Caddy. The deploy SSH target needs root privileges. On the server,
   create the service account if it does not exist:

   ```sh
   sudo useradd --system --user-group --home-dir /var/lib/dusk-domains --shell /usr/sbin/nologin duskdomains
   ```

   The units run as `duskdomains`, and the deploy script assigns code to
   `duskdomains:duskdomains`.

2. Choose `instance=mainnet` or `instance=testnet` and create its directories:

   ```sh
   instance=testnet
   sudo install -d -m 0750 /etc/dusk-domains
   sudo install -d -o duskdomains -g duskdomains -m 0750 \
     /var/lib/dusk-domains/$instance /var/lib/dusk-domains/$instance/contracts \
     /var/backups/dusk-domains/$instance /var/log/dusk-domains
   sudo install -m 0600 deploy/$instance.env.example /etc/dusk-domains/$instance.env
   ```

   Review every path and fill in `DUSK_DOMAINS_DEPLOYMENT_START_HEIGHT`. Store the
   network's deployment env, deployment proof and matching data-driver WASM in
   the configured locations. The deployment env needs
   `VITE_DUSK_DOMAINS_ROUTER_CONTRACT_ID`, `VITE_DUSK_DOMAINS_CORE_CONTRACT_ID`,
   `VITE_DUSK_DOMAINS_TREASURY_CONTRACT_ID` and, if deployed,
   `VITE_DUSK_DOMAINS_MARKETPLACE_CONTRACT_ID`. Give the service account read access
   to these files and write access to its data and backups. An archive snapshot
   marker/height is optional evidence for the production checks in the
   [production runbook](../docs/production-runbook.md); configure it when used.

   Mainnet uses `https://nodes.dusk.network`; testnet uses the local archive at
   `http://127.0.0.1:8080`. `DUSK_DOMAINS_COLLECTOR_NODE_URL` overrides the node in
   the deployment env; an explicit `--node-url` overrides both. The collector
   queries finalized archive history (`lastBlockPair`, `blocks`, `checkBlock`,
   `contractEvents`) and verifies its cursor's anchor block at startup. It detects
   `contractEventBatch` when available. HTTP 429 and 5xx responses retry the same
   request with exponential delays, honoring `Retry-After`. After six retries,
   startup fails for systemd to restart, or polling records a blocked cursor and
   retries the batch. No failed query advances the journal or cursor.

3. Install the templates, then load them:

   ```sh
   sudo cp deploy/systemd/dusk-domains-collector@.service deploy/systemd/dusk-domains-indexer@.service /etc/systemd/system/
   sudo systemctl daemon-reload
   ```

4. From this Git checkout, deploy a commit using the procedure below. The script
   creates the instance code directory, installs dependencies, updates the source
   commit and starts both services. Enable them for boot on the server:

   ```sh
   sudo systemctl enable dusk-domains-collector@$instance.service dusk-domains-indexer@$instance.service
   ```

   Check both services and `/health` on the configured loopback port. A first
   replay may take longer than the deploy script's health retries; inspect its
   progress and wait for `ok: true` before routing public traffic.

5. Install each frontend's build into its site root and configure it for the same
   network as its indexer. Mainnet uses `/srv/dusk-domains/dist`, testnet uses
   `/srv/dusk-domains-testnet/dist`. Set the site's API to its own `/api` path.
   Install [Caddyfile.example](Caddyfile.example) as the site's Caddy configuration,
   merging any unrelated sites already on the host. Configure DNS for the named
   sites, validate and reload:

   ```sh
   sudo caddy validate --config /etc/caddy/Caddyfile
   sudo systemctl reload caddy
   ```

## Deploy and roll back

Run from a checkout containing the commit to release. `DEPLOY_HOST` is an SSH
configuration alias or target supplied by the operator; it has no repo default.

```sh
export DEPLOY_HOST=your-ssh-target
./deploy/deploy.sh testnet <commit>
./deploy/deploy.sh mainnet <commit>
./deploy/deploy.sh --rollback testnet
```

The script archives the resolved commit into `/opt/dusk-domains-indexer-<instance>-next`
and runs `npm ci` before stopping the instance. It swaps the prepared release into
place and saves the old code as `.prev-<UTC stamp>`. Old releases are pruned to the
three newest only after a healthy start, so failed attempts never remove the last
good one. A per-instance lock prevents overlapping deployments. It sets
`DUSK_DOMAINS_INDEXER_SOURCE_COMMIT` in the instance env, restarts that instance's
collector and API, and checks healthy JSON and the source commit on its own port.

Rollback restores the newest previous directory and its recorded source commit. The
release it replaces is kept as `.failed-<UTC stamp>` and is never selected again, so
each rollback goes one release further back; the three newest are kept. A migrated directory's
commit comes from its existing `DUSK_DOMAINS_INDEXER_SOURCE_COMMIT`; ensure it is a
full commit hash before the first update. Failed dependency installation leaves
the live services alone. An unsuccessful health check exits nonzero and retains
the installed release for inspection; rollback is explicit. A leftover `-next`
directory blocks another deploy: inspect it and move it aside before retrying.

## Migrate the existing single testnet instance

Perform these steps in order before bringing up mainnet on port 8787.

1. Record the current code commit, env, unit account, deployment start height and
   cursor. Back up `/etc/dusk-domains/indexer.env`, the Caddy config and the data in
   `/var/lib/dusk-domains/testnet-2026-10`. Prepare the testnet frontend and DNS.
2. Install the template units as above and run `systemctl daemon-reload`. Copy
   `/etc/dusk-domains/indexer.env` to `/etc/dusk-domains/testnet.env` with its private
   permissions. Set the port to `8788`, health URL to
   `http://127.0.0.1:8788/health`, site URL and CORS to
   `https://testnet.dusk.domains`, `DUSK_DOMAINS_NOINDEX=true`, and collector node URL
   to `http://127.0.0.1:8080`. Keep all existing deployment IDs, driver paths, start
   height, source commit and data paths, including `testnet-2026-10`. Do not replace
   this env wholesale with the example or reset the cursor.
3. Stop and disable the original writers and API:

   ```sh
   sudo systemctl disable --now dusk-domains-indexer.service dusk-domains-collector.service
   sudo mv /opt/dusk-domains-indexer /opt/dusk-domains-indexer-testnet
   ```

   The destination must not already exist. Keep the old env and units for recovery;
   do not run the old collector alongside the template against the same journal.
4. Deploy the instance-aware commit with `./deploy/deploy.sh testnet <commit>`.
   Enable `dusk-domains-collector@testnet.service` and
   `dusk-domains-indexer@testnet.service`. Check health on 8788 and confirm the
   collector resumes its committed cursor. Keep the API private during catch-up.
5. Install the testnet frontend at `/srv/dusk-domains-testnet/dist`. Update Caddy's
   testnet host to that root and `127.0.0.1:8788`, including its noindex header.
   Preserve the preview, AI crawler and root names-sitemap rewrites. Validate and
   reload Caddy. Verify testnet HTML carries noindex, the names sitemap returns 404,
   and a share PNG still loads. Switch the mainnet hosts to 8787 only when mainnet
   passes the following checklist; avoid routing mainnet hosts to the testnet API.
6. Update monitoring, backup jobs and operator shortcuts to the testnet env, port
   and template units. Retire the old env and unit files after verifying the
   migration and retaining their backup.

## Bring up mainnet

1. Record the actual mainnet contract IDs, matching drivers, deployment proof and
   **first deployment block**. Set that block as
   `DUSK_DOMAINS_DEPLOYMENT_START_HEIGHT`, so initialization events are included.
   Do not use today's chain tip or copy testnet's start height.
2. Follow the first-time setup using `mainnet.env.example`: port 8787, mainnet-only
   paths, `DUSK_DOMAINS_SITE_URL=https://dusk.domains`, matching CORS and
   `DUSK_DOMAINS_NOINDEX=false`. Keep the public archive node URL from the example.
3. Deploy the desired commit to mainnet, enable its units and let archive replay
   catch up. Check health, source commit, deployment identity and archive coverage
   against the deployment proof before exposing it.
4. Install the mainnet frontend at `/srv/dusk-domains/dist`. Switch `dusk.domains`
   and `www.dusk.domains` to that root and upstream 8787. `api.dusk.domains` also
   uses 8787. Validate and reload Caddy; verify testnet still uses 8788.
5. Check canonical URLs, preview cards and the names sitemap on mainnet. Configure
   separate monitoring and backups using each instance's env.

## Site origins, previews and indexing

`DUSK_DOMAINS_SITE_URL` defaults to `https://dusk.domains`. Its HTTP(S) origin is
used for share and crawler links, canonical metadata and names-sitemap URLs; its
host is printed in share-card footers. Paths, queries and fragments are discarded.
The incoming Host header does not select the origin.

With `DUSK_DOMAINS_NOINDEX=true`, share and crawler HTML receive both a robots
`noindex` meta tag and `X-Robots-Tag: noindex`; `/sitemap/names.xml` returns 404.
PNG previews still render. The testnet Caddy host adds `noindex, nofollow` across
the static app and proxied responses as well.

The Caddy snippet takes a static root and API upstream. Preview bots on `/name/*`
get `/share/name/*` HTML; AI crawlers get `/page/name/*` HTML. Browsers, Googlebot
and Bingbot receive the SPA. Preserve `Vary: User-Agent` in any upstream cache.
`/sitemap-names.xml` is proxied to the names sitemap at the site root. HTML and
PNG previews have a five-minute public cache lifetime. Images render locally
with bundled Instrument Serif fonts and the site mark, with a bounded LRU cache.

Keep API listeners on loopback. Caddy's forwarding headers give clients separate
rate-limit budgets with `DUSK_DOMAINS_INDEXER_TRUST_PROXY=true`. Leave
`DUSK_DOMAINS_INDEXER_ALLOW_PUBLIC_PROXY_TRUST=false` on this layout. The default
budget is 200 requests per minute, including health and OPTIONS; see
[the API policy](../docs/indexer-api.md) for CORS and rate-limit settings.
