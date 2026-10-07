import { decodeReceipt } from './receipt-codec.mjs'
import { committedScopeEvents } from '../../scripts/local-event-collector/frozen.mjs'
const contractKeys = ['directory', 'policy', 'store', 'vault', 'resolver', 'marketplace']

export function deploymentBindingFromEvents(events = []) {
  const binding = createDeploymentBinding()
  for (const entry of events) addDeploymentBindingEvent(binding, entry)
  return summarizeDeploymentBinding(binding)
}

// Accumulates per event, so an incremental indexer can keep it current without re-reading
// the journal.
export function createDeploymentBinding() {
  return {
    chainIds: new Set(),
    contracts: {},
    frozenContracts: null,
    deploymentStartHeight: null,
    lastEventBlockHeight: null,
    eventCount: 0,
  }
}

export function addDeploymentBindingEvent(binding, entry) {
  if (entry?.event?.type === 'frozen_receipt') {
    try {
    const { receipt: r, projectionOptions } = entry.event
    binding.frozenContracts ??= new Map(Object.entries(projectionOptions.contracts).map(([id, key]) => [id, { key }]))
    const receipt = decodeReceipt(r)
    const effects = committedScopeEvents(receipt, binding.frozenContracts, projectionOptions.directoryId)
    const scope = Object.fromEntries([...binding.frozenContracts].map(([id, c]) => [id, c.key]))
    for (const effect of effects) {
      addDeploymentBindingEvent(binding, { event: { type: effect.topic }, meta: { ...entry.meta,
        contractKey: scope[effect.emitter], contractId: `0x${effect.emitter}` } })
    }
    } catch { binding.invalidReceipt = true }
    return
  }
  const meta = entry?.meta ?? {}
  const blockHeight = numberOrNull(meta.blockHeight)
  const contractKey = stringOrNull(meta.contractKey)
  const contractId = stringOrNull(meta.contractId)
  const chainId = stringOrNull(meta.chainId)
  if (chainId) binding.chainIds.add(chainId)
  if (blockHeight !== null) {
    binding.deploymentStartHeight = binding.deploymentStartHeight === null ? blockHeight : Math.min(binding.deploymentStartHeight, blockHeight)
    binding.lastEventBlockHeight = binding.lastEventBlockHeight === null ? blockHeight : Math.max(binding.lastEventBlockHeight, blockHeight)
  }
  if (!contractKey && !contractId) return

  binding.eventCount += 1
  const key = contractKey ?? 'unknown'
  const current = binding.contracts[key] ?? {
    contractKey: key,
    contractId: contractId ?? null,
    contractIds: [],
    eventCount: 0,
    firstBlockHeight: null,
    lastBlockHeight: null,
    contractIdConflict: false,
  }
  if (contractId && !current.contractIds.includes(contractId)) current.contractIds.push(contractId)
  if (current.contractId && contractId && current.contractId !== contractId && !['store', 'resolver', 'policy', 'marketplace'].includes(key)) current.contractIdConflict = true
  if (!current.contractId && contractId) current.contractId = contractId
  current.eventCount += 1
  if (blockHeight !== null) {
    current.firstBlockHeight = current.firstBlockHeight === null ? blockHeight : Math.min(current.firstBlockHeight, blockHeight)
    current.lastBlockHeight = current.lastBlockHeight === null ? blockHeight : Math.max(current.lastBlockHeight, blockHeight)
  }
  binding.contracts[key] = current
}

export function summarizeDeploymentBinding(binding) {
  const { chainIds, contracts } = binding
  const missingContracts = contractKeys.filter((key) => !contracts[key]?.contractId)
  const conflictedContracts = Object.values(contracts)
    .filter((contract) => contract.contractIdConflict)
    .map((contract) => contract.contractKey)

  return {
    chainId: chainIds.size === 1 ? [...chainIds][0] : null,
    chainIds: [...chainIds].sort(),
    deploymentStartHeight: binding.deploymentStartHeight,
    lastEventBlockHeight: binding.lastEventBlockHeight,
    eventCount: binding.eventCount,
    contracts: structuredClone(contracts),
    complete: !binding.invalidReceipt && missingContracts.length === 0 && conflictedContracts.length === 0,
    missingContracts,
    conflictedContracts,
  }
}

function stringOrNull(value) {
  return typeof value === 'string' && value.trim() ? value : null
}

function numberOrNull(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : null
}

// Flatten committed effects only for deployment auditing; the durable journal remains atomic.
export function deploymentEvents(entries) {
  let contracts
  const result = []
  for (const entry of entries) {
    if (entry?.event?.type !== 'frozen_receipt') { result.push(entry); continue }
    try {
      const { projectionOptions, receipt: raw } = entry.event
      contracts ??= new Map(Object.entries(projectionOptions.contracts).map(([id, key]) => [id, { key }]))
      const receipt = decodeReceipt(raw)
      const effects = committedScopeEvents(receipt, contracts, projectionOptions.directoryId)
      const scope = Object.fromEntries([...contracts].map(([id, c]) => [id, c.key]))
      for (const e of effects) result.push({ event: { type: e.topic, body: e.data.body },
        meta: { ...entry.meta, contractKey: scope[e.emitter], contractId: `0x${e.emitter}` } })
    } catch {
      result.push({ ...entry, meta: { ...entry.meta, contractKey: 'invalid-frozen-receipt' } })
    }
  }
  return result
}
