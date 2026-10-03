import { getReservedNamePolicy } from '@duskdomains/sdk/projection'
import { blake2b } from '@noble/hashes/blake2.js'
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import {
  DEFAULT_FEE_CONFIG,
  LUX_PER_DUSK,
} from './constants.mjs'
import { normalizeNode } from './http.mjs'

export function apexLabel(canonical) {
  return canonical.replace(/\.dusk$/, '').split('.')[0] ?? ''
}

export function nameValidationIssue(canonical) {
  if (!canonical) return { tone: 'info', text: 'Enter a name to check availability.' }
  if (canonical.length > 63) return { tone: 'danger', text: 'Names must be 63 characters or shorter.' }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*\.dusk$/.test(canonical)) {
    return { tone: 'danger', text: 'Use lowercase letters, numbers, or interior hyphens.' }
  }
  if (canonical.split('.').slice(0, -1).some((part) => part.length < 3)) {
    return { tone: 'danger', text: 'Labels shorter than 3 characters are reserved.' }
  }
  return null
}

export function annualPrice(label, feeConfig = DEFAULT_FEE_CONFIG) {
  if (label.length <= 2) return 0
  if (label.length === 3) return feeConfig.threeCharYearLux / LUX_PER_DUSK
  if (label.length === 4) return feeConfig.fourCharYearLux / LUX_PER_DUSK
  return feeConfig.fivePlusYearLux / LUX_PER_DUSK
}

export function reservedCategory(label) {
  return getReservedNamePolicy(label)?.category ?? 'ecosystem'
}

export function endpointKey(endpoint) {
  return `${endpoint.type}:${endpoint.value}`
}

export function reverseResponse(reverse) {
  const primaryName = reverse.primaryName ?? reverse.name ?? null

  return {
    primaryName,
    name: primaryName,
    node: reverse.node ? normalizeNode(reverse.node) : null,
  }
}

export function namehashHex(name) {
  let node = new Uint8Array(32)
  for (const label of name.split('.').toReversed()) {
    node = blake2b(concatBytes(node, blake2b(utf8ToBytes(label), { dkLen: 32 })), { dkLen: 32 })
  }
  return `0x${bytesToHex(node)}`
}
