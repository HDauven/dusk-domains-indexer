#!/usr/bin/env node

import { isMain } from './is-main.mjs'
import { loadCollectorConfig, parseArgs, usage } from './local-event-collector/config.mjs'
import { collectArchive } from './local-event-collector/archive.mjs'

export { loadCollectorConfig, parseArgs, parseEnvFile, summarizeEventLogText, usage } from './local-event-collector/config.mjs'

if (isMain(import.meta)) {
  try {
    const args = parseArgs(process.argv.slice(2))
    if (args.help) {
      console.log(usage())
    } else {
      const config = await loadCollectorConfig(args)
      const controller = new AbortController()
      const stop = () => controller.abort()
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
      const timer = config.durationMs ? setTimeout(stop, config.durationMs) : null
      try {
        console.log(JSON.stringify({ mode: 'archive-collecting', eventLog: config.eventLog, nodeUrl: config.nodeUrl }))
        await collectArchive(config, { signal: controller.signal })
      } finally {
        clearTimeout(timer)
        process.removeListener('SIGINT', stop)
        process.removeListener('SIGTERM', stop)
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
