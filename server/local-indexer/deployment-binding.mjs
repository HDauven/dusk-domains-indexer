const contractKeys = ['core', 'treasury']

export function deploymentBindingFromEvents(events = []) {
  const chainIds = new Set()
  const contracts = {}
  let deploymentStartHeight = null
  let lastEventBlockHeight = null
  let eventCount = 0

  for (const entry of events) {
    const meta = entry?.meta ?? {}
    const blockHeight = numberOrNull(meta.blockHeight)
    const contractKey = stringOrNull(meta.contractKey)
    const contractId = stringOrNull(meta.contractId)
    const chainId = stringOrNull(meta.chainId)
    if (chainId) chainIds.add(chainId)
    if (blockHeight !== null) {
      deploymentStartHeight = deploymentStartHeight === null ? blockHeight : Math.min(deploymentStartHeight, blockHeight)
      lastEventBlockHeight = lastEventBlockHeight === null ? blockHeight : Math.max(lastEventBlockHeight, blockHeight)
    }
    if (!contractKey && !contractId) continue

    eventCount += 1
    const key = contractKey ?? 'unknown'
    const current = contracts[key] ?? {
      contractKey: key,
      contractId: contractId ?? null,
      contractIds: [],
      eventCount: 0,
      firstBlockHeight: null,
      lastBlockHeight: null,
      contractIdConflict: false,
    }
    if (contractId && !current.contractIds.includes(contractId)) current.contractIds.push(contractId)
    if (current.contractId && contractId && current.contractId !== contractId) current.contractIdConflict = true
    if (!current.contractId && contractId) current.contractId = contractId
    current.eventCount += 1
    if (blockHeight !== null) {
      current.firstBlockHeight = current.firstBlockHeight === null ? blockHeight : Math.min(current.firstBlockHeight, blockHeight)
      current.lastBlockHeight = current.lastBlockHeight === null ? blockHeight : Math.max(current.lastBlockHeight, blockHeight)
    }
    contracts[key] = current
  }

  const missingContracts = contractKeys.filter((key) => !contracts[key]?.contractId)
  const conflictedContracts = Object.values(contracts)
    .filter((contract) => contract.contractIdConflict)
    .map((contract) => contract.contractKey)

  return {
    chainId: chainIds.size === 1 ? [...chainIds][0] : null,
    chainIds: [...chainIds].sort(),
    deploymentStartHeight,
    lastEventBlockHeight,
    eventCount,
    contracts,
    complete: missingContracts.length === 0 && conflictedContracts.length === 0,
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
