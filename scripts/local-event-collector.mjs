#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  loadCollectorConfig,
  parseArgs,
  usage,
} from './local-event-collector/config.mjs'
import { denoCollectorSource } from './local-event-collector/deno-source.mjs'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

if (isCliEntry()) {
  try {
    const args = parseArgs(process.argv.slice(2))
    if (args.help) {
      console.log(usage())
    } else {
      await runCollector(args)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    console.error('')
    console.error(usage())
    process.exitCode = 1
  }
}

export {
  loadCollectorConfig,
  parseArgs,
  parseEnvFile,
  summarizeEventLogText,
  usage,
} from './local-event-collector/config.mjs'
export { denoCollectorSource } from './local-event-collector/deno-source.mjs'

async function runCollector(options) {
  const config = await loadCollectorConfig(options)
  const tempDir = await mkdtemp(resolve(tmpdir(), 'dusk-names-event-collector-'))
  const scriptFile = resolve(tempDir, 'collector.mjs')
  const decoderUrl = pathToFileURL(resolve(rootDir, 'scripts/indexer-operator/event-decoder.mjs')).href

  await writeFile(scriptFile, denoCollectorSource({ decoderUrl }), 'utf8')
  if (config.truncate) {
    await mkdir(dirname(config.eventLog), { recursive: true })
    await writeFile(config.eventLog, '', 'utf8')
  }

  try {
    const result = await runStreaming('deno', [
      'run',
      '--allow-read',
      '--allow-write',
      '--allow-net',
      '--allow-env',
      '-c',
      config.denoConfig,
      scriptFile,
      '--node-url',
      config.nodeUrl,
      '--public-dir',
      config.publicDir,
      '--event-log',
      config.eventLog,
      '--cursor-file',
      config.cursorFile,
      '--contracts-json',
      JSON.stringify(config.contracts),
      '--contract-stack',
      config.contractStack,
      ...(config.durationMs ? ['--duration-ms', String(config.durationMs)] : []),
    ], {
      cwd: config.w3sperDir,
    })

    if (result.status !== 0) {
      throw new Error(`event collector failed with exit code ${result.status}`)
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

function runStreaming(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: 'inherit',
    })
    child.on('error', reject)
    child.on('close', (status) => {
      resolve({ status })
    })
  })
}

function isCliEntry() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
}
