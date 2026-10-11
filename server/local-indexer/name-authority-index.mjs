import { normalizeName, normalizeNode } from './http.mjs'
import { compareKeys, listKey, paginate } from './pagination.mjs'
import { indexedSubnameBlocksRegistration } from './read-models/lifecycle.mjs'

// Built with each served view, so ownership, controller and expiry changes replace the index
// together with the names it references. Requests only seek and read a page plus a sentinel.
export function indexNamesByAuthority(namesByCanonical, controllersByNode) {
  const index = new Map()
  const names = orderedByKey(namesByCanonical.values(), (name) => listKey('/names', name))
  for (const name of names) {
    const authorities = new Set([name.lifecycle.owner, name.lifecycle.manager, ...(controllersByNode?.get(name.node) ?? [])]
      .map(authorityKey).filter(Boolean))
    for (const authority of authorities) push(index, authority, name)
  }
  return index
}

// Every name an authority holds as its current owner or manager: roots through grace, as on
// /names, and subnames while /subname serves them (active, under a held root). Built with the
// publication and evaluated at its clock, so a holder's subnames never depend on its roots.
export function indexHoldingsByAuthority(store, clock) {
  const rows = []
  for (const name of store.namesByCanonical.values()) rows.push(holdingRow(store, name.lifecycle ?? name, null))
  for (const subname of store.subnamesByNode?.values() ?? []) {
    if (indexedSubnameBlocksRegistration(store, subname, clock)) rows.push(holdingRow(store, subname, subname))
  }
  const index = new Map()
  for (const row of orderedByKey(rows, holdingKey)) {
    const owner = authorityKey(row.owner), manager = authorityKey(row.manager)
    if (owner) push(index, owner, { row, role: 'owner' })
    if (manager && manager !== owner) push(index, manager, { row, role: 'manager' })
  }
  return index
}

function holdingRow(store, name, subname) {
  const node = normalizeNode(name.node)
  return {
    node,
    name: normalizeName(subname ? subname.name : name.canonicalName),
    kind: subname ? 'subname' : 'root',
    root: subname ? normalizeNode(subname.root ?? rootOf(store, node)) : node,
    parentNode: subname ? normalizeNode(subname.parentNode) : null,
    parentName: subname ? subname.parentName ?? normalizeName(subname.name).split('.').slice(1).join('.') : null,
    owner: name.owner ?? null,
    manager: name.manager ?? null,
    status: subname ? 'active' : name.status ?? 'active',
    expiresAtBlockHeight: name.expiresAtBlockHeight ?? null,
    // A subname has no grace period of its own; it lapses with its expiry.
    graceEndsAtBlockHeight: subname ? null : name.graceEndsAtBlockHeight ?? null,
    homeShard: name.homeShard ?? null,
    generation: name.generation ?? null,
    serial: name.serial ?? null,
  }
}

function rootOf(store, node) {
  const seen = new Set()
  let current = store.subnamesByNode.get(node)
  while (current && !seen.has(current.node)) {
    seen.add(current.node)
    const parent = normalizeNode(current.parentNode)
    if (store.namesByNode.has(parent)) return parent
    current = store.subnamesByNode.get(parent)
  }
  return null
}

const holdingKey = (row) => [row.name, row.node]
const authorityKey = (value) => String(value ?? '').trim().toLowerCase()

function push(index, key, value) {
  if (!index.has(key)) index.set(key, [])
  index.get(key).push(value)
}

// MSD radix ordering visits each key character at most once. Bucket sorting is bounded
// by the UTF-16 alphabet, not the population; both keys are canonical DNS and hex.
// This preserves pagination order without an O(names log names) publication sort.
function orderedByKey(values, keyFor) {
  const result = [], pending = [{ rows: [...values].map(item => ({ item, key: keyFor(item) })), field: 0, offset: 0 }]
  while (pending.length) {
    const { rows, field, offset } = pending.pop()
    if (rows.length < 2 || field === 2) { for (const row of rows) result.push(row.item); continue }
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

// The first position after the cursor's key in an ordered index.
function seek(rows, after, keyFor) {
  let start = 0
  let end = rows.length
  if (after) {
    while (start < end) {
      const middle = Math.floor((start + end) / 2)
      if (compareKeys(keyFor(rows[middle]), after) <= 0) start = middle + 1
      else end = middle
    }
  }
  return start
}

export function namesPage(store, owner, page) {
  const authority = authorityKey(owner)
  const keyFor = (name) => listKey('/names', name)
  if (!authority) return paginate(store.namesByCanonical.values(), page, keyFor)
  if (!store.namesByAuthority) return { error: 'name_index_unavailable', message: 'The name authority index is unavailable.' }
  const names = store.namesByAuthority.get(authority) ?? []
  const start = seek(names, page.after, keyFor)
  return paginate(names.slice(start, start + page.limit + 1), page, keyFor)
}

export function holdingsPage(store, authority, page) {
  if (!store.holdingsByAuthority) return { error: 'holder_index_unavailable', message: 'The holder index is unavailable.' }
  const entries = store.holdingsByAuthority.get(authorityKey(authority)) ?? []
  const keyFor = (entry) => holdingKey(entry.row)
  const start = seek(entries, page.after, keyFor)
  const result = paginate(entries.slice(start, start + page.limit + 1), page, keyFor)
  return { items: result.items.map(({ row, role }) => ({ ...row, role })), nextCursor: result.nextCursor }
}
