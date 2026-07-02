# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS deps
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git openssh-client \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json .npmrc ./

# Private GitHub package dependencies require BuildKit SSH forwarding:
# docker build --ssh default -t dusk-domains-indexer .
RUN --mount=type=ssh npm ci --omit=dev

FROM node:24-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json .npmrc ./
COPY server ./server
COPY scripts ./scripts
COPY docs ./docs

EXPOSE 8787
VOLUME ["/data"]

CMD ["node", "server/local-indexer.mjs", "--host", "0.0.0.0", "--port", "8787", "--sqlite", "/data/dusk-domains.sqlite", "--event-log", "/data/dusk-domains.events.jsonl", "--cursor", "/data/dusk-domains.cursor.json", "--checkpoint", "/data/dusk-domains.checkpoint.json", "--strict-health", "--watch"]
