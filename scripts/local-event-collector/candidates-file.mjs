import { readFile } from 'node:fs/promises'

/** The marketplace candidate journal beside a collector cursor: `<cursor>.market-candidates.jsonl`. */
export function marketCandidatesFile(cursorFile) {
  return cursorFile.replace(/(\.json)?$/, '.market-candidates.jsonl')
}

/** The candidate journal bytes a cursor file commits; 0 when it commits none or is no current cursor. */
export async function committedCandidateBytes(cursorFile) {
  try {
    const bytes = JSON.parse(await readFile(cursorFile, 'utf8'))?.marketCandidatesBytes
    return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : 0
  } catch {
    return 0
  }
}
