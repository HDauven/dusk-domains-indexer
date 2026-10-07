import { numberOrNull } from './http.mjs'

// Wire heights never coerce invalid cursor fields into diagnostic numbers.
export const cursorHeight = value => Number.isSafeInteger(value) && value >= 0 ? value : null

// Frozen diagnostics use the explicit live tip; legacy snapshots retain their own clock rules.
export function knownChainHeight({ cursor, checkpoint, frozen } = {}) {
  if (frozen || cursor?.source === 'rusk-finalized-archive') return cursorHeight(cursor?.currentBlockHeight)
  return maxNumberOrNull(
    cursor?.currentBlockHeight,
    cursor?.scannedBlockHeight,
    cursor?.lastBlockHeight,
    checkpoint?.lastBlockHeight,
  )
}

export function maxNumberOrNull(...values) {
  const numbers = values
    .map((value) => numberOrNull(value))
    .filter((value) => value !== null)
  return numbers.length ? Math.max(...numbers) : null
}
