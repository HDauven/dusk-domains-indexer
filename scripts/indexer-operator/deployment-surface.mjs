import { readFile } from 'node:fs/promises'
import { envValue, parseEnvFile } from '../env-file.mjs'

export const activeContractKeys = Object.freeze(['directory', 'policy', 'store', 'vault', 'resolver', 'marketplace'])
export const eventContractKeys = activeContractKeys
export const legacyContractKeys = Object.freeze(['router', 'core', 'treasury', 'registry', 'registrar', 'controller', 'reverse'])

export async function loadDeploymentSurface(envFile, proofReport) {
  const env = parseEnvFile(await readFile(envFile, 'utf8'))
  const report = JSON.parse(await readFile(proofReport, 'utf8'))
  const envContracts = Object.fromEntries(activeContractKeys.map(key => [key, normalizeContractId(envValue(env, `${key.toUpperCase()}_CONTRACT_ID`))]))
  const reportContracts = normalizeContractMap(report.publicContracts ?? report.contractIds ?? report.contracts ?? {})
  const legacyEnvKeys = Object.keys(env).filter((key) => legacyContractKeys.some((contract) => key.includes(`_${contract.toUpperCase()}_CONTRACT_ID`) || key.includes(`_${contract.toUpperCase()}_DRIVER_URL`)))
  const missing = activeContractKeys.filter((key) => !isContractId(envContracts[key]) || !isContractId(reportContracts[key]))
  const mismatched = activeContractKeys.filter((key) => isContractId(envContracts[key]) && isContractId(reportContracts[key]) && envContracts[key] !== reportContracts[key])
  const reportKeys = Object.keys(reportContracts)
  const legacyReportKeys = reportKeys.filter((key) => legacyContractKeys.includes(key))
  const extraReportKeys = reportKeys.filter((key) => !activeContractKeys.includes(key))
  // This is an identity binding check, not a replacement for the protocol release verifier.
  const verified = report.schema === 'dusk-domains/frozen-release/v1' ? report.status === 'verified' : report.ok === true
  const ok = missing.length === 0 && mismatched.length === 0 && legacyEnvKeys.length === 0 && legacyReportKeys.length === 0 && extraReportKeys.length === 0 && verified
  return {
    ok,
    contracts: envContracts,
    reportContracts,
    message: ok
      ? 'deployment surface ready'
      : [
          missing.length ? `missing active contract IDs: ${missing.join(', ')}` : '',
          mismatched.length ? `env/proof contract mismatch: ${mismatched.join(', ')}` : '',
          legacyEnvKeys.length ? `legacy env keys: ${legacyEnvKeys.join(', ')}` : '',
          legacyReportKeys.length ? `legacy proof contract keys: ${legacyReportKeys.join(', ')}` : '',
          extraReportKeys.length ? `unexpected proof contract keys: ${extraReportKeys.join(', ')}` : '',
          verified ? '' : 'proof report is not passing',
        ].filter(Boolean).join('; '),
  }
}

export function normalizeContractId(value) {
  const text = String(value ?? '').trim().replace(/^0x/i, '').toLowerCase()
  return /^[0-9a-f]{64}$/u.test(text) ? `0x${text}` : ''
}

export function isContractId(value) {
  return /^0x[0-9a-f]{64}$/u.test(String(value ?? ''))
}

function normalizeContractMap(value) {
  return Object.fromEntries((Array.isArray(value) ? value.map(c => [c.key, c.id]) : Object.entries(value ?? {})).map(([key, entry]) => [key, normalizeContractId(entry)]))
}
