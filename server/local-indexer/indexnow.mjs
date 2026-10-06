import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { healthResponseForStore } from './health.mjs'
import { lifecycleClock } from './read-models/lifecycle.mjs'
import { namesSitemapEntriesAsync, storeRevision } from './share/crawler.mjs'
import { siteConfig } from './share/site.mjs'

const interval = 10 * 60_000
const maxBackoff = 6 * 60 * 60_000
const batchLimit = 10_000
const recheckInterval = 60 * 60_000

export function indexNowConfig(env = process.env, dataDir = 'target') {
  const key = env.DUSK_DOMAINS_INDEXNOW_KEY || ''
  if (key && !/^[A-Za-z0-9-]{8,128}$/.test(key)) {
    throw new Error('DUSK_DOMAINS_INDEXNOW_KEY must be 8–128 characters from A–Z, a–z, 0–9 or -')
  }
  const site = siteConfig(env)
  return {
    ...site,
    key,
    enabled: Boolean(key) && !site.noindex,
    stateFile: resolve(env.DUSK_DOMAINS_INDEXNOW_STATE || join(env.DUSK_DOMAINS_INDEXER_DATA_DIR || dataDir, 'indexnow.json')),
    endpoint: env.DUSK_DOMAINS_INDEXNOW_ENDPOINT || 'https://api.indexnow.org/indexnow',
  }
}

async function saveState(file, state) {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(state)}\n`, 'utf8')
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function loadState(config) {
  const empty = { version: 1, key: config.key, origin: config.origin, urls: {}, nextAttemptAt: 0, failures: 0 }
  let state
  try {
    state = JSON.parse(await readFile(config.stateFile, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return empty
    throw error
  }
  if (state?.version !== 1 || !state.urls || Array.isArray(state.urls) || typeof state.urls !== 'object'
    || !Object.values(state.urls).every(value => value === null || value === 'removed' || (typeof value === 'string' && Number.isFinite(Date.parse(value))))
    || !Number.isFinite(state.nextAttemptAt) || !Number.isSafeInteger(state.failures) || state.failures < 0) {
    throw new Error('Invalid IndexNow state file')
  }
  return state.key === config.key && state.origin === config.origin ? state : empty
}

// lastmod values are ISO strings from toISOString(), so they order as strings; null comes first.
function oldestFirst([urlA, a], [urlB, b]) {
  if (a !== b) return (a ?? '') < (b ?? '') ? -1 : 1
  return urlA < urlB ? -1 : urlA > urlB ? 1 : 0
}

// A merge sort over runs of 1,000 that yields between steps, so a large backlog never blocks
// the API's event loop.
export async function sortYielding(items, compare, run = 1000) {
  let runs = []
  for (let start = 0; start < items.length; start += run) {
    runs.push(items.slice(start, start + run).sort(compare))
    await setImmediate()
  }
  while (runs.length > 1) {
    const next = []
    for (let index = 0; index < runs.length; index += 2) {
      const [left, right] = [runs[index], runs[index + 1]]
      if (!right) {
        next.push(left)
        continue
      }
      const merged = []
      let a = 0
      let b = 0
      while (a < left.length || b < right.length) {
        merged.push(b === right.length || (a < left.length && compare(left[a], right[b]) <= 0) ? left[a++] : right[b++])
        if (merged.length % run === 0) await setImmediate()
      }
      next.push(merged)
    }
    runs = next
  }
  return runs[0] ?? []
}

export function createIndexNowWorker(storeProvider, {
  config = indexNowConfig(), fetchImpl = globalThis.fetch, now = Date.now, logger = console, maxLagBlocks = 12,
} = {}) {
  let state
  let busy = false
  let stopped = false
  let timer
  let controller
  let nextCheckAt = 0
  let checked

  async function tick() {
    if (!config.enabled || busy || stopped || now() < nextCheckAt) return
    busy = true
    nextCheckAt = now() + interval
    try {
      state ??= await loadState(config)
      if (stopped || now() < state.nextAttemptAt) return
      const store = await (typeof storeProvider === 'function' ? storeProvider() : storeProvider)
      const health = healthResponseForStore(store)
      if (stopped || !health.ok || health.lagBlocks === null || health.lagBlocks > maxLagBlocks) return

      const revision = storeRevision(store)
      const names = store.namesByNode
      if (!checked || checked.names !== names || checked.revision !== revision || now() - checked.at >= recheckInterval) {
        const current = new Map([[`${config.origin}/`, null], [`${config.origin}/market`, null]])
        for await (const { url, lastmod } of namesSitemapEntriesAsync(store, lifecycleClock(store, new Date(now())), config)) {
          if (stopped) return
          current.set(url, lastmod)
        }
        const removed = []
        const changed = []
        let count = 0
        for (const [url, lastmod] of Object.entries(state.urls)) {
          if (lastmod !== 'removed' && !current.has(url)) removed.push([url, 'removed'])
          if (++count % 1000 === 0) await setImmediate()
          if (stopped) return
        }
        for (const [url, lastmod] of current) {
          if (state.urls[url] !== lastmod) changed.push([url, lastmod])
          if (++count % 1000 === 0) await setImmediate()
          if (stopped) return
        }
        const ordered = await sortYielding(changed, oldestFirst)
        if (stopped) return
        // Keep the starting revision: events applied during a yield require another check.
        checked = { names, revision, at: now(), pending: [...removed, ...ordered] }
      }
      const pending = checked.pending.slice(0, batchLimit)
      if (!pending.length) return

      // Reserve the attempt before sending, so a restart cannot bypass the rate limit.
      state.nextAttemptAt = now() + interval
      await saveState(config.stateFile, state)
      if (stopped) return
      controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 10_000)
      timeout.unref?.()
      let accepted = false
      try {
        const response = await fetchImpl(config.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({
            host: config.host,
            key: config.key,
            keyLocation: `${config.origin}/${config.key}.txt`,
            urlList: pending.map(([url]) => url),
          }),
          signal: controller.signal,
          redirect: 'error',
        })
        await response.body?.cancel()
        if (response.status === 200 || response.status === 202) {
          Object.assign(state.urls, Object.fromEntries(pending))
          state.failures = 0
          accepted = true
        } else {
          logger.warn(`IndexNow submission returned HTTP ${response.status}; URLs remain pending.`)
          if (response.status === 429 || response.status >= 500) backoff()
        }
      } catch (error) {
        backoff()
        logger.warn(`IndexNow submission failed: ${error.message}`)
      } finally {
        clearTimeout(timeout)
        controller = null
      }
      await saveState(config.stateFile, state)
      if (accepted) checked.pending.splice(0, pending.length)
    } catch (error) {
      logger.warn(`IndexNow worker failed: ${error.message}`)
    } finally {
      busy = false
    }
  }

  function backoff() {
    state.failures = Math.min(state.failures + 1, 12)
    state.nextAttemptAt = now() + Math.min(maxBackoff, interval * 2 ** state.failures)
  }

  function start() {
    if (!config.enabled || stopped || timer) return
    const run = async () => {
      await tick()
      if (!stopped) {
        timer = setTimeout(run, interval)
        timer.unref?.()
      }
    }
    timer = setTimeout(run, 0)
    timer.unref?.()
  }

  function stop() {
    stopped = true
    clearTimeout(timer)
    controller?.abort()
  }

  return { tick, start, stop }
}
