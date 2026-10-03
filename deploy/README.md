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
