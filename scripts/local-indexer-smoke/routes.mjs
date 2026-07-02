import { fetchJson, urlJoin } from '../http-json.mjs'

export const requiredLocalIndexerRoutes = Object.freeze([
  '/commitment',
  '/search',
  '/resolve',
  '/name',
  '/records',
  '/record',
  '/record-history',
  '/names',
  '/activity',
  '/reverse',
  '/subnames',
  '/subname',
  '/treasury',
  '/referrals',
])

export const malformedRouteParameterProbes = Object.freeze([
  { route: '/name', expectedError: 'missing_node' },
  { route: '/records', expectedError: 'missing_node' },
  { route: '/record', expectedError: 'missing_node' },
  { route: '/record?node=not-a-node&key=website', expectedError: 'invalid_node' },
  { route: `/record?node=${'aa'.repeat(32)}`, expectedError: 'missing_record_key' },
  { route: `/record?node=${'aa'.repeat(32)}&key=bad key`, expectedError: 'invalid_record_key' },
  { route: '/record-history', expectedError: 'missing_node' },
  { route: '/commitment', expectedError: 'missing_commitment' },
  { route: '/commitment?commitment=not-a-node', expectedError: 'invalid_commitment' },
  { route: '/activity?node=not-a-node', expectedError: 'invalid_node' },
  { route: '/subnames', expectedError: 'missing_node' },
  { route: '/subname', expectedError: 'missing_node' },
  { route: '/subname?node=not-a-node', expectedError: 'invalid_node' },
  { route: '/reverse?type=moonlight_address', expectedError: 'missing_endpoint' },
  { route: '/reverse?type=wallet&value=dusk1localresolverproof01', expectedError: 'unsupported_endpoint_type' },
])

export function indexerHealthContract(health) {
  const missing = []
  if (!Number.isFinite(Number(health?.schemaVersion))) missing.push('schemaVersion')
  if (!Number.isFinite(Number(health?.eventCount))) missing.push('eventCount')
  if (health?.currentBlockHeight !== null && !Number.isFinite(Number(health?.currentBlockHeight))) {
    missing.push('currentBlockHeight')
  }
  if (health?.finalizedBlockHeight !== null && !Number.isFinite(Number(health?.finalizedBlockHeight))) {
    missing.push('finalizedBlockHeight')
  }
  if (health?.lagBlocks !== null && !Number.isFinite(Number(health?.lagBlocks))) missing.push('lagBlocks')
  if (health?.ok !== true) missing.push('ok=true')
  if (missing.length > 0) {
    return {
      ok: false,
      message: `Health contract is unsafe or incomplete: ${missing.join(', ')}.`,
    }
  }
  return { ok: true, message: 'Health contract is complete.' }
}

export function checkRouteManifest(routes) {
  const advertised = Array.isArray(routes) ? routes : []
  const missing = requiredLocalIndexerRoutes.filter((route) => !advertised.includes(route))

  return {
    ok: missing.length === 0,
    message: missing.length === 0
      ? `Indexer advertises MVP routes: ${requiredLocalIndexerRoutes.join(', ')}.`
      : `Indexer health route manifest is missing: ${missing.join(', ')}.`,
  }
}

export async function probeRouteParameterErrors(fetcher, baseUrl) {
  const failures = []

  for (const probe of malformedRouteParameterProbes) {
    const result = await fetchJson(fetcher, urlJoin(baseUrl, probe.route))
    if (result.status !== 400 || result.body?.error !== probe.expectedError) {
      failures.push(`${probe.route} returned ${result.status ?? 'no response'} ${result.body?.error ?? result.error ?? 'without an error code'}`)
    }
  }

  return {
    ok: failures.length === 0,
    message: failures.length === 0
      ? 'Direct read routes fail fast on malformed node/endpoint parameters.'
      : `Route parameter errors are unstable: ${failures.join('; ')}`,
  }
}
