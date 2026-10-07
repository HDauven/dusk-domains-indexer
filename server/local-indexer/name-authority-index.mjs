import { compareKeys, listKey, paginate } from './pagination.mjs'

// Built with each served view, so ownership, controller and expiry changes replace the index
// together with the names it references. Requests only seek and read a page plus a sentinel.
export function indexNamesByAuthority(namesByCanonical, controllersByNode) {
  const index = new Map()
  const names = orderedNames(namesByCanonical.values())
  for (const name of names) {
    const authorities = new Set([name.lifecycle.owner, name.lifecycle.manager, ...(controllersByNode?.get(name.node) ?? [])]
      .map((value) => String(value ?? '').trim().toLowerCase()).filter(Boolean))
    for (const authority of authorities) {
      if (!index.has(authority)) index.set(authority, [])
      index.get(authority).push(name)
    }
  }
  return index
}

// MSD radix ordering visits each key character at most once. Bucket sorting is bounded
// by the UTF-16 alphabet, not the population; /names keys are canonical DNS and hex.
// This preserves pagination order without an O(names log names) publication sort.
function orderedNames(values) {
  const result = [], pending = [{ rows: [...values].map(name => ({ name, key: listKey('/names', name) })), field: 0, offset: 0 }]
  while (pending.length) {
    const { rows, field, offset } = pending.pop()
    if (rows.length < 2 || field === 2) { for (const row of rows) result.push(row.name); continue }
    const buckets = new Map()
    for (const row of rows) {
      const code = offset < row.key[field].length ? row.key[field].charCodeAt(offset) : -1
      if (!buckets.has(code)) buckets.set(code, [])
      buckets.get(code).push(row)
    }
    for (const code of [...buckets.keys()].sort((a, b) => b - a)) {
      pending.push({ rows: buckets.get(code), field: code === -1 ? field + 1 : field, offset: code === -1 ? 0 : offset + 1 })
    }
  }
  return result
}

export function namesPage(store, owner, page) {
  const authority = String(owner ?? '').trim().toLowerCase()
  const keyFor = (name) => listKey('/names', name)
  if (!authority) return paginate(store.namesByCanonical.values(), page, keyFor)
  if (!store.namesByAuthority) return { error: 'name_index_unavailable', message: 'The name authority index is unavailable.' }
  const names = store.namesByAuthority.get(authority) ?? []
  let start = 0
  let end = names.length
  if (page.after) {
    while (start < end) {
      const middle = Math.floor((start + end) / 2)
      if (compareKeys(keyFor(names[middle]), page.after) <= 0) start = middle + 1
      else end = middle
    }
  }
  return paginate(names.slice(start, start + page.limit + 1), page, keyFor)
}
