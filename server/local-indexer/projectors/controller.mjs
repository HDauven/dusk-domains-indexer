import {
  normalizeNode,
  numberOrNull,
} from '../http.mjs'

export function applyControllerEvent(store, event, meta) {
  const commitment = normalizeNode(event.commitment)
  const current = store.commitmentsById.get(commitment)
  const next = reduceControllerEvent(event, current, meta)
  store.commitmentsById.set(commitment, next)
}

function reduceControllerEvent(event, current, meta) {
  const commitment = normalizeNode(event.commitment)

  if (event.type === 'registration_committed') {
    return {
      commitment,
      controller: event.controller,
      createdAt: event.createdAt ?? null,
      node: current?.node ?? null,
      status: current?.status === 'revealed' ? 'revealed' : 'committed',
      committedTxId: meta.txId ?? current?.committedTxId ?? null,
      committedBlockHeight: numberOrNull(meta.blockHeight ?? current?.committedBlockHeight),
      revealedTxId: current?.revealedTxId ?? null,
      revealedBlockHeight: current?.revealedBlockHeight ?? null,
      lastEventType: event.type,
    }
  }

  return {
    commitment,
    controller: event.controller,
    createdAt: current?.createdAt ?? null,
    node: normalizeNode(event.node),
    status: 'revealed',
    committedTxId: current?.committedTxId ?? null,
    committedBlockHeight: current?.committedBlockHeight ?? null,
    revealedTxId: meta.txId ?? current?.revealedTxId ?? null,
    revealedBlockHeight: numberOrNull(meta.blockHeight ?? current?.revealedBlockHeight),
    lastEventType: event.type,
  }
}
