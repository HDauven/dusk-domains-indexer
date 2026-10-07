import assert from 'node:assert/strict'
import { contractId, hex } from '@duskdomains/sdk'
import { committedEvents } from '@duskdomains/sdk/projection'
import { indexerEventCatalog } from '@duskdomains/sdk/event-catalog'

export const roles = ['directory', 'policy', 'store', 'vault', 'resolver', 'marketplace']
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
        const role = 'AddStore' in b.action || 'SetAcceptsMoves' in b.action ? 'store'
          : 'AddResolver' in b.action ? 'resolver' : 'SetPolicy' in b.action ? 'policy' : null
        assert(role, 'Unknown admission action: upgrade the indexer')
        result.push([role, b.admission, e.ordinal])
      }
      if (b.market) result.push(['marketplace', b.market, e.ordinal])
    }
  }
  return result.map(([role, admission, ordinal]) => {
    assert.equal(admission.interface_version, 1, 'Unsupported admitted interface: upgrade the indexer')
    return { role, id: contractId(admission.id), ordinal, codeHash: hex(admission.code_hash) }
  })
}

export function followAdmissions(receipt, contracts, directoryId) {
  const scope = Object.fromEntries([...contracts].map(([id, c]) => [id, c.key]))
  for (const a of admissions(receipt, scope, directoryId)) {
    if (contracts.has(a.id)) {
      assert.equal(contracts.get(a.id).key, a.role, 'Admission role conflict')
      continue
    }
    const template = [...contracts.values()].find(c => c.key === a.role)
    assert(template, `No v1 driver for admitted ${a.role}`)
    contracts.set(a.id, { ...template, contractId: a.id, codeHash: a.codeHash })
  }
}

export function decodeReceipt(rawEvents, header, contracts, directoryId) {
  const decoded = new Map()
  const scope = () => Object.fromEntries([...contracts].map(([id, c]) => [id, c.key]))
  const decode = (raw, ordinal) => {
    const c = contracts.get(raw.source)
    if (!c || decoded.has(ordinal)) return
    assert.equal(typeof raw.reverted, 'boolean', 'Archive event lacks rollback metadata')
    if (raw.reverted) return
    assert(c.events.includes(raw.topic), `Unsupported ${c.key} event \`${raw.topic}\` at block ${header.height}: upgrade the indexer`)
    assert(typeof raw.data === 'string' && /^(?:[0-9a-f]{2})*$/i.test(raw.data), 'Invalid archive event bytes')
    decoded.set(ordinal, { emitter: raw.source, topic: raw.topic,
      data: c.driver.decodeEvent(raw.topic, Buffer.from(raw.data, 'hex')), reverted: false, ordinal })
  }
  rawEvents.forEach(({ raw, ordinal }) => decode(raw, ordinal))
  const receipt = { id: `${header.hash}:${rawEvents[0].raw.origin}`, height: BigInt(header.height), success: true,
    events: [...decoded.values()].sort((a, b) => a.ordinal - b.ordinal) }
  const added = admissions(receipt, scope(), directoryId)
  followAdmissions(receipt, contracts, directoryId)
  // Include only operations after admission, including another frame in the very same receipt.
  for (const a of added) for (const { raw, ordinal } of rawEvents)
    if (raw.source === a.id && ordinal > a.ordinal) decode(raw, ordinal)
  receipt.events = [...decoded.values()].sort((a, b) => a.ordinal - b.ordinal)
  committedEvents(receipt, scope()) // validate wire versions and journal frames before journaling
  return receipt
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
