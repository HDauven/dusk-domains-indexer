import { afterEach, describe, expect, it } from 'vitest'
import { readFile, rm } from 'node:fs/promises'
import { id } from '../test-fixtures/frozen-events.mjs'
import { collect, collected, collectorConfig, emptyTxRoot, exampleChain, finalizedArchive, heights } from '../test-fixtures/finalized-archive.mjs'

const dirs = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
const config = async (overrides = {}) => {
  const made = await collectorConfig(overrides)
  dirs.push(made.dir)
  return made.config
}
const receiptHeights = journal => journal.trim().split('\n').filter(Boolean).map(line => JSON.parse(line).meta.blockHeight)

// What the collector collects when it reads every block's events: the archive answers headers
// without a transaction root, so no block can be skipped.
async function readingEveryBlock(head = 40) {
  const archive = finalizedArchive(exampleChain(), { head })
  archive.state.hideTxRoot = true
  const c = await config({ catchUpPauseMs: 0 })
  await collect(archive, c)
  expect(archive.eventReads()).toEqual(heights(1, head))
  return collected(c)
}

describe('reading contract events only for blocks with transactions', () => {
  it('reads no events for a block without transactions, and every block with one, failed ones included', async () => {
    const archive = finalizedArchive(exampleChain(), { head: 40 }), c = await config()
    const { cursor } = await collect(archive, c)
    expect(cursor).toMatchObject({ status: 'running', scannedBlockHeight: 40, eventCount: 11 })
    expect(archive.eventReads()).toEqual([1, 5, 7, 10, 11, 12, 14, 15, 20, 21, 22, 23, 25, 26, 30])
    expect(archive.eventReads()).toEqual(archive.withTransactions())
    // Every block is still checked with the archive and linked into the chain.
    expect(archive.checks()).toEqual(heights(1, 40))
    const result = await collected(c)
    expect(result).toEqual(await readingEveryBlock())
    expect(receiptHeights(result.journal)).toEqual([1, 10, 11, 12, 14, 15, 20, 21, 22, 23, 30])
    // The out-of-scope market configuration in block 26 is retained.
    expect(result.candidates).toContain(`"source":"${id(78)}"`)
  })

  it.each([1, 2, 3, 4, 5, 7, 10, 100])('collects exactly what reading every block collects, %i blocks per batch', async batchSize => {
    const archive = finalizedArchive(exampleChain(), { head: 40 }), c = await config({ batchSize, catchUpPauseMs: 0 })
    await collect(archive, c)
    expect(archive.ranges()).toEqual(heights(0, Math.ceil(40 / batchSize) - 1).map(i => [i * batchSize + 1, Math.min(40, (i + 1) * batchSize)]))
    // At 5 per batch, receipts sit in the first (1, 11, 21) and last (10, 15, 20, 30) block of a batch.
    expect(archive.eventReads()).toEqual(archive.withTransactions())
    expect(await collected(c)).toEqual(await readingEveryBlock())
  })

  it('reads a block whose header root is zero while it lists a transaction, and collects its receipt', async () => {
    const archive = finalizedArchive(exampleChain(), { head: 40 }), c = await config()
    archive.state.overrides.set(12, block => { block.header.txRoot = emptyTxRoot })
    await collect(archive, c)
    expect(archive.eventReads()).toContain(12)
    expect(await collected(c)).toEqual(await readingEveryBlock())
  })

  it('reads a block that lists no transaction under a nonzero root, and stops there when its events name one', async () => {
    const archive = finalizedArchive(exampleChain(), { head: 11 }), c = await config()
    await collect(archive, c)
    const before = await readFile(c.eventLog, 'utf8')
    archive.state.head = 40
    archive.state.overrides.set(12, block => { block.transactions = [] })
    const { cursor } = await collect(archive, c)
    expect(archive.eventReads()).toContain(12)
    expect(cursor).toMatchObject({ status: 'blocked', scannedBlockHeight: 11, blocked: { code: 'archive_unavailable', height: 12 },
      reason: expect.stringContaining('unknown origin at 12') })
    expect(await readFile(c.eventLog, 'utf8')).toBe(before)
  })

  it.each([
    ['without a transaction list', block => { delete block.transactions }, 'blocked'],
    ['with a null transaction list', block => { block.transactions = null }, 'blocked'],
    ['with an object for a transaction list', block => { block.transactions = {} }, 'blocked'],
    ['with a string for a transaction list', block => { block.transactions = 'none' }, 'blocked'],
    ['without a transaction root', block => { delete block.header.txRoot }, 'running'],
    ['with a null transaction root', block => { block.header.txRoot = null }, 'running'],
    ['with a numeric transaction root', block => { block.header.txRoot = 0 }, 'running'],
    ['with a 0x-prefixed zero root', block => { block.header.txRoot = '0x' + emptyTxRoot }, 'running'],
    ['with a short zero root', block => { block.header.txRoot = emptyTxRoot.slice(1) }, 'running'],
    ['with a nonzero root', block => { block.header.txRoot = 'ab'.repeat(32) }, 'running'],
  ])('reads the events of an empty block %s', async (_label, change, status) => {
    const archive = finalizedArchive(exampleChain(), { head: 12 }), c = await config()
    await collect(archive, c)
    const before = await readFile(c.eventLog, 'utf8')
    archive.state.head = 40
    archive.state.overrides.set(13, change)
    const { cursor } = await collect(archive, c)
    expect(archive.eventReads()).toContain(13)
    if (status === 'blocked') {
      // As before this change: events it cannot order by transaction stop collection at that block.
      expect(cursor).toMatchObject({ status: 'blocked', scannedBlockHeight: 12, blocked: { code: 'archive_unavailable', height: 13 },
        reason: 'Archive events unavailable at 13' })
      expect(await readFile(c.eventLog, 'utf8')).toBe(before)
    } else {
      expect(cursor).toMatchObject({ status: 'running', scannedBlockHeight: 40 })
      expect(await collected(c)).toEqual(await readingEveryBlock())
    }
  })

  it('reads every block of an event-batch archive, as before', async () => {
    const archive = finalizedArchive(exampleChain(), { head: 40, api: 'event-batch' }), c = await config({ batchSize: 7, catchUpPauseMs: 0 })
    const { cursor } = await collect(archive, c)
    expect(cursor).toMatchObject({ status: 'running', scannedBlockHeight: 40, eventCount: 11 })
    expect(archive.eventReads()).toEqual(heights(1, 40))
    expect(archive.state.queries.filter(q => q.includes('blocks(range:')).every(q => !q.includes('transactions') && !q.includes('txRoot'))).toBe(true)
  })
})

describe('chain checks around skipped blocks', () => {
  it('checks every block, empty ones included, and stops before one the archive has not finalized', async () => {
    const archive = finalizedArchive(exampleChain(), { head: 40 }), c = await config()
    archive.state.unfinalized.add(16)
    const first = await collect(archive, c)
    expect(first.cursor).toMatchObject({ status: 'catching-up', scannedBlockHeight: 15, reason: 'Archive has not finalized block 16 yet' })
    expect(first.waits).toEqual([{ ms: 5000, status: 'catching-up', scanned: 15 }])
    expect(archive.checks()).toEqual(heights(1, 40))
    expect(archive.eventReads()).toEqual(archive.withTransactions(15))
    archive.state.unfinalized.delete(16)
    expect((await collect(archive, c)).cursor).toMatchObject({ status: 'running', scannedBlockHeight: 40 })
    expect(await collected(c)).toEqual(await readingEveryBlock())
  })

  it.each([
    ['a broken hash chain among empty blocks', archive => { archive.state.prevBlockHash.set(35, 'ee'.repeat(32)) }, 'Broken block hash chain',
      archive => { archive.state.prevBlockHash.clear() }],
    ['another finalized head', archive => { archive.state.finalizedHash = 'ee'.repeat(32) }, 'Finalized head hash mismatch',
      archive => { archive.state.finalizedHash = null }],
  ])('refuses %s without reading or publishing anything, then resumes', async (_label, fault, message, repair) => {
    const archive = finalizedArchive(exampleChain(), { head: 30 }), c = await config()
    await collect(archive, c)
    const before = await readFile(c.eventLog, 'utf8'), reads = archive.eventReads().length, checks = archive.checks().length
    archive.state.head = 40
    fault(archive)
    expect((await collect(archive, c)).cursor).toMatchObject({ status: 'blocked', scannedBlockHeight: 30,
      blocked: { code: 'chain_mismatch', height: 31 }, reason: expect.stringContaining(message) })
    expect([archive.eventReads().length, archive.checks().length]).toEqual([reads, checks])
    expect(await readFile(c.eventLog, 'utf8')).toBe(before)
    repair(archive)
    expect((await collect(archive, c)).cursor).toMatchObject({ status: 'running', scannedBlockHeight: 40 })
    expect(await collected(c)).toEqual(await readingEveryBlock())
  })

  it('refuses to resume when the committed block changed', async () => {
    const archive = finalizedArchive(exampleChain(), { head: 30 }), c = await config()
    await collect(archive, c)
    archive.state.anchorHash.set(30, 'ee'.repeat(32))
    await expect(collect(archive, c)).rejects.toThrow('Committed block hash changed')
  })
})
