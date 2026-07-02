import { describe, expect, it } from 'vitest'
import {
  duskDomainsIndexedEventTypes,
} from '../../src/names/indexerEventCatalog.mjs'
import { replayEventLog } from './event-log-store.mjs'
import {
  createIndexerParityEvents,
  fixtureCommitment,
  fixtureMoonlightAddress,
  fixtureNode,
  fixtureOwner,
  fixtureParentNode,
  fixtureSubnameNode,
} from '../../scripts/test-fixtures/indexer-events.mjs'

describe('local indexer projector parity', () => {
  it('covers every shared Dusk Domains event type in the parity fixture', () => {
    const fixtureEventTypes = new Set(createIndexerParityEvents().map((envelope) => envelope.event.type))

    expect(duskDomainsIndexedEventTypes.filter((type) => !fixtureEventTypes.has(type))).toEqual([])
  })

  it('replays the shared event fixture into the server read models', () => {
    const envelopes = createIndexerParityEvents()
    const warnings = []
    const serverStore = replayEventLog(envelopes, warnings, '2026-06-27T12:10:00.000Z')

    expect(warnings).toEqual([])
    expect(serverStore.commitmentsById.get(fixtureCommitment)).toMatchObject({
      commitment: fixtureCommitment,
      node: fixtureNode,
      controller: fixtureOwner,
    })
    expect(serverStore.namesByCanonical.get('aurora.dusk')).toMatchObject({
      canonicalName: 'aurora.dusk',
      owner: fixtureOwner,
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

    const endpoint = {
      type: 'moonlight_address',
      value: fixtureMoonlightAddress,
    }
    expect(serverStore.reverseByEndpoint.get(`moonlight_address:${fixtureMoonlightAddress}`) ?? null).toBeNull()
    expect(endpoint.type).toBe('moonlight_address')

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
        expect.objectContaining({ eventType: 'subname_revoked', target: 'revoked' }),
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
