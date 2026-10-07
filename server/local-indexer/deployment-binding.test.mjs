import { expect, it } from 'vitest'
import { deploymentBindingFromEvents, deploymentEvents } from './deployment-binding.mjs'
import { moveHistory, id, createEventLog, envelope, receipt, bytes, admission } from '../../scripts/test-fixtures/frozen-events.mjs'
it('binds the six roles and subsequent stores and resolvers to committed directory admissions', () => {
  const m = moveHistory(), b = deploymentBindingFromEvents([...m.events, m.final])
  expect(b).toMatchObject({ complete: true, conflictedContracts: [], chainId: 'dusk:1' })
  expect(b.contracts.store.contractIds).toEqual([`0x${id(4)}`, `0x${id(8)}`])
  expect(b.contracts.resolver.contractIds).toEqual([`0x${id(5)}`, `0x${id(9)}`])
})
it('ignores unadmitted emitters and degrades malformed journals', () => {
  const e = envelope(receipt(16, [[8, 'commitment_created', { commitment: { key: { hash: bytes(1), actor: bytes(10) }, created_at: 16n } }]]))
  expect(deploymentBindingFromEvents([...createEventLog(), e]).contracts.store.contractIds).toEqual([`0x${id(4)}`])
  e.event.receipt.events[0].data = 'bad'
  expect(deploymentBindingFromEvents([...createEventLog(), e]).complete).toBe(false)
})

it('excludes pre-admission effects from deployment audit evidence in the admitting receipt', () => {
  const earlier = [8, 'commitment_created', { commitment: { key: { hash: bytes(7), actor: bytes(10) }, created_at: 16n } }]
  const entry = envelope(receipt(16, [earlier, admission('store', 8)]))
  const rows = deploymentEvents([...createEventLog(), entry])
  expect(rows.some(e => e.meta.contractId === `0x${id(8)}`)).toBe(false)
})
