import { createHash } from 'node:crypto'

export const LIST_FIELDS = Object.freeze({
  '/names': 'names',
  '/records': 'records',
  '/record-history': 'history',
  '/activity': 'activity',
  '/subnames': 'subnames',
  '/marketplace/fixed-sales': 'fixedSales',
  '/marketplace/auctions': 'auctions',
  '/marketplace/offers': 'offers',
})

export function pageParameters(pathname, url) {
  if (!LIST_FIELDS[pathname] && pathname !== '/search' && pathname !== '/health' && pathname !== '/resolve') return {}
  const rawLimit = url.searchParams.get('limit')
  if (url.searchParams.getAll('limit').length > 1 || (rawLimit !== null && !/^[1-9][0-9]*$/.test(rawLimit))) {
    return { error: { error: 'invalid_limit', message: 'limit must be a positive integer.' } }
  }
  const limit = rawLimit === null ? 50 : Math.min(Number(rawLimit), 200)
  const filters = [...url.searchParams].filter(([key]) => key !== 'limit' && key !== 'cursor').sort()
  const scope = digest(JSON.stringify([pathname, filters]))
  const cursor = url.searchParams.get('cursor')
  let after = null
  if (cursor !== null) {
    try {
      if (pathname === '/search' || url.searchParams.getAll('cursor').length > 1 || !/^[A-Za-z0-9_-]{1,4096}$/.test(cursor)) throw new Error()
      const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
      if (decoded.v !== 1 || decoded.scope !== scope || !Array.isArray(decoded.key)
        || decoded.key.length < 1 || decoded.key.length > 12
        || !decoded.key.every((value) => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)))) throw new Error()
      const types = pathname === '/records' ? ['string']
        : ['/names', '/subnames', '/marketplace/offers'].includes(pathname) ? ['string', 'string']
          : pathname.startsWith('/marketplace/') ? ['string'] : ['number', 'number', 'number', 'string', 'string', 'string']
      if (decoded.key.length !== types.length || !decoded.key.every((value, index) => typeof value === types[index])) throw new Error()
      after = decoded.key
    } catch {
      return { error: { error: 'invalid_cursor', message: 'cursor is invalid for this query.' } }
    }
  }
  return { limit, after, scope }
}

// Retain only one page plus a sentinel. Selecting before hydration bounds response work
// and memory even when the read model contains millions of rows.
export function paginate(rows, page, keyFor) {
  const heap = []
  const capacity = page.limit + 1
  for (const item of rows) {
    const key = keyFor(item)
    if (page.after && compareKeys(key, page.after) <= 0) continue
    const row = { item, key }
    if (heap.length < capacity) {
      heap.push(row)
      let index = heap.length - 1
      while (index > 0) {
        const parent = (index - 1) >> 1
        if (compareKeys(heap[parent].key, key) >= 0) break
        heap[index] = heap[parent]
        index = parent
      }
      heap[index] = row
    } else if (compareKeys(key, heap[0].key) < 0) {
      heap[0] = row
      let index = 0
      while (index * 2 + 1 < heap.length) {
        let child = index * 2 + 1
        if (child + 1 < heap.length && compareKeys(heap[child + 1].key, heap[child].key) > 0) child += 1
        if (compareKeys(heap[index].key, heap[child].key) >= 0) break
        const previous = heap[index]
        heap[index] = heap[child]
        heap[child] = previous
        index = child
      }
    }
  }
  heap.sort((left, right) => compareKeys(left.key, right.key))
  const hasMore = heap.length > page.limit
  if (hasMore) heap.pop()
  return {
    items: heap.map((row) => row.item),
    nextCursor: hasMore ? Buffer.from(JSON.stringify({ v: 1, scope: page.scope, key: heap.at(-1).key })).toString('base64url') : null,
  }
}

export function listKey(pathname, item) {
  if (pathname === '/names') return [item.lifecycle.canonicalName, item.node]
  if (pathname === '/records') return [item.key]
  if (pathname === '/subnames') return [item.name, item.node]
  if (pathname === '/marketplace/offers') return [item.node, item.buyerAuthority]
  if (pathname.startsWith('/marketplace/')) return [item.node]
  if (pathname === '/resolve') return [-(Date.parse(item.timestamp ?? '') || 0), -(item.blockHeight ?? -1), -(item.eventIndex ?? -1), item.txId ?? '', item.id ?? '', digest(JSON.stringify(item))]
  return [-(item.blockHeight ?? -1), -(item.eventIndex ?? -1), -(Date.parse(item.timestamp ?? item.updatedAt ?? '') || 0), item.txId ?? '', item.id ?? item.key ?? '', digest(JSON.stringify(item))]
}

function compareKeys(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] === right[index]) continue
    return left[index] < right[index] ? -1 : 1
  }
  return 0
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}
