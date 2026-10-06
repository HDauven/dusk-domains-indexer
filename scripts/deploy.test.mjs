import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { afterEach, expect, it } from 'vitest'

const roots = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))
const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8')

it.each(['collector', 'indexer'])('keeps %s unit flags and hardening while isolating instance paths and dependencies', async kind => {
  const old = await read(`deploy/systemd/dusk-domains-${kind}.service`)
  const unit = await read(`deploy/systemd/dusk-domains-${kind}@.service`)
  expect(unit).toContain('EnvironmentFile=/etc/dusk-domains/%i.env')
  expect(unit).toContain('WorkingDirectory=/opt/dusk-domains-indexer-%i')
  expect(unit.match(/^ExecStart=.+$/m)[0]).toBe(old.match(/^ExecStart=.+$/m)[0].replaceAll('/opt/dusk-domains-indexer', '/opt/dusk-domains-indexer-%i'))
  for (const line of old.split('\n').filter(line => /^(Restart|NoNewPrivileges|PrivateTmp|ProtectSystem|ProtectHome|ReadWritePaths)=/.test(line))) expect(unit).toContain(line)
  expect(unit).toContain('User=duskdomains\nGroup=duskdomains')
  if (kind === 'indexer') {
    expect(unit).toContain('After=network-online.target dusk-domains-collector@%i.service')
    expect(unit).toContain('Wants=network-online.target dusk-domains-collector@%i.service')
  }
})

it('configures separate data, ports, origins and nodes for both instances', async () => {
  for (const [instance, port, node, site, noindex] of [
    ['mainnet', '8787', 'https://nodes.dusk.network', 'https://dusk.domains', 'false'],
    ['testnet', '8788', 'http://127.0.0.1:8080', 'https://testnet.dusk.domains', 'true'],
  ]) {
    const env = parseEnv(await read(`deploy/${instance}.env.example`))
    expect(env.DUSK_DOMAINS_INDEXER_PORT).toBe(port)
    expect(env.DUSK_DOMAINS_INDEXER_HEALTH_URL).toBe(`http://127.0.0.1:${port}/health`)
    expect(env.DUSK_DOMAINS_SITE_URL).toBe(site)
    expect(env.DUSK_DOMAINS_INDEXER_CORS_ORIGINS).toBe(site)
    expect(env.DUSK_DOMAINS_NOINDEX).toBe(noindex)
    expect(env.DUSK_DOMAINS_COLLECTOR_NODE_URL).toBe(node)
    for (const key of ['DATA_DIR', 'EVENT_LOG', 'SQLITE', 'CURSOR', 'CHECKPOINT']) expect(env[`DUSK_DOMAINS_INDEXER_${key}`]).toMatch(new RegExp(`^/var/lib/dusk-domains/${instance}(/|$)`))
    expect(env.DUSK_DOMAINS_INDEXER_BACKUP_DIR).toBe(`/var/backups/dusk-domains/${instance}`)
    expect(env.DUSK_DOMAINS_INDEXER_TRUST_PROXY).toBe('true')
  }
})

it('routes each site to its own assets and API while retaining crawler and preview routes', async () => {
  const caddy = await read('deploy/Caddyfile.example')
  expect(caddy).toContain('root * {args[0]}')
  expect(caddy).toContain('reverse_proxy {args[1]}')
  expect(caddy).toContain('import dusk_domains_site /srv/dusk-domains/dist 127.0.0.1:8787')
  expect(caddy).toContain('import dusk_domains_site /srv/dusk-domains-testnet/dist 127.0.0.1:8788')
  expect(caddy).toMatch(/testnet\.dusk\.domains \{\s+header \{\s+X-Robots-Tag "noindex, nofollow"\s+defer/)
  expect(caddy).toContain('rewrite @preview /api/share/name/{re.shareName.1}')
  expect(caddy).toContain('rewrite @crawler /api/page/name/{re.crawlName.1}')
  expect(caddy).toContain('rewrite /sitemap-names.xml /api/sitemap/names.xml')
  expect(caddy).toMatch(/api\.dusk\.domains \{[\s\S]*?reverse_proxy 127\.0\.0\.1:8787/)
  expect(caddy).toMatch(/www\.dusk\.domains \{\s+redir https:\/\/dusk\.domains\{uri\} permanent/)
  expect(caddy).toContain('Cache-Control "public, max-age=31536000, immutable"')
})

async function fixture() {
  const root = await mkdtemp(resolve('node_modules/.deploy-test-'))
  roots.push(root)
  const repo = join(root, 'repo')
  const remote = join(root, 'remote')
  const bin = join(root, 'bin')
  for (const path of [join(repo, 'deploy'), bin, join(remote, 'opt'), join(remote, 'etc/dusk-domains'), join(remote, 'var/lock')]) await mkdir(path, { recursive: true })
  await writeFile(join(repo, 'deploy/deploy.sh'), await read('deploy/deploy.sh'))
  const executable = async (name, body) => writeFile(join(bin, name), '#!/usr/bin/env node\n' + body, { mode: 0o755 })
  await executable('ssh', `
    const { spawnSync } = require('node:child_process')
    let command = process.argv.at(-1)
    for (const path of ['/opt/', '/etc/dusk-domains/', '/var/lock/']) command = command.replaceAll(path, process.env.FAKE_REMOTE + path)
    const result = spawnSync('/bin/bash', ['-c', command], { stdio: 'inherit' })
    process.exit(result.status ?? 1)
  `)
  for (const name of ['npm', 'systemctl', 'chown', 'sleep']) await executable(name, `
    const args = process.argv.slice(2)
    require('node:fs').appendFileSync(process.env.FAKE_LOG, ${JSON.stringify(name)} + ' ' + args.join(' ') + '\\n')
    if (${JSON.stringify(name)} === 'systemctl' && args[0] === 'is-active') {
      // Like systemctl, several units pass when any one of them is active.
      process.exit(args.slice(1).some(unit => !unit.startsWith('-') && unit !== process.env.FAKE_INACTIVE) ? 0 : 3)
    }
    process.exit(${JSON.stringify(name)} === 'npm' && process.env.FAIL_INSTALL ? 1 : 0)
  `)
  await executable('mv', `
    const [from, to] = process.argv.slice(2).filter(arg => arg !== '--')
    if (process.env.FAIL_ENV_SWAP && from.endsWith('.env.next')) process.exit(1)
    require('node:fs').renameSync(from, to)
  `)
  await executable('curl', `
    const { readFileSync, appendFileSync } = require('node:fs')
    const { parseEnv } = require('node:util')
    appendFileSync(process.env.FAKE_LOG, 'curl ' + process.argv.at(-1) + '\\n')
    const env = parseEnv(readFileSync(process.env.FAKE_REMOTE + '/etc/dusk-domains/testnet.env', 'utf8'))
    console.log(JSON.stringify({ ok: !process.env.FAIL_HEALTH, package: { sourceCommit: process.env.WRONG_COMMIT ? 'wrong' : env.DUSK_DOMAINS_INDEXER_SOURCE_COMMIT } }))
  `)
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=Deploy Test', '-c', 'user.email=deploy-test@example.invalid', ...args], { encoding: 'utf8' }).trim()
  git('init', '--quiet')
  const commit = async version => {
    await writeFile(join(repo, 'version'), version)
    git('add', '.')
    git('commit', '--quiet', '-m', `Set version ${version}`)
    return git('rev-parse', 'HEAD')
  }
  const first = await commit('first')
  const live = join(remote, 'opt/dusk-domains-indexer-testnet')
  await mkdir(live)
  await writeFile(join(live, 'version'), 'first')
  const envFile = join(remote, 'etc/dusk-domains/testnet.env')
  await writeFile(envFile, `DUSK_DOMAINS_INDEXER_PORT="8788"\nDUSK_DOMAINS_INDEXER_SOURCE_COMMIT=${first}\nKEEP_ME=yes\n`, { mode: 0o640 })
  await writeFile(join(remote, 'opt/mainnet-sentinel'), 'untouched')
  const log = join(root, 'commands')
  const deploy = (args, extra = {}) => spawnSync('bash', [join(repo, 'deploy/deploy.sh'), ...args], {
    encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DEPLOY_HOST: 'deployment-target', FAKE_REMOTE: remote, FAKE_LOG: log, ...extra },
  })
  return { root, remote, live, first, envFile, log, commit, deploy }
}

it('deploys archived commits, retains three releases and rolls back only the selected instance', async () => {
  const f = await fixture()
  const commits = []
  for (const version of ['second', 'third', 'fourth', 'fifth']) {
    const commit = await f.commit(version)
    commits.push(commit)
    const result = f.deploy(['testnet', commit])
    expect(result.status, result.stderr).toBe(0)
    expect(await readFile(join(f.live, 'version'), 'utf8')).toBe(version)
    expect(parseEnv(await readFile(f.envFile, 'utf8'))).toMatchObject({ DUSK_DOMAINS_INDEXER_SOURCE_COMMIT: commit, KEEP_ME: 'yes' })
  }
  const releases = (await readdir(join(f.remote, 'opt'))).filter(name => name.includes('.prev-')).sort()
  expect(releases).toHaveLength(3)
  expect(await readFile(join(f.remote, 'opt', releases[0], 'version'), 'utf8')).toBe('second')
  const rollback = f.deploy(['--rollback', 'testnet'])
  expect(rollback.status, rollback.stderr).toBe(0)
  expect(await readFile(join(f.live, 'version'), 'utf8')).toBe('fourth')
  expect(parseEnv(await readFile(f.envFile, 'utf8')).DUSK_DOMAINS_INDEXER_SOURCE_COMMIT).toBe(commits[2])
  const log = await readFile(f.log, 'utf8')
  expect(log).toContain('npm ci --no-audit --no-fund')
  expect(log).toContain('systemctl stop dusk-domains-indexer@testnet.service dusk-domains-collector@testnet.service')
  expect(log).toContain('systemctl restart dusk-domains-collector@testnet.service dusk-domains-indexer@testnet.service')
  expect(log).toContain('curl http://127.0.0.1:8788/health')
  expect(log).not.toMatch(/@mainnet|:8787/)
  expect(await readFile(join(f.remote, 'opt/mainnet-sentinel'), 'utf8')).toBe('untouched')
}, 20_000)

it('does not stop or replace a working instance when npm ci fails', async () => {
  const f = await fixture()
  const commit = await f.commit('second')
  expect(f.deploy(['testnet', commit], { FAIL_INSTALL: '1' }).status).toBe(1)
  expect(await readFile(join(f.live, 'version'), 'utf8')).toBe('first')
  expect(parseEnv(await readFile(f.envFile, 'utf8')).DUSK_DOMAINS_INDEXER_SOURCE_COMMIT).toBe(f.first)
  expect(await readFile(f.log, 'utf8')).not.toContain('systemctl')
})

it.each(['FAIL_HEALTH', 'WRONG_COMMIT'])('rejects %s and leaves a usable rollback', async failure => {
  const f = await fixture()
  const commit = await f.commit('second')
  const result = f.deploy(['testnet', commit], { [failure]: '1' })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('failed its health check')
  const rollback = f.deploy(['--rollback', 'testnet'])
  expect(rollback.status, rollback.stderr).toBe(0)
  expect(await readFile(join(f.live, 'version'), 'utf8')).toBe('first')
  expect(parseEnv(await readFile(f.envFile, 'utf8')).DUSK_DOMAINS_INDEXER_SOURCE_COMMIT).toBe(f.first)
}, 20_000)

it('supports the first deployment with no existing code directory', async () => {
  const f = await fixture()
  await rm(f.live, { recursive: true })
  const result = f.deploy(['testnet', f.first])
  expect(result.status, result.stderr).toBe(0)
  expect(await readFile(join(f.live, 'version'), 'utf8')).toBe('first')
})

it('rejects invalid instance names before opening SSH', async () => {
  const f = await fixture()
  expect(f.deploy(['../mainnet', f.first]).status).toBe(2)
  expect(f.deploy(['--rollback', 'testnet;echo']).status).toBe(2)
  await expect(readFile(f.log)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rolls back one release further on each rollback', async () => {
  const f = await fixture()
  for (const version of ['second', 'third']) expect(f.deploy(['testnet', await f.commit(version)]).status).toBe(0)
  expect(f.deploy(['--rollback', 'testnet']).status).toBe(0)
  expect(await readFile(join(f.live, 'version'), 'utf8')).toBe('second')
  expect(f.deploy(['--rollback', 'testnet']).status).toBe(0)
  expect(await readFile(join(f.live, 'version'), 'utf8')).toBe('first')
  expect(parseEnv(await readFile(f.envFile, 'utf8')).DUSK_DOMAINS_INDEXER_SOURCE_COMMIT).toBe(f.first)
}, 20_000)

it('keeps the last healthy release through repeated failed deployments', async () => {
  const f = await fixture()
  for (const version of ['second', 'third', 'fourth', 'fifth']) {
    expect(f.deploy(['testnet', await f.commit(version)], { FAIL_HEALTH: '1' }).status).toBe(1)
  }
  const releases = (await readdir(join(f.remote, 'opt'))).filter(name => name.includes('.prev-')).sort()
  expect(await readFile(join(f.remote, 'opt', releases[0], 'version'), 'utf8')).toBe('first')
}, 60_000)

it('requires both the collector and the API to be active', async () => {
  const f = await fixture()
  const result = f.deploy(['testnet', await f.commit('second')], { FAKE_INACTIVE: 'dusk-domains-collector@testnet.service' })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('failed its health check')
}, 20_000)

it('restores the running release when the swap fails', async () => {
  const f = await fixture()
  const result = f.deploy(['testnet', await f.commit('second')], { FAIL_ENV_SWAP: '1' })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('restoring the running release')
  expect(await readFile(join(f.live, 'version'), 'utf8')).toBe('first')
  expect(parseEnv(await readFile(f.envFile, 'utf8')).DUSK_DOMAINS_INDEXER_SOURCE_COMMIT).toBe(f.first)
  expect((await readdir(join(f.remote, 'etc/dusk-domains'))).filter(name => name.endsWith('.next'))).toEqual([])
  expect(await readFile(f.log, 'utf8')).toMatch(/systemctl restart dusk-domains-collector@testnet.service dusk-domains-indexer@testnet.service\n$/)
}, 20_000)
