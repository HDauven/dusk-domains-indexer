import { describe, expect, it, vi } from 'vitest'
import {
  duskDomainsIndexedEventTypes,
  controllerEventTypes, lifecycleEventTypes, resolverEventTypes, reverseEventTypes, subnameEventTypes,
  treasuryEventTypes, referralEventTypes, feeConfigEventTypes, marketplaceEventTypes, poolEventTypes,
} from '@duskdomains/sdk/event-catalog'
import { replayEventLog } from './event-log-store.mjs'
import { commitmentKey, createLifecycleEventProjector, createProjectionState, applyProjectionEvent, emptyMarketplaceConfig, marketplaceOrderIsEscrowed } from '@duskdomains/sdk/projection'
import {
  createIndexerParityEvents,
  fixtureCommitment,
  fixtureManager,
  fixtureMoonlightAddress,
  fixtureNextRecordResolver,
  fixtureNextRegistry,
  fixtureRecordResolver,
  fixtureRegistry,
  fixtureRouter,
  fixtureTreasury,
  fixtureNode,
  fixtureOwner,
  fixtureParentNode,
  fixtureSubnameNode,
} from '../../scripts/test-fixtures/indexer-events.mjs'

describe('shared SDK projection and server replay', () => {
  it('covers every shared Dusk Domains event type in the parity fixture', () => {
    const fixtureEventTypes = new Set(createIndexerParityEvents().map((envelope) => envelope.event.type))

    expect(fixtureEventTypes.has('subname_pruned')).toBe(true)
    expect(duskDomainsIndexedEventTypes.filter((type) => !fixtureEventTypes.has(type))).toEqual([])
  })

  it.each([undefined, '2026-06-27T12:00:00.000Z'])('matches the SDK projector after every event with observation time %s', (observedAt) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-27T12:00:00.000Z'))
    try {
      const sdk = createLifecycleEventProjector()
      const state = createProjectionState()
      const events = createIndexerParityEvents().map(entry => ({ ...entry, meta: { ...entry.meta, ...(observedAt ? { observedAt } : {}) } }))
      const warnings = []
      const methods = {
        lifecycle: 'apply', controller: 'applyController', resolver: 'applyResolver', reverse: 'applyReverse',
        subname: 'applySubname', treasury: 'applyTreasury', referral: 'applyReferral', feeConfig: 'applyFeeConfig',
        marketplace: 'applyMarketplace', pool: 'applyPool',
      }
      for (const [index, entry] of events.entries()) {
        const meta = { ...entry.meta, eventId: `replay:${index}` }
        const method = Object.entries(eventGroups).find(([, types]) => types.includes(entry.event.type))?.[0]
        expect(method, entry.event.type).toBeDefined()
        sdk[methods[method]](entry.event, meta)
        applyProjectionEvent(state, entry.event, meta)
        const server = replayEventLog(events.slice(0, index + 1), warnings, '2026-06-27T12:10:00.000Z')
        expect(warnings).toEqual([])
        for (const [node, name] of state.namesByNode) expect(sdk.getNameByNode(node)).toEqual(name)
        for (const [node, activity] of server.activityByNode) expect(sdk.getActivity(node)).toEqual(activity)
        for (const [node, records] of server.recordsByNode) expect(sdk.getResolverRecords(node)).toEqual(records)
        for (const reverse of server.reverseByEndpoint.values()) expect(sdk.getPrimaryNameByEndpoint(reverse.endpoint)).toEqual(reverse)
        for (const subname of server.subnamesByNode.values()) expect(sdk.getSubnameByNode(subname.node)).toEqual(subname)
        expect(sdk.getTreasuryState()).toEqual(server.treasuryState)
        expect(sdk.getFeeConfig()).toEqual(server.feeConfig)
        expect(sdk.getPoolState()).toEqual(server.poolState)
        expect(sdk.getMarketplaceConfig()).toEqual(server.marketplaceConfig ?? emptyMarketplaceConfig())
        const escrow = value => ({ ...value, escrowed: marketplaceOrderIsEscrowed(state.namesByNode.get(value.node), value.marketplaceContractId) })
        expect(sdk.getMarketplaceFixedSales()).toEqual([...server.marketplaceFixedSalesByNode.values()].map(escrow))
        expect(sdk.getMarketplaceAuctions()).toEqual([...server.marketplaceAuctionsByNode.values()].map(escrow))
        expect(sdk.getMarketplaceOffers()).toEqual([...server.marketplaceOffersByKey.values()])
        for (const commitment of server.commitmentsByKey.values()) expect(sdk.getCommitment(commitment.commitment, commitment.controller)).toEqual(commitment)
        for (const referral of server.referralsByReferrer.values()) expect(sdk.getReferralState(referral.referrer)).toEqual(referral)
        for (const offer of server.marketplaceOffersByKey.values()) expect(sdk.getMarketplaceOffer(offer.node, offer.buyerAuthority)).toEqual(offer)
        for (const refund of server.marketplaceRefundsByAuthority.values()) expect(sdk.getMarketplaceRefund(refund.authority)).toEqual(refund)
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('replays the shared event fixture into the server read models', () => {
    const envelopes = createIndexerParityEvents()
    const warnings = []
    const serverStore = replayEventLog(envelopes, warnings, '2026-06-27T12:10:00.000Z')

    expect(warnings).toEqual([])
    const ownCommitment = serverStore.commitmentsByKey.get(commitmentKey(fixtureOwner, fixtureCommitment))
    expect(ownCommitment).toMatchObject({
      commitment: fixtureCommitment,
      node: fixtureNode,
      controller: fixtureOwner,
      status: 'revealed',
      committedTxId: 'commit-tx',
      committedBlockHeight: 10,
    })
    expect(serverStore.commitmentsByKey.get(commitmentKey(fixtureManager, fixtureCommitment))).toMatchObject({
      commitment: fixtureCommitment,
      node: null,
      controller: fixtureManager,
      status: 'committed',
      committedTxId: 'second-commit-tx',
      committedBlockHeight: 12,
    })
    expect(serverStore.commitmentsById.get(fixtureCommitment)).toBe(ownCommitment)
    expect(serverStore.namesByCanonical.get('aurora.dusk')).toMatchObject({
      canonicalName: 'aurora.dusk',
      owner: fixtureOwner,
      resolverId: fixtureNextRecordResolver,
    })
    expect(serverStore.namesByNode.get(fixtureParentNode)).toMatchObject({
      canonicalName: 'archive.dusk',
      expiresAtBlockHeight: null,
      graceEndsAtBlockHeight: null,
      owner: null,
      resolverId: null,
      status: 'released',
    })

    expect(serverStore.recordsByNode.get(fixtureNode)?.map((record) => record.key)).toEqual(['moonlight_address'])
    expect(serverStore.recordHistoryByNodeKey.get(`${fixtureNode}\u0000website`)?.map((entry) => entry.action)).toEqual([
      'clear',
      'set',
    ])

    expect(serverStore.reverseByEndpoint.get(`moonlight_address:${fixtureMoonlightAddress}`) ?? null).toBeNull()

    expect(serverStore.subnamesByNode.get(fixtureSubnameNode) ?? null).toBeNull()
    expect(serverStore.subnamesByParent.get(fixtureNode) ?? []).toEqual([])

    expect(serverStore.treasuryState).toMatchObject({
      availableLux: 0,
      referralClaimableLux: 0,
      referralClaimedLux: 2_000_000_000,
      referralCount: 1,
      claims: [expect.objectContaining({
        amountLux: 8_000_000_000,
        remainingLux: 0,
        txId: 'treasury-claim-tx',
      })],
    })
    expect(serverStore.feeConfig).toMatchObject({
      threeCharYearLux: 2,
      fourCharYearLux: 3,
      fivePlusYearLux: 4,
      referralRewardBps: 5,
      renewalReferralRewardBps: 6,
      premiumReferralRewardBps: 7,
      version: 8,
    })
    expect(serverStore.poolState).toEqual({
      registrationsPaused: false,
      pendingOperator: null,
      initialized: true,
      router: fixtureRouter,
      operator: { kind: 'Phoenix', bytes: Array(32).fill(0x78) },
      treasury: fixtureTreasury,
      marketplace: null,
      registries: [fixtureRegistry, fixtureNextRegistry],
      resolvers: [fixtureRecordResolver, fixtureNextRecordResolver],
      txId: 'router-operator-tx',
      blockHeight: 39,
    })
    expect([...serverStore.referralsByReferrer.values()][0]).toMatchObject({
      claimableLux: 0,
      claimedLux: 2_000_000_000,
      recentActivity: [
        expect.objectContaining({ kind: 'claim', txId: 'referral-claim-tx' }),
        expect.objectContaining({ kind: 'accrual', txId: 'referral-tx' }),
      ],
    })
    expect(activityShape(serverStore.activityByNode.get(fixtureNode))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: 'registration', target: fixtureOwner }),
        expect.objectContaining({ eventType: 'record_update', target: 'moonlight_address' }),
      ]),
    )
    expect(activityShape(serverStore.activityByNode.get(fixtureSubnameNode))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: 'subname_created' }),
        expect.objectContaining({ eventType: 'subname_pruned', target: 'pruned' }),
      ]),
    )
  })
})

function activityShape(entries = []) {
  return entries.map((entry) => ({
    eventType: entry.eventType,
    target: entry.target ?? null,
    txId: entry.txId ?? null,
    blockHeight: entry.blockHeight ?? null,
  }))
}

const eventGroups = {
  controller: controllerEventTypes, lifecycle: lifecycleEventTypes, resolver: resolverEventTypes,
  reverse: reverseEventTypes, subname: subnameEventTypes, treasury: treasuryEventTypes,
  referral: referralEventTypes, feeConfig: feeConfigEventTypes, marketplace: marketplaceEventTypes, pool: poolEventTypes,
}
