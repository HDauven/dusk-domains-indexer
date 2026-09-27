import { numberOrNull } from './http.mjs'

// The highest height the indexer knows the chain has reached: the collector's view of the tip
// when it has one, otherwise the last indexed event.
export function knownChainHeight({ cursor, checkpoint } = {}) {
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
