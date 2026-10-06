import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'

it('pins the published JSR SDK and imports collector and server entrypoints in plain Node', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url)))
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url)))
  expect(manifest.dependencies['@duskdomains/sdk']).toBe('npm:@jsr/duskdomains__sdk@0.2.0')
  expect(lock.packages['node_modules/@duskdomains/sdk'].resolved).toMatch(/^https:\/\/npm.jsr.io\/.+\/0\.2\.0\.tgz$/)
  const script = `
    import assert from 'node:assert/strict'
    const sdk = await import('@duskdomains/sdk')
    assert.equal(typeof sdk.getRecordDefinition('address.btc').validate, 'function')
    const projection = await import('@duskdomains/sdk/projection')
    assert.equal(typeof projection.normalizeObservedEvent, 'function')
    const catalog = await import('@duskdomains/sdk/event-catalog')
    assert(catalog.duskDomainsContractEventTopics.core.includes('name_registered'))
    await import('./scripts/local-event-collector.mjs')
    await import('./scripts/local-event-collector/archive.mjs')
    await import('./server/local-indexer.mjs')
  `
  expect(() => execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('../', import.meta.url), stdio: 'pipe',
  })).not.toThrow()
})
