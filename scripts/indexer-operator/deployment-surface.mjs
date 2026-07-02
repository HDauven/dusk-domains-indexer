import { readFile } from 'node:fs/promises'

const preferredEnvPrefix = 'VITE_DUSK_DOMAINS'
const legacyEnvPrefix = 'VITE_DUSK_NAMES'

export const activeContractKeys = Object.freeze(['core', 'treasury'])
export const legacyContractKeys = Object.freeze(['registry', 'registrar', 'controller', 'resolver', 'reverse'])

export async function loadDeploymentSurface(envFile, proofReport) {
  const env = parseEnv(await readFile(envFile, 'utf8'))
  const report = JSON.parse(await readFile(proofReport, 'utf8'))
  const envContracts = {
    core: normalizeContractId(envValue(env, 'CORE_CONTRACT_ID')),
    treasury: normalizeContractId(envValue(env, 'TREASURY_CONTRACT_ID')),
  }
  const reportContracts = normalizeContractMap(report.publicContracts ?? report.contracts ?? {})
  const legacyEnvKeys = Object.keys(env).filter((key) => legacyContractKeys.some((contract) => key.includes(`_${contract.toUpperCase()}_CONTRACT_ID`) || key.includes(`_${contract.toUpperCase()}_DRIVER_URL`)))
  const missing = activeContractKeys.filter((key) => !isContractId(envContracts[key]) || !isContractId(reportContracts[key]))
  const mismatched = activeContractKeys.filter((key) => isContractId(envContracts[key]) && isContractId(reportContracts[key]) && envContracts[key] !== reportContracts[key])
  const reportKeys = Object.keys(reportContracts)
  const legacyReportKeys = reportKeys.filter((key) => legacyContractKeys.includes(key))
  const extraReportKeys = reportKeys.filter((key) => !activeContractKeys.includes(key))
  const ok = missing.length === 0 && mismatched.length === 0 && legacyEnvKeys.length === 0 && legacyReportKeys.length === 0 && extraReportKeys.length === 0 && report.ok === true
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
          report.ok === true ? '' : 'proof report is not passing',
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

function parseEnv(text) {
  return Object.fromEntries(String(text ?? '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const [key, ...rest] = line.split('=')
      return [key.trim(), rest.join('=').trim().replace(/^['"]|['"]$/g, '')]
    }))
}

function envValue(env, suffix) {
  return env[`${preferredEnvPrefix}_${suffix}`] ?? env[`${legacyEnvPrefix}_${suffix}`]
}

function normalizeContractMap(value) {
  return Object.fromEntries(Object.entries(value ?? {}).map(([key, entry]) => [key, normalizeContractId(entry)]))
}
