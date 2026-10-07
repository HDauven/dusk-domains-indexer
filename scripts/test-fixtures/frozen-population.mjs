// Representative receipt populations shared by publication regressions and the benchmark.
import { recordsDigest } from '@duskdomains/sdk/projection'
import { makeName, moveHistory, envelope, receipt, registered, ref, bytes, sample, order } from './frozen-events.mjs'

export function populationBytes(index, length = 32) {
  const value = Buffer.alloc(length, 12)
  value.writeUInt32LE(index)
  return [...value]
}

export function* populationEntries(size, from = 0) {
  const moved = moveHistory()
  if (from === 0) { yield* moved.events; yield moved.final }
  for (let i = from; i < from + size; i++) {
    const height = BigInt(100 + i), endpoint = populationBytes(i, 96)
    const beneficiary = { kind: 'Contract', bytes: populationBytes(i) }
    const name = { ...makeName(`population${i}.dusk`), referrer: beneficiary,
      expires_at: 50000000n, grace_end: 50300000n }
    const records = [{ key: 'moonlight_address', value: endpoint, ttl_seconds: 300n, updated_at: height },
      { key: 'profile/display', value: [...Buffer.from(`Name ${i}`)], ttl_seconds: 300n, updated_at: height }]
    const snapshot = { records, count: records.length, digest: recordsDigest(records) }
    const listing = order(['Fixed', 'Auction', 'Offer'][i % 3], BigInt(i + 1))
    listing.terms.name = ref(name)
    listing.terms.deadline = height + 100000n
    const effects = [
      [4, 'root_registered', registered(name)],
      [5, 'resolver_slot_written', { slot: { registry: bytes(4), node: name.key.node, epoch: 1n }, snapshot }],
      [4, 'slot_changed', { name: ref(name), previous: null, reason: 'Mutation',
        current: { resolver: bytes(5), epoch: 1n, count: snapshot.count, digest: snapshot.digest } }],
      [4, 'primary_changed', { endpoint, previous: null,
        current: { endpoint, name: ref(name), mapping_id: BigInt(i + 1), updated_at: height }, reason: 'Set' }],
      [2, 'beneficiary_reserved', { beneficiary, reserved_beneficiaries: i + 1 }],
      [2, 'fee_received', { ...sample('FeeReceived'), source: bytes(4), received_lux: '10000000000',
        protocol_lux: String(BigInt(i + 1) * 8000000000n), liability_lux: String(BigInt(i + 1) * 2000000000n),
        beneficiary_claimable_lux: '2000000000', metadata: { ...sample('FeeReceived').metadata,
          beneficiary, reason: 'Registration', name: ref(name), referral_lux: '2000000000' } }],
      [6, 'order_changed', { order: listing }],
    ]
    if (i % 10 === 0) {
      const ticket = { ...moved.ticket, id: populationBytes(i), root: ref(name), row_count: 1,
        created_at: height, expires_at: height + 8640n }
      effects.push([4, 'move_started', { ticket, lifecycle_deadline: name.expires_at }])
      if (i % 20 === 0) effects.push([4, 'move_cancelled', { ticket, reason: 'Owner', cancelled_at: height, cooldown_applied: true }])
    }
    yield envelope(receipt(height, effects))
  }
}
