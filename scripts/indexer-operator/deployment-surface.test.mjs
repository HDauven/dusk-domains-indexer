import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  activeContractKeys,
  eventContractKeys,
  isContractId,
  legacyContractKeys,
  loadDeploymentSurface,
  normalizeContractId,
} from './deployment-surface.mjs'

const tempDirs = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('indexer deployment surface proof', () => {
  it('exports the production contract key set and legacy split-contract key set', () => {
    expect(activeContractKeys).toEqual(['directory', 'policy', 'store', 'vault', 'resolver', 'marketplace'])
    expect(eventContractKeys).toEqual(['directory', 'policy', 'store', 'vault', 'resolver', 'marketplace'])
    expect(legacyContractKeys).toEqual(['router', 'core', 'treasury', 'registry', 'registrar', 'controller', 'reverse'])
  })

  it('normalizes contract ids strictly', () => {
    expect(normalizeContractId(`0x${'AB'.repeat(32)}`)).toBe(`0x${'ab'.repeat(32)}`)
    expect(normalizeContractId(`${'cd'.repeat(32)}`)).toBe(`0x${'cd'.repeat(32)}`)
    expect(normalizeContractId('0x1234')).toBe('')
    expect(isContractId(`0x${'12'.repeat(32)}`)).toBe(true)
    expect(isContractId(`${'12'.repeat(32)}`)).toBe(false)
  })

  it('passes when env and proof report bind the complete production stack', async () => {
    const fixture = await writeSurfaceFixture()
    await expect(loadDeploymentSurface(fixture.envFile, fixture.proofReport)).resolves.toEqual({
      ok: true,
      contracts: {
        directory: `0x${'aa'.repeat(32)}`,
        policy: `0x${'cc'.repeat(32)}`,
        store: `0x${'11'.repeat(32)}`,
        resolver: `0x${'bb'.repeat(32)}`,
        vault: `0x${'22'.repeat(32)}`,
        marketplace: `0x${'33'.repeat(32)}`,
      },
      reportContracts: {
        directory: `0x${'aa'.repeat(32)}`,
        policy: `0x${'cc'.repeat(32)}`,
        store: `0x${'11'.repeat(32)}`,
        resolver: `0x${'bb'.repeat(32)}`,
        vault: `0x${'22'.repeat(32)}`,
        marketplace: `0x${'33'.repeat(32)}`,
      },
      message: 'deployment surface ready',
    })
  })

  it('uses the same quoted values and inline comments as collector env files', async () => {
    const fixture = await writeSurfaceFixture({
      envCore: `"0x${'11'.repeat(32)}" # core`,
      envTreasury: `'0x${'22'.repeat(32)}' # treasury`,
      envMarketplace: `0x${'33'.repeat(32)} # marketplace`,
    })
    await expect(loadDeploymentSurface(fixture.envFile, fixture.proofReport)).resolves.toMatchObject({ ok: true })
  })

  it('rejects mismatches, legacy split-contract env keys, and stale proof report keys', async () => {
    const fixture = await writeSurfaceFixture({
      envTreasury: `0x${'33'.repeat(32)}`,
      legacySplitEnv: true,
      legacyProofKey: true,
      extraProofKey: true,
      proofOk: false,
    })
    const result = await loadDeploymentSurface(fixture.envFile, fixture.proofReport)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('env/proof contract mismatch: vault')
    expect(result.message).toContain('legacy env keys:')
    expect(result.message).toContain('legacy proof contract keys: registrar')
    expect(result.message).toContain('unexpected proof contract keys: registrar, extra')
    expect(result.message).toContain('proof report is not passing')
  })
})

async function writeSurfaceFixture({
  envCore = `0x${'11'.repeat(32)}`,
  envTreasury = `0x${'22'.repeat(32)}`,
  envMarketplace = `0x${'33'.repeat(32)}`,
  proofCore = `0x${'11'.repeat(32)}`,
  proofTreasury = `0x${'22'.repeat(32)}`,
  proofMarketplace = `0x${'33'.repeat(32)}`,
  proofOk = true,
  legacySplitEnv = false,
  legacyProofKey = false,
  extraProofKey = false,
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dusk-domains-deployment-surface-'))
  tempDirs.push(dir)
  const envFile = join(dir, '.env')
  const proofReport = join(dir, 'proof.json')
  await writeFile(envFile, [
    `DUSK_DOMAINS_DIRECTORY_CONTRACT_ID=0x${'aa'.repeat(32)}`,
    `DUSK_DOMAINS_POLICY_CONTRACT_ID=0x${'cc'.repeat(32)}`,
    `VITE_DUSK_DOMAINS_STORE_CONTRACT_ID=${envCore}`,
    `VITE_DUSK_DOMAINS_RESOLVER_CONTRACT_ID=0x${'bb'.repeat(32)}`,
    `VITE_DUSK_DOMAINS_VAULT_CONTRACT_ID=${envTreasury}`,
    `VITE_DUSK_DOMAINS_MARKETPLACE_CONTRACT_ID=${envMarketplace}`,
    legacySplitEnv ? `VITE_DUSK_DOMAINS_REGISTRY_CONTRACT_ID=0x${'44'.repeat(32)}` : '',
  ].filter(Boolean).join('\n'), 'utf8')
  await writeFile(proofReport, JSON.stringify({
    ok: proofOk,
    publicContracts: {
      directory: `0x${'aa'.repeat(32)}`,
        policy: `0x${'cc'.repeat(32)}`,
      store: proofCore,
      resolver: `0x${'bb'.repeat(32)}`,
      vault: proofTreasury,
      marketplace: proofMarketplace,
      ...(legacyProofKey ? { registrar: `0x${'55'.repeat(32)}` } : {}),
      ...(extraProofKey ? { extra: `0x${'66'.repeat(32)}` } : {}),
    },
  }, null, 2), 'utf8')
  return { dir, envFile, proofReport }
}

it('accepts deployment-tool manifest and proof contract ID shapes while checking status', async () => {
  const fixture = await writeSurfaceFixture()
  const ids = JSON.parse(await readFile(fixture.proofReport)).publicContracts
  await writeFile(fixture.proofReport, JSON.stringify({ schema: 'dusk-domains/frozen-proof/v1', ok: true, contractIds: ids }))
  expect((await loadDeploymentSurface(fixture.envFile, fixture.proofReport)).ok).toBe(true)
  const manifest = { schema: 'dusk-domains/frozen-release/v1', status: 'verified', contracts: Object.entries(ids).map(([key, id]) => ({ key, id })) }
  await writeFile(fixture.proofReport, JSON.stringify(manifest))
  expect((await loadDeploymentSurface(fixture.envFile, fixture.proofReport)).ok).toBe(true)
  manifest.status = 'planned'
  await writeFile(fixture.proofReport, JSON.stringify(manifest))
  expect((await loadDeploymentSurface(fixture.envFile, fixture.proofReport)).ok).toBe(false)
})
