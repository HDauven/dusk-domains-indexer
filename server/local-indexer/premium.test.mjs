import { commitJournal } from '../../scripts/test-fixtures/committed-cursor.mjs'
import { expect, it } from 'vitest'
import { dirname, join } from 'node:path'
import { registrationPremiumSchedule, launchPolicyConfig } from '@duskdomains/sdk'
import { replayEventLog } from './event-log-store.mjs'
import { premiumForName } from './read-models/premium.mjs'
import { searchName } from './read-models/search.mjs'
import { createEventLog, rootNode } from '../../scripts/test-fixtures/frozen-events.mjs'
import { createIncrementalSqliteStore } from './incremental-sqlite-store.mjs'
import { writeEventLog } from '../local-indexer-test-helpers.mjs'
it.each([0,1,20,21])('uses the published policy premium at day %s after release', day => {
  const height = 2000 + day * 8640, warnings = [], view = replayEventLog(createEventLog(), warnings, new Date().toISOString(), height)
  view.cursor = { scannedBlockHeight: height, currentBlockHeight: height }
  const premium = premiumForName(view, view.namesByNode.get(rootNode))
  const expected = registrationPremiumSchedule({ premiumStartLux: launchPolicyConfig().premium_start_lux, graceEndsAtBlockHeight: 2000n, currentBlockHeight: BigInt(height) })
  expect(warnings).toEqual([])
  expect(premium.premiumLux).toBe(expected.premiumLux)
  expect(searchName(view, 'aurora').premiumLux).toBe(expected.premiumLux)
})
it('uses launch prices and reserves public root minimum independently of structural sublabels', () => {
  const view = replayEventLog(createEventLog(), [], new Date().toISOString(), 20)
  expect(searchName(view, 'abc').price).toBe(150)
  expect(searchName(view, 'abcd').price).toBe(50)
  expect(searchName(view, 'abcde').price).toBe(10)
  expect(searchName(view, 'ab')).toMatchObject({ status: 'invalid', transactionBlocked: true })
  expect(searchName(view, 'x.aurora')).toMatchObject({ status: 'registered' })
})
it('refreshes expiry and automatic move locks from cursor progression without reapplying receipts', async () => {
  const eventLogFile = await writeEventLog(createEventLog()), cursorFile = await commitJournal(eventLogFile, { scannedBlockHeight: 999, currentBlockHeight: 999 })
  const provider = await createIncrementalSqliteStore({ file: join(dirname(eventLogFile), 'premium.sqlite'), eventLogFile, cursorFile })
  try {
    expect((await provider()).namesByNode.get(rootNode).status).toBe('active')
    await commitJournal(eventLogFile, { scannedBlockHeight: 1000, currentBlockHeight: 1000 }, cursorFile)
    expect((await provider()).namesByNode.get(rootNode).status).toBe('grace')
    await commitJournal(eventLogFile, { scannedBlockHeight: 2000, currentBlockHeight: 2000 }, cursorFile)
    expect((await provider()).namesByCanonical.size).toBe(0)
    expect(provider.indexer.stats.appliedEvents).toBe(5)
  } finally { provider.indexer.close() }
})
