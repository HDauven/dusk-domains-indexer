export function createEventLog(options = {}) {
  const node = `0x${'aa'.repeat(32)}`
  const subnode = `0x${'bb'.repeat(32)}`
  const owner = '0xowner'
  const controller = options.controller ?? owner
  const resolver = `0x${'cc'.repeat(32)}`

  return [
    {
      event: {
        type: 'name_registered',
        node,
        label: 'aurora',
        actor: owner,
        owner,
        expiresAt: '2027-06-17T00:00:00.000Z',
        graceEndsAt: '2027-07-17T00:00:00.000Z',
        feeLux: 10,
      },
      meta: { txId: 'tx-register', blockHeight: 10 },
    },
    {
      event: {
        type: 'name_owner_changed',
        node,
        actor: owner,
        previousOwner: null,
        owner,
        manager: owner,
        resolver,
        expiresAt: '2027-06-17T00:00:00.000Z',
      },
      meta: { txId: 'tx-owner', blockHeight: 11 },
    },
    {
      event: {
        type: 'record_changed',
        node,
        controller,
        record: {
          key: 'moonlight_address',
          value: 'dusk1localresolverproof01',
          visibility: 'public',
          updatedAt: '2026-06-17T00:00:00.000Z',
          ttlSeconds: 300,
        },
      },
      meta: { txId: 'tx-record', blockHeight: 12 },
    },
    {
      event: {
        type: 'primary_name_changed',
        endpoint: {
          type: 'moonlight_address',
          value: 'dusk1localresolverproof01',
        },
        controller,
        node,
        name: 'aurora.dusk',
        previousName: null,
        updatedAt: '2026-06-17T00:00:01.000Z',
      },
      meta: { txId: 'tx-primary', blockHeight: 13 },
    },
    {
      event: {
        type: 'subname_created',
        parentNode: node,
        node: subnode,
        parentName: 'aurora.dusk',
        name: 'settlement.aurora.dusk',
        label: 'settlement',
        actor: owner,
        owner,
        manager: owner,
        resolver,
        expiresAt: '2027-06-17T00:00:00.000Z',
        parentExpiresAt: '2027-06-17T00:00:00.000Z',
        expiryPolicy: 'fixed_before_parent',
        revocationPolicy: 'parent_revocable',
        createdAt: '2026-06-17T00:00:02.000Z',
      },
      meta: { txId: 'tx-subname', blockHeight: 14 },
    },
  ]
}

export function createReleaseReregistrationEventLogFixture() {
  const node = `0x${'aa'.repeat(32)}`
  const owner = '0xowner'
  const nextOwner = '0xnextowner'
  const resolver = `0x${'cc'.repeat(32)}`
  const moonlight = 'dusk1localresolverproof01'

  return {
    node,
    owner,
    nextOwner,
    moonlight,
    events: [
      {
        event: {
          type: 'name_registered',
          node,
          label: 'aurora',
          actor: owner,
          owner,
          expiresAt: '2027-06-17T00:00:00.000Z',
          graceEndsAt: '2027-07-17T00:00:00.000Z',
        },
        meta: { txId: 'tx-register', blockHeight: 1 },
      },
      {
        event: {
          type: 'name_owner_changed',
          node,
          actor: owner,
          owner,
          manager: owner,
          resolver,
          expiresAt: '2027-06-17T00:00:00.000Z',
        },
        meta: { txId: 'tx-owner', blockHeight: 2 },
      },
      {
        event: {
          type: 'record_changed',
          node,
          controller: owner,
          record: {
            key: 'moonlight_address',
            value: moonlight,
            visibility: 'public',
            updatedAt: '2026-06-17T00:00:00.000Z',
            ttlSeconds: 300,
          },
        },
        meta: { txId: 'tx-record', blockHeight: 3 },
      },
      {
        event: {
          type: 'primary_name_changed',
          endpoint: {
            type: 'moonlight_address',
            value: moonlight,
          },
          controller: owner,
          node,
          name: 'aurora.dusk',
          previousName: null,
          updatedAt: '2026-06-17T00:01:00.000Z',
        },
        meta: { txId: 'tx-primary', blockHeight: 4 },
      },
      {
        event: {
          type: 'name_released',
          node,
          label: 'aurora',
          actor: owner,
          previousOwner: owner,
          releasedAt: '2027-07-18T00:00:00.000Z',
        },
        meta: { txId: 'tx-release', blockHeight: 5 },
      },
      {
        event: {
          type: 'name_registered',
          node,
          label: 'aurora',
          actor: nextOwner,
          owner: nextOwner,
          expiresAt: '2028-06-17T00:00:00.000Z',
          graceEndsAt: '2028-07-17T00:00:00.000Z',
        },
        meta: { txId: 'tx-register-next', blockHeight: 6 },
      },
      {
        event: {
          type: 'name_owner_changed',
          node,
          actor: nextOwner,
          owner: nextOwner,
          manager: nextOwner,
          resolver,
          expiresAt: '2028-06-17T00:00:00.000Z',
        },
        meta: { txId: 'tx-owner-next', blockHeight: 7 },
      },
    ],
  }
}

export function createExpiredRoutingEventLogFixture() {
  const node = `0x${'aa'.repeat(32)}`
  const subnode = `0x${'bb'.repeat(32)}`
  const owner = '0xowner'
  const resolver = `0x${'cc'.repeat(32)}`
  const moonlight = 'dusk1localresolverproof01'

  return {
    node,
    subnode,
    owner,
    moonlight,
    events: [
      {
        event: {
          type: 'name_registered',
          node,
          label: 'aurora',
          actor: owner,
          owner,
          expiresAt: '2020-01-01T00:00:00.000Z',
          graceEndsAt: '2020-02-01T00:00:00.000Z',
        },
        meta: { txId: 'tx-register', blockHeight: 1 },
      },
      {
        event: {
          type: 'name_owner_changed',
          node,
          actor: owner,
          owner,
          manager: owner,
          resolver,
          expiresAt: '2020-01-01T00:00:00.000Z',
        },
        meta: { txId: 'tx-owner', blockHeight: 2 },
      },
      {
        event: {
          type: 'record_changed',
          node,
          controller: owner,
          record: {
            key: 'moonlight_address',
            value: moonlight,
            visibility: 'public',
            updatedAt: '2020-01-01T00:00:00.000Z',
            ttlSeconds: 300,
          },
        },
        meta: { txId: 'tx-record', blockHeight: 3 },
      },
      {
        event: {
          type: 'primary_name_changed',
          endpoint: {
            type: 'moonlight_address',
            value: moonlight,
          },
          controller: owner,
          node,
          name: 'aurora.dusk',
          previousName: null,
          updatedAt: '2020-01-01T00:01:00.000Z',
        },
        meta: { txId: 'tx-primary', blockHeight: 4 },
      },
      {
        event: {
          type: 'subname_created',
          parentNode: node,
          node: subnode,
          parentName: 'aurora.dusk',
          name: 'settlement.aurora.dusk',
          label: 'settlement',
          actor: owner,
          owner,
          manager: owner,
          resolver,
          expiresAt: '2020-01-01T00:00:00.000Z',
          parentExpiresAt: '2020-01-01T00:00:00.000Z',
          expiryPolicy: 'inherits_parent',
          revocationPolicy: 'parent_revocable',
          createdAt: '2020-01-01T00:02:00.000Z',
        },
        meta: { txId: 'tx-subname', blockHeight: 5 },
      },
      {
        event: {
          type: 'name_expired',
          node,
          label: 'aurora',
          actor: owner,
          owner,
          expiresAt: '2020-01-01T00:00:00.000Z',
          graceEndsAt: '2020-02-01T00:00:00.000Z',
          observedAt: '2020-02-02T00:00:00.000Z',
        },
        meta: { txId: 'tx-expired', blockHeight: 6 },
      },
    ],
  }
}

export function createLifecycleCleanupEventLogFixture() {
  const node = `0x${'aa'.repeat(32)}`
  const subnode = `0x${'bb'.repeat(32)}`
  const owner = '0xowner'
  const manager = '0xmanager'
  const nextManager = '0xnextmanager'
  const resolver = `0x${'cc'.repeat(32)}`
  const moonlight = 'dusk1localresolverproof01'

  return {
    node,
    subnode,
    manager,
    nextManager,
    moonlight,
    events: [
      {
        event: {
          type: 'name_registered',
          node,
          label: 'aurora',
          actor: owner,
          owner,
          expiresAt: '2027-06-17T00:00:00.000Z',
          graceEndsAt: '2027-07-17T00:00:00.000Z',
        },
        meta: { txId: 'tx-register', blockHeight: 1 },
      },
      {
        event: {
          type: 'name_owner_changed',
          node,
          actor: owner,
          owner,
          manager,
          resolver,
          expiresAt: '2027-06-17T00:00:00.000Z',
        },
        meta: { txId: 'tx-owner', blockHeight: 2 },
      },
      {
        event: {
          type: 'record_changed',
          node,
          controller: manager,
          record: {
            key: 'moonlight_address',
            value: moonlight,
            ttlSeconds: 180,
            updatedAt: '2026-06-17T00:01:00.000Z',
            visibility: 'public',
          },
        },
        meta: { txId: 'tx-moonlight', blockHeight: 3 },
      },
      {
        event: {
          type: 'record_changed',
          node,
          controller: manager,
          record: {
            key: 'website',
            value: 'https://old.example',
            ttlSeconds: 300,
            updatedAt: '2026-06-17T00:02:00.000Z',
            visibility: 'public',
          },
        },
        meta: { txId: 'tx-website', blockHeight: 4 },
      },
      {
        event: {
          type: 'record_cleared',
          node,
          controller: manager,
          key: 'website',
        },
        meta: { txId: 'tx-clear-record', blockHeight: 5 },
      },
      {
        event: {
          type: 'primary_name_changed',
          endpoint: {
            type: 'moonlight_address',
            value: moonlight,
          },
          controller: manager,
          node,
          name: 'aurora.dusk',
          previousName: null,
          updatedAt: '2026-06-17T00:03:00.000Z',
        },
        meta: { txId: 'tx-primary', blockHeight: 6 },
      },
      {
        event: {
          type: 'primary_name_changed',
          endpoint: {
            type: 'moonlight_address',
            value: moonlight,
          },
          controller: manager,
          node,
          name: '',
          previousName: 'aurora.dusk',
          updatedAt: '2026-06-17T00:04:00.000Z',
        },
        meta: { txId: 'tx-clear-primary', blockHeight: 7 },
      },
      {
        event: {
          type: 'subname_created',
          parentNode: node,
          node: subnode,
          parentName: 'aurora.dusk',
          name: 'settlement.aurora.dusk',
          label: 'settlement',
          actor: owner,
          owner,
          manager,
          resolver,
          expiresAt: '2027-06-17T00:00:00.000Z',
          parentExpiresAt: '2027-06-17T00:00:00.000Z',
          expiryPolicy: 'inherits_parent',
          revocationPolicy: 'parent_revocable',
          createdAt: '2026-06-17T00:05:00.000Z',
        },
        meta: { txId: 'tx-subname', blockHeight: 8 },
      },
      {
        event: {
          type: 'subname_delegated',
          parentNode: node,
          node: subnode,
          name: 'settlement.aurora.dusk',
          actor: owner,
          manager: nextManager,
          delegatedAt: '2026-06-17T00:06:00.000Z',
        },
        meta: { txId: 'tx-delegate', blockHeight: 9 },
      },
      {
        event: {
          type: 'subname_revoked',
          parentNode: node,
          node: subnode,
          name: 'settlement.aurora.dusk',
          actor: owner,
          revokedAt: '2026-06-17T00:07:00.000Z',
        },
        meta: { txId: 'tx-revoke', blockHeight: 10 },
      },
    ],
  }
}
