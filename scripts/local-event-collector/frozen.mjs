import { contractId, hex } from '@duskdomains/sdk'
import { committedEvents } from '@duskdomains/sdk/projection'
import { indexerEventCatalog } from '@duskdomains/sdk/event-catalog'

export const roles = ['directory', 'policy', 'store', 'vault', 'resolver', 'marketplace']

/**
 * An event or admission from the collected scope that this indexer cannot accept. Collection
 * stops at its block, fail closed, until a decoder that reads it is deployed. `code` is
 * `unsupported_event`, `invalid_event` or `unsupported_admission`.
 */
export class CollectorEventError extends Error {
  constructor(code, message, { emitter = null, role = null, topic = null, txId = null } = {}) {
    super(message)
    this.name = 'CollectorEventError'
    Object.assign(this, { code, emitter, role, topic, txId })
  }
}
const unsupportedAdmission = message => new CollectorEventError('unsupported_admission', message, { role: 'directory' })
export const topicsFor = role => Object.entries(indexerEventCatalog)
  .filter(([, spec]) => spec.role === '*' || spec.role === role).map(([topic]) => topic)

// Only committed directory operations may expand the emitter scope. Never forget retired members:
// they still serve old names, return custody and pay claims.
export function admissions(receipt, scope, directoryId) {
  const result = []
  for (const e of committedEvents(receipt, scope)) {
    if (e.emitter !== directoryId) continue
    const b = e.data.body
    if (e.topic === 'directory_initialized') {
      result.push(['store', b.args.initial_store, e.ordinal], ['resolver', b.args.initial_resolver, e.ordinal],
        ['policy', b.args.policy, e.ordinal])
      if (b.args.initial_market) result.push(['marketplace', b.args.initial_market, e.ordinal])
    } else if (e.topic === 'action_applied') {
      if (b.admission) {
        const role = 'AddStore' in b.action || 'SetAcceptsMoves' in b.action || 'SetRetiring' in b.action ? 'store'
          : 'AddResolver' in b.action ? 'resolver' : 'SetPolicy' in b.action ? 'policy' : null
        if (!role) throw unsupportedAdmission('Unknown admission action: upgrade the indexer')
        result.push([role, b.admission, e.ordinal])
      }
      if (b.market) result.push(['marketplace', b.market, e.ordinal])
    }
  }
  return result.map(([role, admission, ordinal]) => {
    if (admission.interface_version !== 1) throw unsupportedAdmission('Unsupported admitted interface: upgrade the indexer')
    return { role, id: contractId(admission.id), ordinal, codeHash: hex(admission.code_hash), admission }
  })
}

// A policy admitted after launch initialized at its deployment, before admission and outside
// the collected scope; the collector journals that initialization separately.
export function policyAdmissions(receipt, contracts, directoryId) {
  const scope = Object.fromEntries([...contracts].map(([id, c]) => [id, c.key]))
  return admissions(receipt, scope, directoryId).filter(a => a.role === 'policy')
}

// A marketplace admitted after launch can be configured before its admission, outside the
// collected scope; the collector journals that configuration separately.
export function marketAdmissions(receipt, contracts, directoryId) {
  const scope = Object.fromEntries([...contracts].map(([id, c]) => [id, c.key]))
  return admissions(receipt, scope, directoryId).filter(a => a.role === 'marketplace')
}

export function followAdmissions(receipt, contracts, directoryId) {
  const scope = Object.fromEntries([...contracts].map(([id, c]) => [id, c.key]))
  for (const a of admissions(receipt, scope, directoryId)) {
    if (contracts.has(a.id)) {
      if (contracts.get(a.id).key !== a.role) throw unsupportedAdmission('Admission role conflict')
      continue
    }
    const template = [...contracts.values()].find(c => c.key === a.role)
    if (!template) throw unsupportedAdmission(`No v1 driver for admitted ${a.role}`)
    contracts.set(a.id, { ...template, contractId: a.id, codeHash: a.codeHash })
  }
}

/**
 * Decode one transaction's events from the collected scope into a journal receipt, in two steps.
 * `beginReceipt` decodes them and follows the directory's admissions; the caller settles the
 * trust of the marketplaces the transaction lists (`admittedMarkets`) and then `finish` decides
 * what is journaled. `decodeReceipt` does both at once.
 *
 * `trust(id)` is `trusted` for an emitter whose code the indexer vouches for (the release, an
 * admitted store, resolver or policy, an authenticated marketplace), `doomed` for a marketplace
 * whose authentication failed for good, and `pending` for one not authenticated yet. None of a
 * doomed market's events is collected: all are set aside as `unauthenticated`. A pending market's
 * events are collected while they are readable, well framed and change nothing another emitter
 * commits. A pending market whose frames change what a trusted emitter commits, while disjoint
 * from every trusted operation, contradicts it and is set aside as `interference`. Anything else
 * about a pending market cannot be attributed: an operation of it enclosing a trusted one (setting
 * it aside would publish a child the chain may never have committed), an event the reviewed
 * driver cannot read, or frames that conflict with another pending market's. Collection then
 * stops there, fail closed, until its authentication settles. Set-aside events are
 * reported to `quarantine({ emitter, code, topic, ordinals })`. Trusted emitters fail closed as
 * before, with a `CollectorEventError`.
 */
export function beginReceipt(rawEvents, header, contracts, directoryId, { trust = () => 'trusted' } = {}) {
  const decoded = new Map(), unreadable = new Map(), admittedAt = new Map(), known = new Set(contracts.keys())
  const txId = rawEvents[0].raw.origin
  const head = { id: `${header.hash}:${txId}`, height: BigInt(header.height), success: true }
  const scope = () => Object.fromEntries([...contracts].map(([id, c]) => [id, c.key]))
  const decode = (raw, ordinal) => {
    const c = contracts.get(raw.source)
    if (!c || decoded.has(ordinal) || unreadable.has(raw.source)) return
    const fail = (code, message) => {
      const error = new CollectorEventError(code, message, { emitter: raw.source, role: c.key, topic: raw.topic ?? null, txId })
      // Whether an unauthenticated market's unreadable event matters is decided once its trust is.
      if (trust(raw.source) === 'trusted') throw error
      unreadable.set(raw.source, error)
    }
    if (typeof raw.reverted !== 'boolean') return fail('invalid_event', 'Archive event lacks rollback metadata')
    if (raw.reverted) return
    if (!c.events.includes(raw.topic)) return fail('unsupported_event', `Unsupported ${c.key} event \`${raw.topic}\` at block ${header.height}: upgrade the indexer`)
    if (typeof raw.data !== 'string' || !/^(?:[0-9a-f]{2})*$/i.test(raw.data)) return fail('invalid_event', 'Invalid archive event bytes')
    let data
    try { data = c.driver.decodeEvent(raw.topic, Buffer.from(raw.data, 'hex')) } catch (error) {
      return fail('invalid_event', `Undecodable ${c.key} event \`${raw.topic}\` at block ${header.height}: ${error.message}`)
    }
    decoded.set(ordinal, { emitter: raw.source, topic: raw.topic, data, reverted: false, ordinal })
  }
  rawEvents.forEach(({ raw, ordinal }) => decode(raw, ordinal))
  const events = () => [...decoded.values()].sort((a, b) => a.ordinal - b.ordinal)
  // The scope grows from the directory's committed actions, read without unauthenticated frames.
  const directoryView = { ...head, events: events().filter(e => trust(e.emitter) === 'trusted') }
  const added = admissions(directoryView, scope(), directoryId)
  followAdmissions(directoryView, contracts, directoryId)
  // Include only operations after admission, including another frame in the very same receipt.
  for (const a of added) {
    if (!known.has(a.id) && !admittedAt.has(a.id)) admittedAt.set(a.id, a.ordinal)
    for (const { raw, ordinal } of rawEvents)
      if (raw.source === a.id && ordinal > a.ordinal) decode(raw, ordinal)
  }
  // The raw events of `emitter` in the collected scope: after its admission when this receipt lists it.
  const inScope = emitter => rawEvents.filter(({ raw, ordinal }) => raw.source === emitter && ordinal > (admittedAt.get(emitter) ?? -1))
  return {
    id: head.id,
    admittedMarkets: added.filter(a => a.role === 'marketplace' && !known.has(a.id)),
    // Every ordinal the collected scope covers, decided on or not; the rest is outside it.
    inScope: new Set(rawEvents.filter(({ raw, ordinal }) => known.has(raw.source) || ordinal > (admittedAt.get(raw.source) ?? Infinity))
      .map(({ ordinal }) => ordinal)),
    finish({ trust: settled = trust, quarantine = () => {} } = {}) {
      const setAside = new Map()
      const present = new Set([...events().map(e => e.emitter), ...unreadable.keys()])
      for (const emitter of present) if (settled(emitter) === 'doomed') setAside.set(emitter, 'unauthenticated')
      // An event of a trusted or pending market no reviewed driver reads stops collection.
      for (const [emitter, error] of unreadable) if (!setAside.has(emitter)) throw error
      const kept = () => events().filter(e => !setAside.has(e.emitter))
      const level = e => settled(e.emitter)
      const committed = list => committedEvents({ ...head, events: list }, scope())
      const ordinals = (list, keep) => list.filter(keep).map(e => e.ordinal).join()
      const trusted = () => kept().filter(e => level(e) === 'trusted')
      let base
      try { base = ordinals(committed(trusted()), () => true) } catch (error) {
        throw new CollectorEventError('invalid_event', error.message, { txId })
      }
      const conflict = (message, emitter = null) => new CollectorEventError('interference',
        `${message} in transaction ${txId} at block ${header.height}; collection resumes once their authentication settles`,
        { emitter, role: 'marketplace', txId })
      const pendingIn = () => [...new Set(kept().filter(e => level(e) === 'pending').map(e => e.emitter))]
      const withPending = ids => kept().filter(e => level(e) === 'trusted' || ids.has(e.emitter))
      // A pending market alone: its frames must be valid, and leave what trusted emitters commit alone.
      const alone = new Map()
      for (const emitter of pendingIn()) {
        const own = withPending(new Set([emitter]))
        let result
        try { result = committed(own) } catch (error) {
          throw new CollectorEventError('invalid_event', `Unauthenticated marketplace frames: ${error.message}`, { emitter, role: 'marketplace', txId })
        }
        if (ordinals(result, e => level(e) === 'trusted') === base) alone.set(emitter, ordinals(result, e => e.emitter === emitter))
        // Its operation encloses a trusted one: whether that child committed depends on the parent.
        else if (enclosesTrusted(own, emitter, id => settled(id) === 'trusted'))
          throw conflict("An unauthenticated marketplace's operation encloses a trusted contract's and changes whether it committed", emitter)
        else setAside.set(emitter, 'interference')
      }
      // Several pending markets together: none may change what another, or a trusted emitter, commits.
      const remaining = pendingIn()
      if (remaining.length > 1) {
        let together
        try { together = committed(withPending(new Set(remaining))) } catch (error) {
          throw conflict(`Unauthenticated marketplaces' frames conflict (${error.message})`)
        }
        if (ordinals(together, e => level(e) === 'trusted') !== base) throw conflict('Unauthenticated marketplaces together change what other contracts commit')
        for (const emitter of remaining)
          if (ordinals(together, e => e.emitter === emitter) !== alone.get(emitter))
            throw conflict(`Unauthenticated marketplaces' frames change each other's commitments`, emitter)
      }
      for (const [emitter, code] of setAside)
        quarantine({ emitter, code, topic: unreadable.get(emitter)?.topic ?? null, ordinals: inScope(emitter).map(({ ordinal }) => ordinal) })
      return { ...head, events: kept() }
    },
  }
}

const samePath = (a, b) => a.length === b.length && a.every((step, i) => contractId(step) === contractId(b[i]))
const prefixOf = (a, b) => a.length <= b.length && samePath(a, b.slice(0, a.length))
/**
 * Whether an operation of `emitter` is an ancestor of one by an emitter `trusted` accepts, framed
 * as the projection frames them: a begin's parent is the innermost open frame on its call path.
 */
function enclosesTrusted(events, emitter, trusted) {
  let open = []
  for (const e of events) {
    if (e.topic !== 'operation_begin' && e.topic !== 'operation_end') continue
    const path = e.data.call_path
    if (e.topic === 'operation_begin') {
      for (const f of open) if (!prefixOf(f.path, path) || f.path.length === path.length) f.abandoned = true
      open = open.filter(f => !f.abandoned)
      const parent = open.filter(f => prefixOf(f.path, path) && f.path.length < path.length).at(-1)
      if (trusted(e.emitter)) for (let up = parent; up; up = up.parent) if (up.emitter === emitter) return true
      open.push({ emitter: e.emitter, opSeq: e.data.op_seq, path, parent })
    } else {
      const frame = open.findLast(f => f.emitter === e.emitter && f.opSeq === e.data.op_seq && samePath(f.path, path))
      if (!frame) continue
      for (const f of open) if (f !== frame && prefixOf(frame.path, f.path)) f.abandoned = true
      open = open.filter(f => f !== frame && !f.abandoned)
    }
  }
  return false
}

/** `beginReceipt` and `finish` at once, with the trust as it is now. */
export function decodeReceipt(rawEvents, header, contracts, directoryId, { trust = () => 'trusted', quarantine = () => {} } = {}) {
  return beginReceipt(rawEvents, header, contracts, directoryId, { trust }).finish({ trust, quarantine })
}

export function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v))
}

// Used by deployment audits as well as collection: pre-admission operations cannot
// become evidence simply because a later operation in the same receipt admits the emitter.
export function committedScopeEvents(receipt, contracts, directoryId) {
  const previous = Object.fromEntries([...contracts].map(([id, c]) => [id, c.key]))
  const added = admissions(receipt, previous, directoryId).filter(a => !previous[a.id])
  followAdmissions(receipt, contracts, directoryId)
  const scope = Object.fromEntries([...contracts].map(([id, c]) => [id, c.key]))
  const admittedAt = new Map(added.map(a => [a.id, a.ordinal]))
  return committedEvents({ ...receipt, events: receipt.events.filter(e =>
    !admittedAt.has(e.emitter) || e.ordinal > admittedAt.get(e.emitter)) }, scope)
}
