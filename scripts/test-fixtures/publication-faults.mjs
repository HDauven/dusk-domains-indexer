import { bytes, envelope, receipt, recordEffects } from './frozen-events.mjs'

// Independent wire-schema mutation deck; deliberately does not import the reader's validator.
const fields = {
  scannedBlockHeight: ['999', -1, 1.5, Number.MAX_SAFE_INTEGER + 1],
  eventCount: ['5', -1, 1.5, Number.MAX_SAFE_INTEGER + 1],
  eventLogBytes: ['0', -1, 1.5, Number.MAX_SAFE_INTEGER + 1],
  scannedBlockHash: [123, '', 'ab'.repeat(31), 'zz'.repeat(32)],
  currentBlockHeight: ['1002', -1, 1.5, Number.MAX_SAFE_INTEGER + 1],
  fromBlock: ['1', 0, 1.5, Number.MAX_SAFE_INTEGER + 1],
  version: ['2', 0, 3],
  source: [1, '', 'w3sper-live-subscription'],
  status: [1, '', 'unknown'],
  updatedAt: [123, '', 'not-a-date', '+999999-01-01T00:00:00.000Z', '2026-02-30T00:00:00.000Z'],
}
export const cursorMutations = Object.entries(fields).flatMap(([field, values]) => [
  { label: `${field}:missing`, field, mutate: c => { delete c[field] } },
  ...[null, ...values].map((value, index) => ({ label: `${field}:${index === 0 ? 'null' : JSON.stringify(value)}`, field,
    mutate: c => { c[field] = value } })),
])
export const cursorRelations = [
  { label: 'tip-below-finalized', field: 'currentBlockHeight', mutate: c => { c.currentBlockHeight = c.scannedBlockHeight - 1 } },
  { label: 'start-above-finalized', field: 'fromBlock', mutate: c => { c.fromBlock = c.scannedBlockHeight + 2 } },
]
export const finalizationFaults = ['missing-snapshot', 'mismatched-digest'].map(label => ({ label, row: () => {
  const effects = recordEffects('https://unpublished.example', 4, 5, 99n)
  if (label === 'missing-snapshot') effects.shift()
  else effects[1][2].current.digest = bytes(0)
  return envelope(receipt(999, effects, `finalization-${label}`))
} }))
