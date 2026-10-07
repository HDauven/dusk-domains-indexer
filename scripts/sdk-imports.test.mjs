import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'

it('pins the published 0.3.0 SDK and imports collector and server entrypoints in plain Node', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url)))
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url)))
  expect(manifest.dependencies['@duskdomains/sdk']).toBe('npm:@jsr/duskdomains__sdk@0.3.0')
  expect(lock.packages[''].dependencies['@duskdomains/sdk']).toBe(manifest.dependencies['@duskdomains/sdk'])
  expect(lock.packages['node_modules/@duskdomains/sdk']).toMatchObject({
    name: '@jsr/duskdomains__sdk', version: '0.3.0',
    resolved: 'https://npm.jsr.io/~/11/@jsr/duskdomains__sdk/0.3.0.tgz',
  })
  const script = `
    import assert from 'node:assert/strict'
    const sdk = await import('@duskdomains/sdk')
    assert.equal(typeof sdk.validateRecordValue, 'function')
    const projection = await import('@duskdomains/sdk/projection')
    assert.equal(typeof projection.projectReceipt, 'function')
    assert.equal(typeof projection.snapshotProjection, 'function')
    assert.equal(typeof projection.restoreProjection, 'function')
    const catalog = await import('@duskdomains/sdk/event-catalog')
    assert.equal(catalog.indexerEventCatalog.root_registered.role, 'store')
    for (const entry of ['connect-app', 'indexer', 'marketplace', 'writes', 'chain-addresses']) await import('@duskdomains/sdk/' + entry)
    await import('./scripts/local-event-collector.mjs')
    await import('./scripts/local-event-collector/archive.mjs')
    await import('./server/local-indexer.mjs')
  `
  expect(() => execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('../', import.meta.url), stdio: 'pipe', env: { ...process.env, NODE_OPTIONS: '' },
  })).not.toThrow()
})
