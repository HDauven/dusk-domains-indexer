# Deploy the indexer behind Caddy

Install the collector and API units using the [production runbook](../docs/production-runbook.md).
Copy `.env.example` to `/etc/dusk-domains/indexer.env` and configure the deployment
paths and contract IDs. The API listens on `127.0.0.1:8787`; Caddy is its public entry
point on the same host.

For a hostname you control, the Caddy site uses:

```caddyfile
indexer.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Caddy's `reverse_proxy` supplies the client address in `X-Forwarded-For`. Keep its
default forwarding-header handling. The shipped API unit and environment template
set `DUSK_DOMAINS_INDEXER_TRUST_PROXY=true`; the application limiter uses the last
forwarded address, giving public clients separate IPv4 or IPv6 /64 budgets even
though Caddy connects over one loopback address. Earlier header entries supplied
by a client do not change that budget. Local monitoring without forwarding headers
uses the loopback budget.

Keep the listener private to Caddy and trusted local processes. Startup refuses
proxy trust on a listener outside loopback. For an isolated container or private
network, `DUSK_DOMAINS_INDEXER_ALLOW_PUBLIC_PROXY_TRUST=true` permits another bind
address; restrict ingress to the trusted proxy before using it. The normal
loopback deployment leaves this opt-in false. Additional proxies require their
own forwarding-header configuration; this example assumes Caddy receives public
connections directly.

The application permits 200 requests per client key per minute by default,
including health checks and OPTIONS. Keep any additional Caddy or upstream traffic
limits in place. See [the API policy](../docs/indexer-api.md) for CORS, pagination,
rate-limit variables and `Retry-After` handling. Direct local development keeps
proxy trust disabled unless explicitly configured.

## App and link previews on dusk.domains

When the static app and API share a host, route preview crawlers to the indexer's
share HTML before the SPA fallback. Normal browsers keep `/name/<name>` and receive
`index.html`. The `/api` prefix is stripped before proxying to the API:

```caddyfile
dusk.domains {
    route {
        @namePage path /name/*
        header @namePage {
            +Vary User-Agent
            defer
        }
        @preview {
            path_regexp shareName ^/name/(.+)$
            header_regexp User-Agent (?i)(facebookexternalhit|facebot|twitterbot|slackbot|discordbot|linkedinbot|telegrambot|whatsapp|applebot|embedly|pinterestbot|skypeuripreview|google-inspectiontool)
        }
        rewrite @preview /api/share/name/{re.shareName.1}
        handle_path /api/* {
            reverse_proxy 127.0.0.1:8787
        }
        handle {
            root * /srv/dusk-domains
            try_files {path} /index.html
            file_server
        }
    }
}
```

Use the app's actual static directory for `root`. Preserve `Vary: User-Agent` in
any upstream cache so crawler HTML and the SPA are cached separately. Preview
HTML and PNGs use a five-minute public cache lifetime and the API's normal rate
limit. Canonical URLs use `https://dusk.domains/name/<name>.dusk` without referral
parameters; humans who open share HTML are redirected to that app URL.

The API serves `GET /share/name/<name>` and `GET /share/name/<name>.png` internally
(publicly under `/api`). Active names use their public `text.description` record.
Unknown, expired and invalid names receive the default site HTML preview. Invalid
PNG names return a plain `400` response before rendering; unknown and expired
names receive a generic card. Images are rendered locally with bundled OFL
Instrument Serif fonts and retained in an LRU cache of at most 128 cards or 16 MiB.
