import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkoutCommit } from './package-info.mjs'

const dirs = []
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))))

async function checkout(files) {
  const dir = await mkdtemp(join(tmpdir(), 'dusk-domains-git-'))
  dirs.push(dir)
  for (const [path, body] of Object.entries(files)) {
    await mkdir(join(dir, '.git', path, '..'), { recursive: true })
    await writeFile(join(dir, '.git', path), body)
  }
  return dir
}

const commit = 'a'.repeat(40)

describe('checkoutCommit', () => {
  it('reads a branch ref, a packed ref and a detached head', async () => {
    expect(checkoutCommit(await checkout({ HEAD: 'ref: refs/heads/main\n', 'refs/heads/main': `${commit}\n` }))).toBe(commit)
    expect(checkoutCommit(await checkout({ HEAD: 'ref: refs/heads/main\n', 'packed-refs': `# pack-refs\n${commit} refs/heads/main\n` }))).toBe(commit)
    expect(checkoutCommit(await checkout({ HEAD: `${commit}\n` }))).toBe(commit)
  })

  it('reports nothing outside a checkout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dusk-domains-nogit-'))
    dirs.push(dir)
    expect(checkoutCommit(dir)).toBeNull()
  })
})
