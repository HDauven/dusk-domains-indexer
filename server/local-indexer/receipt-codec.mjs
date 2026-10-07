import { parseJson, stringifyJson } from '@duskdomains/sdk'

// Each decoded payload is canonical JSON text inside the JSONL envelope. This retains bare
// u64 JSON integers losslessly through ordinary JSON/SQLite readers; SDK parseJson revives them.
export function encodeReceipt(receipt) {
  return { ...receipt, height: String(receipt.height), events: receipt.events.map(e => ({ ...e, data: stringifyJson(e.data) })) }
}
export function decodeReceipt(receipt) {
  return { ...receipt, height: BigInt(receipt.height), events: receipt.events.map(e => {
    if (typeof e.data !== 'string') throw new Error('Receipt payload must be canonical lossless JSON text')
    return { ...e, data: parseJson(e.data) }
  }) }
}
