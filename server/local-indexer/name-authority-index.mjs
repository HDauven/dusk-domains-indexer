import { compareKeys, listKey, paginate } from './pagination.mjs'

// Built with each served view, so ownership, controller and expiry changes replace the index
// together with the names it references. Requests only seek and read a page plus a sentinel.
export function indexNamesByAuthority(namesByCanonical, controllersByNode) {
  const index = new Map()
  const names = [...namesByCanonical.values()].sort((left, right) => compareKeys(listKey('/names', left), listKey('/names', right)))
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
