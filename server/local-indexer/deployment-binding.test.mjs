import { describe, expect, it } from 'vitest'
import { deploymentBindingFromEvents } from './deployment-binding.mjs'

const id = (byte) => `0x${byte.repeat(32)}`
const [router, treasury, firstRegistry, nextRegistry, stranger] = ['c0', 'c1', 'c2', 'c3', 'c4'].map(id)
const row = (contractKey, contractId, event = { type: 'name_registered' }) => ({
  event,
  meta: { chainId: 'dusk:0', contractKey, contractId, blockHeight: 10 },
})
const added = (member) => row('router', router, { type: 'pool_member_added', kind: 'registry', member })

describe('deployment binding', () => {
  it('binds a grown pool: every core ID is a registry the router added', () => {
    const binding = deploymentBindingFromEvents([
      added(firstRegistry),
      row('treasury', treasury),
      row('core', firstRegistry),
      added(nextRegistry),
      row('core', nextRegistry),
    ])
    expect(binding).toMatchObject({ complete: true, conflictedContracts: [] })
    expect(binding.contracts.core).toMatchObject({ contractId: firstRegistry, contractIds: [firstRegistry, nextRegistry] })
  })

  it('flags a core ID the router never added', () => {
    const binding = deploymentBindingFromEvents([
      added(firstRegistry),
      row('treasury', treasury),
      row('core', firstRegistry),
      row('core', stranger),
    ])
    expect(binding).toMatchObject({ complete: false, conflictedContracts: ['core'] })
  })
})
