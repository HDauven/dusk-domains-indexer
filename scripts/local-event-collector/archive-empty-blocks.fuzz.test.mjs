import { afterEach, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { rm } from 'node:fs/promises'
import { id } from '../test-fixtures/frozen-events.mjs'
import { addTransaction, collect, collected, collectorConfig, exampleChain, finalizedArchive, hash, heights, rawEvent, transferContract }
  from '../test-fixtures/finalized-archive.mjs'
import { check, testTimeout } from '../test-fixtures/fuzz-support.mjs'

// Skipping the events of blocks without transactions must never change what the collector
// collects. For any batch size, head and extra transactions (failed, another contract's, our
// contract's reverted events, an out-of-scope market configuring itself or acting) beside the
// example chain's receipts or in its empty blocks, the journal, the market candidate journal and
// the cursor equal those of reading every block's events, and only blocks with transactions are read.
vi.setConfig({ testTimeout })
const dirs = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
const extra = fc.record({ height: fc.integer({ min: 2, max: 44 }), kind: fc.constantFrom('failed', 'foreign', 'reverted', 'market', 'market-other') })

function chain(extras) {
  const blocks = exampleChain()
  for (const [index, { height, kind }] of extras.entries()) {
    const origin = hash(30000 + index), fee = rawEvent(transferContract, 'moonlight', origin)
    const events = {
      failed: [fee],
      foreign: [rawEvent(id(77), 'transfer', origin), fee],
      reverted: [rawEvent(id(4), 'root_registered', origin, { reverted: true }), fee],
      market: [rawEvent(id(79), 'operation_begin', origin), rawEvent(id(79), 'market_configured', origin), rawEvent(id(79), 'operation_end', origin), fee],
      'market-other': [rawEvent(id(79), 'order_placed', origin), fee],
    }[kind]
    addTransaction(blocks, height, { id: origin, err: kind === 'failed' || kind === 'reverted' ? 'Panic' : null, events })
  }
  return blocks
}

it('collects exactly what reading every block collects, for any chain and batch size', async () => {
  await check('collector reads events only for blocks with transactions', fc.asyncProperty(
    fc.integer({ min: 1, max: 12 }), fc.integer({ min: 30, max: 45 }), fc.array(extra, { maxLength: 8 }),
    async (batchSize, head, extras) => {
      const runs = []
      for (const readEvery of [true, false]) {
        const archive = finalizedArchive(chain(extras), { head })
        archive.state.hideTxRoot = readEvery
        const made = await collectorConfig({ batchSize, catchUpPauseMs: 0 }); dirs.push(made.dir)
        const { cursor } = await collect(archive, made.config)
        runs.push({ archive, cursor, result: await collected(made.config) })
      }
      const [every, skipping] = runs
      expect(every.archive.eventReads()).toEqual(heights(1, head))
      expect(skipping.archive.eventReads()).toEqual(skipping.archive.withTransactions())
      expect(skipping.archive.checks()).toEqual(heights(1, head))
      expect(skipping.cursor).toMatchObject({ status: 'running', scannedBlockHeight: head, eventCount: 11 })
      expect(skipping.result).toEqual(every.result)
      // Receipts stay in chain order: by block, then by their first event's position in it.
      const order = skipping.result.journal.trim().split('\n').map(line => JSON.parse(line).meta).map(m => [m.blockHeight, m.eventIndex])
      for (let i = 1; i < order.length; i++) expect(order[i][0] > order[i - 1][0] || order[i][0] === order[i - 1][0] && order[i][1] > order[i - 1][1]).toBe(true)
    }))
})
