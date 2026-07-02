import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  activeContractKeys,
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
  it('exports the production core/treasury key set and legacy split-contract key set', () => {
    expect(activeContractKeys).toEqual(['core', 'treasury'])
    expect(legacyContractKeys).toEqual(['registry', 'registrar', 'controller', 'resolver', 'reverse'])
  })

  it('normalizes contract ids strictly', () => {
    expect(normalizeContractId(`0x${'AB'.repeat(32)}`)).toBe(`0x${'ab'.repeat(32)}`)
    expect(normalizeContractId(`${'cd'.repeat(32)}`)).toBe(`0x${'cd'.repeat(32)}`)
    expect(normalizeContractId('0x1234')).toBe('')
    expect(isContractId(`0x${'12'.repeat(32)}`)).toBe(true)
    expect(isContractId(`${'12'.repeat(32)}`)).toBe(false)
  })

  it('passes when env and proof report bind only core and treasury contracts', async () => {
    const fixture = await writeSurfaceFixture()
    await expect(loadDeploymentSurface(fixture.envFile, fixture.proofReport)).resolves.toEqual({
      ok: true,
      contracts: {
        core: `0x${'11'.repeat(32)}`,
        treasury: `0x${'22'.repeat(32)}`,
      },
      reportContracts: {
        core: `0x${'11'.repeat(32)}`,
        treasury: `0x${'22'.repeat(32)}`,
      },
      message: 'deployment surface ready',
    })
  })

  it('accepts legacy Dusk Names env prefixes for active core/treasury aliases', async () => {
    const fixture = await writeSurfaceFixture({ legacyActiveEnv: true })
    const result = await loadDeploymentSurface(fixture.envFile, fixture.proofReport)
    expect(result.ok).toBe(true)
    expect(result.contracts.core).toBe(`0x${'11'.repeat(32)}`)
    expect(result.contracts.treasury).toBe(`0x${'22'.repeat(32)}`)
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
    expect(result.message).toContain('env/proof contract mismatch: treasury')
    expect(result.message).toContain('legacy env keys:')
    expect(result.message).toContain('legacy proof contract keys: resolver')
    expect(result.message).toContain('unexpected proof contract keys: resolver, extra')
    expect(result.message).toContain('proof report is not passing')
  })
})

async function writeSurfaceFixture({
  envCore = `0x${'11'.repeat(32)}`,
  envTreasury = `0x${'22'.repeat(32)}`,
  proofCore = `0x${'11'.repeat(32)}`,
  proofTreasury = `0x${'22'.repeat(32)}`,
  proofOk = true,
  legacyActiveEnv = false,
  legacySplitEnv = false,
  legacyProofKey = false,
  extraProofKey = false,
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dusk-domains-deployment-surface-'))
  tempDirs.push(dir)
  const envFile = join(dir, '.env')
  const proofReport = join(dir, 'proof.json')
  const prefix = legacyActiveEnv ? 'VITE_DUSK_NAMES' : 'VITE_DUSK_DOMAINS'
  await writeFile(envFile, [
    `${prefix}_CORE_CONTRACT_ID=${envCore}`,
    `${prefix}_TREASURY_CONTRACT_ID=${envTreasury}`,
    legacySplitEnv ? `VITE_DUSK_DOMAINS_REGISTRY_CONTRACT_ID=0x${'44'.repeat(32)}` : '',
  ].filter(Boolean).join('\n'), 'utf8')
  await writeFile(proofReport, JSON.stringify({
    ok: proofOk,
    publicContracts: {
      core: proofCore,
      treasury: proofTreasury,
      ...(legacyProofKey ? { resolver: `0x${'55'.repeat(32)}` } : {}),
      ...(extraProofKey ? { extra: `0x${'66'.repeat(32)}` } : {}),
    },
  }, null, 2), 'utf8')
  return { dir, envFile, proofReport }
}
