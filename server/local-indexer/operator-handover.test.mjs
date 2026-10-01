import { describe, expect, it } from 'vitest'
import { normalizeObservedEvent } from '../../scripts/indexer-operator/event-decoder.mjs'
import { bytesToBase58 } from '../../scripts/indexer-operator/event-value-codecs.mjs'
import { replayEventLog } from './event-log-store.mjs'
import { normalizeTreasuryState } from './economics/treasury.mjs'

const bytes = (byte, length = 32) => Array(length).fill(byte)
const principal = (byte) => ({ kind: 'Contract', bytes: bytes(byte) })
const hex = (byte) => `0x${byte.toString(16).padStart(2, '0').repeat(32)}`
const observedAt = '2026-10-01T00:00:00.000Z'

describe('operator handover event ingestion', () => {
  for (const key of ['router', 'treasury', 'marketplace']) {
    it(`decodes and replays the ${key} handover without changing authority on proposal`, () => {
      const rawOperator = key === 'marketplace' ? bytes(1) : principal(1)
      const rawNext = key === 'marketplace' ? bytes(2) : principal(2)
      const rawReplacement = key === 'marketplace' ? bytes(3) : principal(3)
      const operator = key === 'marketplace' ? hex(1) : principal(1)
      const next = key === 'marketplace' ? hex(2) : principal(2)
      const replacement = key === 'marketplace' ? hex(3) : principal(3)
      const events = []
      const apply = (name, event) => {
        const normalized = normalizeObservedEvent({
          contract: { key, contractId: hex(9) }, eventName: name, event,
          observedAt, observedBlockHeight: events.length + 1,
        })
        expect(normalized).not.toBeNull()
        events.push({ ...normalized, meta: { ...normalized.meta, blockHeight: events.length + 1, txId: `tx-${events.length + 1}` } })
      }
      const read = () => {
        const warnings = []
        const store = replayEventLog(events, warnings, observedAt)
        expect(warnings).toEqual([])
        return key === 'router' ? store.poolState : key === 'treasury' ? store.treasuryState : store.marketplaceConfig
      }
      apply(`${key}_initialized`, {
        operator: rawOperator, treasury: bytes(8), marketplace: bytes(7), fee_config: {},
        router: bytes(9), treasury_contract: bytes(8), marketplace_authority: bytes(7), fee_bps: 250,
        operator_recipient: bytes(4, 96), allowed_fee_sources: [],
      })
      expect(read()).toMatchObject({ operator, pendingOperator: null })
      const propose = (pending, recipient = 5) => apply(`${key}_operator_proposed`, {
        operator: rawOperator, pending_operator: pending, pending_operator_recipient: bytes(recipient, 96),
      })
      propose(rawNext)
      expect(read()).toMatchObject({ operator, pendingOperator: next, blockHeight: 2 })
      propose(rawReplacement, 6)
      expect(read()).toMatchObject({ operator, pendingOperator: replacement })
      if (key === 'treasury') {
        const state = read()
        expect(state).toMatchObject({ operatorRecipient: bytesToBase58(bytes(4, 96)), pendingOperatorRecipient: bytesToBase58(bytes(6, 96)) })
        expect(normalizeTreasuryState(state)).toEqual(state)
        apply('treasury_claimed', { operator: rawOperator, operator_recipient: bytes(4, 96), amount_lux: 1, remaining_lux: 9 })
        expect(read().pendingOperator).toEqual(replacement)
        expect(read().claims).toHaveLength(1)
      }
      if (key === 'marketplace') {
        apply('marketplace_config_updated', { operator: rawOperator, previous_operator: rawOperator, fee_bps: 300, previous_fee_bps: 250, updated_at: 4 })
        expect(read().pendingOperator).toEqual(replacement)
      }
      apply(`${key}_operator_cancelled`, { operator: rawOperator })
      expect(read()).toMatchObject({ operator, pendingOperator: null })
      if (key === 'treasury') expect(read().pendingOperatorRecipient).toBeNull()
      propose(rawNext)
      apply(`${key}_operator_changed`, { previous_operator: rawOperator, operator: rawNext, operator_recipient: bytes(5, 96) })
      expect(read()).toMatchObject({ operator: next, pendingOperator: null, txId: `tx-${events.length}` })
      if (key === 'treasury') expect(read()).toMatchObject({ operatorRecipient: bytesToBase58(bytes(5, 96)), pendingOperatorRecipient: null })
      if (key === 'marketplace') {
        apply('marketplace_config_updated', { operator: rawNext, previous_operator: rawOperator, fee_bps: 300, previous_fee_bps: 300, updated_at: 9 })
        expect(read()).toMatchObject({ operator: next, pendingOperator: null, feeBps: 300 })
      }
    })
  }
})
