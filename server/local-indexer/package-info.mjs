import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const packageJson = readPackageJson()

export const LOCAL_INDEXER_PACKAGE_INFO = Object.freeze({
  name: String(packageJson.name ?? '@hdauven/dusk-domains-indexer'),
  version: String(packageJson.version ?? '0.0.0'),
  sourceCommit: process.env.DUSK_DOMAINS_INDEXER_SOURCE_COMMIT || checkoutCommit(root),
  sdk: {
    package: '@duskdomains/sdk',
    dependency: String(packageJson.dependencies?.['@duskdomains/sdk'] ?? ''),
  },
})

function readPackageJson() {
  try {
    return JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  } catch {
    return {}
  }
}

// Hosts that run from a git checkout report its commit without a build step. Reads .git
// directly so the API never shells out.
export function checkoutCommit(directory) {
  try {
    const gitDir = resolve(directory, '.git')
    const head = readFileSync(resolve(gitDir, 'HEAD'), 'utf8').trim()
    if (/^[0-9a-f]{40}$/.test(head)) return head
    const ref = head.match(/^ref: (.+)$/)?.[1]
    if (!ref) return null
    const refFile = resolve(gitDir, ref)
    if (existsSync(refFile)) return readFileSync(refFile, 'utf8').trim() || null
    const packed = readFileSync(resolve(gitDir, 'packed-refs'), 'utf8')
    return packed.split('\n').find((line) => line.endsWith(` ${ref}`))?.split(' ')[0] ?? null
  } catch {
    return null
  }
}
