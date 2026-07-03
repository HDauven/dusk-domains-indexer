import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageJson = readPackageJson()

export const LOCAL_INDEXER_PACKAGE_INFO = Object.freeze({
  name: String(packageJson.name ?? '@hdauven/dusk-domains-indexer'),
  version: String(packageJson.version ?? '0.0.0'),
  sourceCommit: process.env.DUSK_DOMAINS_INDEXER_SOURCE_COMMIT || null,
  sdk: {
    package: '@hdauven/dusk-domains-sdk',
    dependency: String(packageJson.dependencies?.['@hdauven/dusk-domains-sdk'] ?? ''),
  },
})

function readPackageJson() {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    return JSON.parse(readFileSync(resolve(here, '../../package.json'), 'utf8'))
  } catch {
    return {}
  }
}
