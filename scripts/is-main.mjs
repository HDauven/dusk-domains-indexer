import { pathToFileURL } from 'node:url'

export function isMain(importMeta, argv = process.argv) {
  if (typeof importMeta.main === 'boolean') return importMeta.main
  return Boolean(argv[1]) && importMeta.url === pathToFileURL(argv[1]).href
}
