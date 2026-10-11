# Dusk Domains indexer API — frozen layer

The frozen deployment requires a **fresh event journal, cursor and SQLite database** replayed from `DUSK_DOMAINS_FROM_BLOCK`. Legacy router/core/treasury journals cannot be mixed with frozen receipts. Health advertises `apiVersion: "v1"`, `eventSchemaVersion: "1"`, `readModelSchemaVersion: 2`.

## Encoding and compatibility

All existing paths below remain available. GET responses are JSON; missing singular objects are `null`. List responses use `{ <field>: [...], nextCursor: string | null }`, `limit` (default 50, maximum 200) and opaque `cursor`. CORS, rate limiting, request IDs and HTTP errors are unchanged.

**Every Lux amount is now a decimal string**, including premium, fees, treasury balances, referral amounts and market prices. Use BigInt for arithmetic. Existing `*BlockHeight`, `ttlSeconds` fields remain numbers when safe and otherwise return decimal strings. New generations, serials, slot epochs, mapping IDs, custody nonces and order IDs are always decimal strings. Never coerce an unsafe value to Number. ISO dates derived from unknown block times are `null`; block heights are authoritative.

IDs and authorities in convenience fields use `0x` + 64 lowercase hex digits. Canonical protocol objects (`nameRef`, `order`, `policy.config`, `renewalSchedule`, activity `data`) retain SDK field names, byte arrays and tagged enums, with **all bigint/u64 values serialized as decimal strings**. Small u8/u16/u32 fields remain numbers. Convert their u64 strings to bigint before SDK `wireValue` validation. Market rows additionally expose `orderJson`, a canonical lossless JSON string: use `wireValue('Order', parseJson(row.orderJson))` for the complete typed order. Frozen resolver values are bytes; display records include `valueBytes` and `encoding` (`utf8`, `base58`, `hex`) alongside existing `key`, `value`, `visibility`, `ttlSeconds`, `updatedAt` and `updatedAtBlockHeight`. Moonlight endpoints display as base58, contract IDs as hex; undecodable UTF-8 is hex. Custom resolver keys remain available. Record selectors use SDK `validateRecordInput` key constraints: valid UTF-8 of 1–64 bytes, preserved exactly without trimming or normalization. URL-encode keys; an explicit empty key returns HTTP 400 on both record routes, while an omitted key leaves record history unfiltered.

## Controllers and consent

`/controllers` returns `{controllers,version,nextCursor}` for current directory
admissions. Each row has `contractId`, numeric `scopes` (MANAGE=1, AUTHORITY=2,
REGISTER_FOR=4, combined with bitwise OR), `suspended`, `admittedAtBlockHeight`
and decimal-string `admissionVersion`. The directory-wide `version` is a decimal
string. Removed suspension tombstones are excluded.

The route supports the standard `limit` and `cursor`, sorted by controller ID.
`admissionVersion` records the controller's latest admission event version.
Consent is supplied by each direct call to the controller; no per-authority
approval state or approval route is exposed. A Moonlight principal must sign a
root call to the controller. A contract principal calls the controller directly.
Suspension prevents controller execution and survives removal/re-admission.

## Names and identity

- `/health`: existing readiness, cursor, checkpoint, deployment, package and pause fields. Deployment roles are `directory`, `policy`, `store`, `vault`, `resolver`, `marketplace`; plural admitted IDs appear in `deployment.contracts[role].contractIds`. `eventCount` counts receipt rows (not individual effects). `lastEvent.eventName` is `frozen_receipt`. `projectionBlockHeight` is the finalized scanned height used for lifecycle and premium reads (retained at the last complete publication after a replay failure, or `null` when cold reconstruction blocks), distinct from the observed live tip. Warnings mark replay degraded; an invalid receipt or malformed journal row retains the last complete publication and blocks further projection.
- `/names?owner=<authority>` → `{names,nextCursor}`: roots held through grace, filtered by current owner/manager. Existing lifecycle, records, primary, namespace and activity-count fields remain.
- `/name?node=<node>` → lifecycle plus premium and `namespace: {descendantCount,heldByOthersCount,subnames,ancestors}`. Stored expired root lifecycle remains inspectable. `/subname?node=<node>` returns an active child; `/subnames?parentNode=<node>` → `{subnames,nextCursor}` returns immediate active children. Stored descendants count toward namespace capacity even when expired. Inherited lifecycle updates come from SDK projection.
- `/search?query=<name>` → existing canonical/display/label/status/price/issues/transactionBlocked/premium fields, plus `policy`, `renewalSchedule`, `estimate: true`. `price` remains a DUSK display number (null when policy configuration is unavailable), never a signing quote. Eligibility and stop flags come from the selected policy/directory; root minimum is 3 at launch, sublabels can have one character. Obtain an SDK store quote before signing.
- `/resolve?name=<canonical>` → existing `{canonicalName,node,records,resolver,expiry,cache,warnings,verificationStatus,errors,nextCursor}` plus `homeShard`, `forwarding`, `generation`, `serial`, `custody`, `moveStatus` and `nameRef` from the routing/incarnation fields below. Reads follow the SDK-projected current home automatically. Expired names are unverified. `/records?node=...` → `{records,nextCursor}` and `/record?node=...&key=...` expose stored raw records, including expired stored names; resolver verification is a separate check.
- `/reverse?type=moonlight_address&value=<base58>` → `{primaryName,name,node}` only for a current incarnation with an active exact forward match. Stale raw mappings are never treated as verified.
- `/commitment?commitment=<hash>&controller=<authority>` → `{commitment,controller,commitmentStore,createdAtBlockHeight}` or null. The controller parameter disambiguates owners; preserve the original commitment store across moves. Expired/consumed commitments disappear.

Name and subname lifecycle objects add:

```text
root, homeShard: hex ID
forwarding: [{source,root,destination,destinationOrdinal,moveId,generation,completedAtBlockHeight}]
generation, serial: decimal strings
nameRef: {key:{root:byte[32],node:byte[32]},incarnation:{generation:string,serial:string}}
slotEpoch: string|null
custody: null | {nonce,generation,serial,custodian,originOwner,originManager}
moveStatus: null | {homeShard,moveId,destination,root,status,locked,lockEndsAtBlockHeight,
  ready,stagedCount,lastProgressAtBlockHeight,lifecycleDeadline,cooldownApplied,cancellationReason,ticket,forward}
moveCooldowns: {rootCancelledAt,rootAvailableAt,initiator,initiatorCancelledAt,initiatorAvailableAt}
referrer: TypedPrincipal|null
```

Move status is `preparing`, `unlocked`, `cancelled` or `forwarded`. Deadline passage unlocks without an event. Cooldown timestamps remain historical after their 8,640-block boundary. Staged rows are excluded until SDK validates a complete `root_imported`/`root_forwarded` receipt; then the whole tree, home shard, resolver slots and surviving primaries switch together. Forward history survives source cleanup and subsequent generations.

**Publication invariant:** a publication is the projection of exactly the journal prefix covered by one committed cursor, evaluated at that cursor's finalized `scannedBlockHeight`. Its clock never decreases while the serving process lives. Data routes serve either a complete publication satisfying this invariant or HTTP 503.

The committed cursor is a JSON object with these **required, explicit** fields. Missing values, `null`, coerced types and values outside these ranges reject the candidate; no cursor field is synthesized from another field or from receipts.

| Field | Wire type and accepted value |
| --- | --- |
| `version` | JSON number, exactly `2` |
| `source` | String, exactly `rusk-finalized-archive` |
| `status` | String: `running`, `catching-up`, `blocked`, or `stopped` |
| `fromBlock` | Safe integer in `[1, Number.MAX_SAFE_INTEGER]` |
| `scannedBlockHeight` | Safe integer in `[0, Number.MAX_SAFE_INTEGER]`, at least `fromBlock - 1`; the sole publication clock |
| `currentBlockHeight` | Safe integer in `[0, Number.MAX_SAFE_INTEGER]`, at least `scannedBlockHeight`; used only for tip/lag diagnostics |
| `scannedBlockHash` | String of exactly 64 lowercase hexadecimal characters, without `0x` |
| `eventLogBytes` | Safe integer in `[0, Number.MAX_SAFE_INTEGER]`; exclusive end of the committed JSONL prefix |
| `eventCount` | Safe integer in `[0, Number.MAX_SAFE_INTEGER]`; number of receipt rows before deduplication |
| `updatedAt` | Canonical UTC ISO timestamp string, round-tripping through `Date.toISOString()` |

Other collector fields are opaque metadata and cannot establish publication coverage or a clock. A valid but stopped/catching-up/blocked or stale cursor can describe a complete publication while health remains degraded. Hash syntax is validated locally; the collector authenticates the hash against the archive.

All serving modes use one guarded candidate boundary, from cursor I/O and schema validation through prefix validation, replay, finalization, view/diagnostic construction and any persistence or stable-input checks. Only that boundary adopts a complete view or caches a successful result. Any exception rejects the whole candidate, including an exception after replay or after finalization. The warning/degraded reason has `code: "publication_candidate_rejected"`, the failing `step`, and the exception type in `error`; internal health diagnostics and request logs also retain the exception message. Public `/health` keeps generic messages and the step/error type, without exposing paths or receipt contents. A failed attempt invalidates the reload cache; incremental quiet heartbeats cannot clear its diagnosis without completing reconstruction.

Journal, incremental SQLite and SQLite reload readers capture the finalized archive cursor **before** reading receipts. The cursor's `eventLogBytes` bounds the JSONL prefix; `eventCount` must match its receipt rows, and every receipt must be at or below the finalized height. Later appended bytes, including an incomplete crash tail or malformed uncommitted row, are ignored until a later cursor covers them. A missing, unreadable or incomplete cursor cannot be replaced with a receipt-derived clock. Public SQLite imports use the same guarded loader and finalization. Imports persist the cursor with their SQLite rows as an untrusted replay cache; database-only reloads accept an external heartbeat only when its committed position/count match that stored prefix.

Incremental validation covers the entire accumulator on every candidate, including receipts applied under a previously rejected cursor. Correcting a receipt count while lowering the candidate height cannot publish receipts above that height. Block-hash chain verification belongs to the archive collector; local prefix validation does not independently authenticate a cursor's hash against the chain.

Each store allows one refresh/reload at a time; concurrent requests wait for or reuse it. Watch reloads accept a cached signature only when the input signatures sampled before and after loading agree. Changed inputs discard the speculative publication and retry. Signatures include file identity and change times (and SQLite WAL when SQLite is the input); a derived SQLite output is not a journal reload input.

A failed reconstruction retains the last complete publication and its clock, including quiet-block progress, through journal replacement, truncation, cursor loss and repairs. A candidate below the retained height is rejected with `publication_clock_regression` and degraded health. A malformed **committed** row or rejected receipt blocks the entire candidate. Repair the journal atomically and publish a matching cursor at a non-regressing finalized height to resume. Health's `cursor` and diagnostic checkpoint describe the attempted reconstruction; `projectionBlockHeight` describes the publication actually served.

Rejected rows of any JSON value kind, including `null`, remain diagnosable without interrupting retained reads. `/health` continues to return its diagnostic response with `ok: false`; a cold store returns HTTP 503 on data routes until repair provides a complete prefix.

Retention lasts only for the provider/process lifetime; there is no durable publication checkpoint. A cold start without a complete committed prefix withholds all prefix data: data, crawler and share routes return HTTP 503 with `error: "incomplete_replay"` and `Cache-Control: no-store`. `/health` remains available with degraded status and `projectionBlockHeight: null`. Complete reconstruction restores serving. Legacy cursorless journals and JSON arrays do not establish finalized coverage; rebuild them with the archive collector into fresh JSONL/cursor/SQLite paths.

## Website verification

`/resolve`, `/name`, `/search`, `/names` summaries, active `/subname` and `/subnames` rows, and fixed-sale/auction rows include a separate `verification` object:

```json
{
  "domain": "harbourline.com",
  "status": "verified",
  "checkedAt": "2026-10-08T12:00:00.000Z",
  "dnssec": true
}
```

`status` is `verified`, `unverified`, `mismatch`, `checking`, or `retry`. Only `verified` warrants a website badge. `domain` is null without an eligible HTTPS website; `checkedAt` is an ISO timestamp or null before a check for the current binding. `dnssec` records the resolver's AD flag and is not required for verification. `retry` means the cached result was evicted; use Check now to try again, rather than treating it as missing proof. This is independent of the existing resolver `verificationStatus` and reverse-primary status. It proves control of a website domain, not a legal organisation's identity or an endorsement.

An active name (including a subname) claims a domain through its own `website` record. Set a TXT record at `_dusk-domains.<website host>` with this exact value, substituting the canonical name and the **current `owner` authority from `/name`**:

```text
dusk-domains-verification=aurora.dusk;owner=0x<64 lowercase hex digits>
```

Matching is case-sensitive and permits no extra fields or whitespace. Quoted DNS TXT chunks within one answer are concatenated; separate TXT answers are never concatenated. Any exact answer verifies; a different `dusk-domains-verification=` value gives `mismatch`; absent TXT, unrelated values, and resolver errors give `unverified`. Subnames use their own owner and website, without inheriting a parent's verification. Marketplace custody uses the indexed owner, not the seller.

Website URLs must use HTTPS and an ASCII DNS hostname (punycode is accepted), with at least two labels, labels no longer than 63 characters, and a full TXT query name no longer than 253 characters. IP literals, user info, explicit ports (including 443), trailing dots, encoded hostnames, whitespace and invalid labels are rejected. Paths, queries and fragments are permitted; changing any part of the website value invalidates the cached binding. DNS TXT aliases are not followed: the TXT answer must name the requested host.

The server checks via `https://1.1.1.1/dns-query`, falling back on resolver failure to `https://dns.google/resolve`. Resolvers cannot be supplied by callers. Requests have a three-second timeout per resolver, reject redirects, and cap answers at 64 KiB. An in-memory cache is bound to the name, current owner, generation/serial, resolver and website record's value. Record timestamps and unrelated activity do not change that binding. Restarting clears it. Verified names are rechecked at `min(max(TXT TTL, 5 minutes), 6 hours)`. A badge remains valid until that recheck completes; removing the TXT proof takes effect within `max(TTL, 5 minutes)` plus one lookup (with the recheck interval capped at six hours), subject to resolver propagation and available lookup capacity. Owner or website changes immediately suppress the cached badge on the next API read, and in-flight results for an old binding are discarded.

The worker scans new and changed bindings on startup and every minute and schedules verified rechecks at their due time. Missing or mismatched proofs wait for Check now or a binding change. Resolver errors immediately remove the badge. If the last successful DNS response for that binding was verified, errors retry after 5, 15, 30 and 60 minutes, then hourly until a successful DNS response; a successful response resets the backoff. A binding that was never verified has no automatic error retries. A successful missing or mismatched response stops automatic retries too.

Lookup concurrency and cached results are bounded. When the result cache fills, it evicts the oldest non-verified entries first, then the oldest verified entries; pending checks are retained. Eviction does not itself schedule another lookup. Lightweight scheduling history is retained for eligible bindings so evicted negative results are not automatically rechecked. HTTP responses containing verification use `Cache-Control: no-store`, including `/resolve`; its `cache` field still describes resolver-record freshness.

`POST /verify?name=<name>` checks immediately and returns `{canonicalName,verification}`. This request has no body or wallet-signing requirement. Names are normalized as on `/resolve`; invalid, missing or duplicate name parameters return 400, unknown names return 404, and a busy per-name lookup is shared. The endpoint allows one accepted request per canonical name per minute and five attempts per client IP per minute, in addition to the existing global limiter. HTTP 429 includes `Retry-After` in seconds. When lookup concurrency or a cache full of pending checks prevents admission, HTTP 503 returns `error: "verification_busy"`; clients should offer to try again, not report missing proof. Existing trusted-proxy and IP grouping rules apply. The existing CORS allowlist is retained, with POST allowed for this endpoint's preflight.

## Activity and records history

`/activity?node=...` → `{activity,nextCursor}`. Frozen activity uses the exact SDK event topic as `eventType`; UI labels must map topics such as `root_registered`, `authorities_changed`, `custody_started`, `root_forwarded`. Rows include stable `id`, `node`, `contractId`, `timestamp`, `blockHeight`, `txId`, `actor` (nullable), and canonical `data`. History survives moves/re-registration. Delegated effects additionally carry
`via` (controller contract ID), canonical `principal` and numeric `scope`.
A `controller_used` activity row appears for each name touched by the same
operation. Attribution is scoped to the emitter, journal occurrence and `op_seq`;
callbacks, direct operations and reverted effects do not inherit it.

`root_ceded` records released-root retirement in the root's activity with canonical
`forward`, `counters` and old `grace_end` in `data`. The root's permanent `forwarding`
list includes the cession. Name and resolution lookups serve the new canonical
store and fresh generation; old descendants, records and primaries are not carried.
Cession and successor registration publish together as one committed receipt.

`/record-history?node=...&key=<optional>` → `{history,nextCursor}`. Resolver snapshot records include the same display/byte fields, `action: "set"`, `resolverId`, `homeShard`, `slotEpoch` and event metadata. Removed snapshot keys and identity clears produce per-key `action: "clear"` rows with `value: null`. Slot/identity transitions also produce rows that use `key: "*"`, `value: null` and their event topic as action. Inspect canonical activity data for complete snapshots and clears.

## Policy, vault and marketplace

- `/fee-config` → `{directory,admissions,threeCharYearLux,fourCharYearLux,fivePlusYearLux,premiumStartLux,policy,renewalSchedule,registrationsPaused}`. `policy` is `{contractId,version,config}` or null; `config` is null if the selected policy initialization is unavailable; `renewalSchedule` is the canonical directory schedule `{version,effective_at,annual_lux,referral_bps}` or null. `directory` is the projected canonical DirectoryConfig, including decimal-string `recipient_version`; `admissions` maps unprefixed contract IDs to canonical Admission objects, including decimal-string `governance_version`. Both counters start at 1. Each store's two governance flags share one version; recipient version also advances on operator acceptance, even with the same recipient. Missing policy prices are null. Launch registration is 150/50/10 DUSK for 3/4/5+ characters, with 3-character roots; renewal uses the complete five-entry table independently. Premium/referral rates follow published policy.
- `/treasury` now reports the vault: `{initialized,source:"vault",protocolAccruedLux,referralLiabilityLux,protocolLux,liabilityLux,accountedLux,reservedBeneficiaries,sourceVersion,actualLux:null,surplusLux:null,operator,sources,events}`. `protocolAccruedLux` and `availableLux` alias the current claimable protocol balance. `operator` remains a TypedPrincipal; `operatorRecipient` is base58 and `operatorAuthority` is hex. The response retains `allowedFeeSources`, `totalReceivedLux`, `registrationReceivedLux`, `renewalReceivedLux`, `otherReceivedLux` (marketplace fees), `premiumReceivedLux`, `premiumAccountingError`, `referralClaimableLux`, `referralClaimedLux`, `referralCount`, `lastFeeSourceContract`, `lastFeeReason`, `lastFeeNode`, `lastEventType` and `claims`. Lifetime received totals sum vault receipts; the premium subtotal sums root-registration premium fields and is never added again to vault balances. `claims` has at most 12 protocol claims, with `amountLux` and `remainingLux`; `events` has the latest 12 vault receipt/claim effects. Only vault receipts/claims drive money. Actual balance and unsolicited surplus cannot be reconstructed from domain events and are explicitly unknown.
- `/referrals?referrer=<key>` → `{supported,referrer,beneficiary,claimableLux,claimedLux,accruedLux,events}`. Key is `Moonlight:<192 hex>` or `Contract:<64 hex>` (no `0x`); Moonlight base58 and `0x` contract aliases also work. Absent rows have zero amounts and no beneficiary. `accruedLux = claimableLux + claimedLux`. `referralCount` counts attributed registrations across generations; `recentActivity` retains the last 12 accrual/claim effects with `amountLux` and canonical `counterparty` (payer or null). `events` is also capped at 12.
- `/marketplace/config` → `{initialized,marketplaceContractId,tradingPaused,feeBps,orderApiVersion:1,config,markets}`. `config` and `markets` retain canonical SDK objects. Launch fee is 250 bps (2.5%).
- `/marketplace/fixed-sales` → `{fixedSales,nextCursor}`; `/marketplace/fixed-sale?node=...` → order|null.
- `/marketplace/auctions` → `{auctions,nextCursor}`; `/marketplace/auction?node=...` → order|null.
- `/marketplace/offers?node=<optional>&buyerAuthority=<optional>` → `{offers,nextCursor}`; `/marketplace/offer?node=...&buyerAuthority=...` → order|null.
- `/marketplace/refund?authority=...` → `{marketplaceContractId,authority,amountLux}` or null.

All order/refund paths accept optional `marketplace=<contract ID>` to read admitted older markets during wind-down. Default is the directory's preferred market; if there is none, defaults return empty lists/null and an uninitialized config. All list routes retain separate order IDs, including older return-pending orders for the same node. Singular order routes accept `orderId=<u64 decimal>` in addition to their existing node/buyer parameters; without it they select the latest indexed order for that node/buyer. List ordering is node then numeric order ID (offers: node, buyer, numeric order ID), so pagination cannot skip equal-node orders. Restart pagination after this schema upgrade. Order rows retain node/name, seller/buyer, fee, price/reserve/amount, duration/deadline/start/end/bid fields; add `orderId`, `homeShard`, `generation`, `serial`, `custodyNonce`, `kind` (`Fixed`,`Auction`,`Offer`), `status` (`Open`,`ReturnPending`) and **`order` containing the complete canonical SDK Order**. `saleId` and `auctionId` alias `orderId`. `highestBid` is now canonical `Bid|null`. Use `wireValue('Order', parseJson(row.orderJson))` and fresh SDK reads for writes. Listing identity is marketplace + order ID + home + incarnation + custody nonce; owner equality alone no longer proves escrow. Cancelled/expired return-pending custody remains visible until returned. Closed sold orders disappear while activity stays.

## Public pages

Existing `/share/name/<name>`, `/share/name/<name>.png`, crawler `/page/name/<name>`, `/sitemap/names.xml`, and IndexNow verification routes keep their current HTML/image/XML contracts and network-specific origin/noindex settings. Sitemaps list active names and subnames from the same projected state. IndexNow observes receipt-driven name changes.

A replacement immutable policy normally initializes before admission. SDK 0.3.0
does not expose authenticated historical-initialization ingestion after admission.
Until that API is available, a newly selected policy without an indexed initialization
returns `policy: {contractId,version,config:null}`, null registration prices and
`registrationsPaused: true`; the selected policy ID/version and renewal table remain available.
The frontend must obtain a fresh SDK quote. New stores/resolvers continue to project
from their admissions; retired emitters continue to serve history and claims.

## Pagination and public HTTP policy

All collection requests accept `limit` (default **50**, maximum **200**) and an
opaque `cursor`. `limit` must be a positive decimal integer; values above 200
are clamped. Empty, negative, fractional, nonnumeric, or repeated limits return
400 `invalid_limit`. Malformed, oversized, repeated, or mismatched cursors return
400 `invalid_cursor` before the store is read.

```text
GET /names?owner=0x...&limit=50
GET /names?owner=0x...&limit=50&cursor=<nextCursor from the previous response>
```

```json
{ "names": [], "nextCursor": null }
```

Pass cursors back verbatim (URL-encoded) with the same route and filters. The page
size may change. A non-null `nextCursor` means another page exists; `null` is the
last page, including an empty result. Cursors encode the last sort key and query
scope, never an offset. Inserting or deleting earlier rows does not shift later
pages. These are live reads, not a frozen snapshot: rows inserted before the
cursor are seen on a fresh traversal, and ownership, expiry, or order changes may
remove rows between requests. Cursors are versioned continuation tokens, not
credentials or encrypted data.


### Rate limiting and proxy trust

The app uses a fixed window per IPv4 address or IPv6 /64 prefix, before loading
the store. Defaults:

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `NODE_ENV` | development behavior unless `production` | Production turns on limits and closes empty CORS configuration. |
| `DUSK_DOMAINS_INDEXER_RATE_LIMIT` | `true` in production; `false` otherwise | Enable/disable the app limiter (`true`/`false` or `1`/`0`). |
| `DUSK_DOMAINS_INDEXER_RATE_LIMIT_MAX` | `200` | Requests per IPv4 address or IPv6 /64 per window; positive integer. |
| `DUSK_DOMAINS_INDEXER_RATE_LIMIT_WINDOW_MS` | `60000` | Window duration in milliseconds; positive integer. |
| `DUSK_DOMAINS_INDEXER_TRUST_PROXY` | `false` | Use the last `X-Forwarded-For` address, the one the proxy appended, when valid instead of the socket peer. |
| `DUSK_DOMAINS_INDEXER_ALLOW_PUBLIC_PROXY_TRUST` | `false` | Explicitly permit proxy trust on a listener outside loopback; requires network isolation from direct clients. |
| `DUSK_DOMAINS_INDEXER_CORS_ORIGINS` | `*` in development; empty in production | Comma-separated exact browser origins. |

All requests, including health checks and preflights, count. Exhaustion returns
HTTP 429, `{ "error": "rate_limited", "message": "Too many requests." }`, and
`Retry-After` in seconds. Expired budgets are pruned before admitting a new client.
At most 100,000 active client keys are retained; new clients receive 429 while
that table is full. Budgets are
process-local and reset on restart. Add a reverse-proxy/global limit in front of
multiple instances. The shipped systemd unit and `.env.example` enable proxy trust
for Caddy forwarding to `127.0.0.1:8787`. Caddy appends the public client's address,
giving each client its own application budget; local health probes use the
loopback socket budget. With trust on, the indexer reads the last
`X-Forwarded-For` entry, which that proxy writes, so addresses a client puts in
the header itself are ignored. Missing or invalid forwarded addresses fall back
to the socket peer. This setup assumes Caddy receives public connections directly.
See [deployment configuration](../deploy/README.md).

Startup refuses proxy trust on a non-loopback listener unless
`DUSK_DOMAINS_INDEXER_ALLOW_PUBLIC_PROXY_TRUST=true`. Use that opt-in only when a
firewall or private network restricts the listener to the trusted proxy. Use a
literal loopback address (`127.0.0.1` or `::1`) for the normal deployment. Local
development and direct listeners retain proxy trust disabled by default.

Requests across tabs or users sharing a client key consume the same budget.

### Errors and CORS

Client errors retain short codes and specific messages, e.g.
`{ "error": "invalid_limit", "message": "limit must be a positive integer." }`.
Unknown routes return 404 `not_found`; absent entities retain their existing
200/null semantics. Forward-resolution validation retains its structured `errors`
array. Unexpected failures return HTTP 500 with only:

```json
{ "error": "internal_error", "requestId": "server-generated UUID" }
```

Every response also has `X-Request-Id`. Detailed exceptions are logged with the
same ID, never sent to clients. Health warnings/degradation retain diagnostic
codes, status and candidate failure step/error type, with generic public messages; detailed warnings, cursor errors,
and durability checks are logged with the health request ID. Local database and
checkpoint paths are omitted from public diagnostics. Default responses use
`Cache-Control: no-store`; successful forward resolution keeps its existing TTL.

Configure `DUSK_DOMAINS_INDEXER_CORS_ORIGINS=https://dusk.domains,https://app.example`.
Only matching request origins receive `Access-Control-Allow-Origin`; responses
vary on `Origin`. OPTIONS, error responses, and 429s use the same policy.
`Retry-After` and `X-Request-Id` are exposed to allowed browser origins. Development
keeps `*` by default. In production an empty allowlist (or `*` alone) grants no
cross-origin access and logs a startup warning. CORS controls browsers, not
server-to-server access; the public read API requires no authentication.

`DUSK_DOMAINS_INDEXER_CORS_ORIGIN` remains a compatibility alias; the plural variable
takes precedence, even when empty. `--cors-origin` overrides either with the same
comma-separated allowlist syntax. The systemd unit and Docker image select
production mode; `.env.example` enables the limiter and lists the frontend origin.
