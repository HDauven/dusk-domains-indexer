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
  const resolver = `0x${'cc'.repeat(32)}`
  const moonlight = 'dusk1localresolverproof01'

  return {
    node,
    subnode,
    manager,
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
          expiresAt: '2026-06-17T00:07:00.000Z',
          parentExpiresAt: '2027-06-17T00:00:00.000Z',
          expiryPolicy: 'fixed_before_parent',
          createdAt: '2026-06-17T00:05:00.000Z',
        },
        meta: { txId: 'tx-subname', blockHeight: 8 },
      },
      {
        event: {
          type: 'subname_pruned',
          prunedAt: '2026-06-17T00:07:00.000Z',
          parentNode: node,
          node: subnode,
          name: 'settlement.aurora.dusk',
          actor: owner,
        },
        meta: { txId: 'tx-prune', blockHeight: 10 },
      },
    ],
  }
}

export function createSubnameRenewalEventLogFixture() {
  const node = `0x${'aa'.repeat(32)}`
  const childNode = `0x${'b1'.repeat(32)}`
  const grandchildNode = `0x${'b2'.repeat(32)}`
  const fixedNode = `0x${'b3'.repeat(32)}`
  const belowFixedNode = `0x${'b4'.repeat(32)}`
  const owner = '0xowner'
  const resolver = `0x${'cc'.repeat(32)}`
  const subnameCreated = (parentNode, subnode, name, expiryPolicy, expiresAt, expiresAtBlockHeight, blockHeight) => ({
    event: {
      type: 'subname_created',
      parentNode,
      node: subnode,
      parentName: name.split('.').slice(1).join('.'),
      name,
      label: name.split('.')[0],
      actor: owner,
      owner,
      manager: owner,
      resolver,
      expiresAt,
      parentExpiresAt: '2040-06-17T00:00:00.000Z',
      expiresAtBlockHeight,
      parentExpiresAtBlockHeight: 1000,
      expiryPolicy,
      createdAt: '2026-06-17T00:05:00.000Z',
    },
    meta: { txId: `tx-${name}`, blockHeight },
  })

  return {
    node,
    childNode,
    grandchildNode,
    fixedNode,
    belowFixedNode,
    events: [
      {
        event: {
          type: 'name_registered',
          node,
          label: 'acme',
          actor: owner,
          owner,
          expiresAt: '2040-06-17T00:00:00.000Z',
          graceEndsAt: '2040-07-17T00:00:00.000Z',
          expiresAtBlockHeight: 1000,
          graceEndsAtBlockHeight: 1300,
        },
        meta: { txId: 'tx-register', blockHeight: 10 },
      },
      subnameCreated(node, childNode, 'settlement.acme.dusk', 'inherits_parent', '2040-06-17T00:00:00.000Z', 1000, 11),
      subnameCreated(childNode, grandchildNode, 'desk.settlement.acme.dusk', 'inherits_parent', '2040-06-17T00:00:00.000Z', 1000, 12),
      subnameCreated(node, fixedNode, 'vault.acme.dusk', 'fixed_before_parent', '2040-03-01T00:00:00.000Z', 900, 13),
      subnameCreated(fixedNode, belowFixedNode, 'desk.vault.acme.dusk', 'inherits_parent', '2040-03-01T00:00:00.000Z', 900, 14),
    ],
    // The contract reports a subname's authority change as a name_owner_changed on its node.
    childAuthorityChange: {
      event: {
        type: 'name_owner_changed',
        node: childNode,
        actor: owner,
        previousOwner: owner,
        owner,
        manager: '0xmanager',
        resolver: `0x${'00'.repeat(32)}`,
        expiresAt: '2040-06-17T00:00:00.000Z',
        expiresAtBlockHeight: 1000,
      },
      meta: { txId: 'tx-child-authorities', blockHeight: 11 },
    },
    renewal: {
      event: {
        type: 'name_renewed',
        node,
        actor: owner,
        expiresAt: '2041-06-17T00:00:00.000Z',
        graceEndsAt: '2041-07-17T00:00:00.000Z',
        expiresAtBlockHeight: 2000,
        graceEndsAtBlockHeight: 2300,
      },
      meta: { txId: 'tx-renew', blockHeight: 20 },
    },
  }
}

// Alice's name lapses past grace and Bob registers it again. The contract clears Alice's
// subnames, records and primary names without emitting name_released.
export function createLapsedReregistrationEventLogFixture() {
  const node = `0x${'aa'.repeat(32)}`
  const subnode = `0x${'bb'.repeat(32)}`
  const alice = '0xalice'
  const bob = '0xbob'
  const resolver = `0x${'cc'.repeat(32)}`
  const moonlight = 'dusk1lapsedsubnameprimary01'
  const record = (key, value) => ({ key, value, visibility: 'public', updatedAt: '2026-06-17T00:00:00.000Z', ttlSeconds: 300 })

  return {
    node,
    subnode,
    moonlight,
    events: [
      {
        event: {
          type: 'name_registered',
          node,
          label: 'acme',
          actor: alice,
          owner: alice,
          expiresAt: '2026-01-01T00:00:00.000Z',
          graceEndsAt: '2026-02-01T00:00:00.000Z',
          expiresAtBlockHeight: 100,
          graceEndsAtBlockHeight: 130,
        },
        meta: { txId: 'tx-alice-register', blockHeight: 10 },
      },
      {
        event: { type: 'name_owner_changed', node, actor: alice, previousOwner: null, owner: alice, manager: alice, resolver, expiresAt: '2026-01-01T00:00:00.000Z', expiresAtBlockHeight: 100 },
        meta: { txId: 'tx-alice-owner', blockHeight: 10 },
      },
      {
        event: { type: 'record_changed', node, controller: alice, record: record('website', 'https://alice.example') },
        meta: { txId: 'tx-alice-record', blockHeight: 11 },
      },
      {
        event: {
          type: 'subname_created',
          parentNode: node,
          node: subnode,
          parentName: 'acme.dusk',
          name: 'settlement.acme.dusk',
          label: 'settlement',
          actor: alice,
          owner: alice,
          manager: alice,
          resolver,
          expiresAt: '2026-01-01T00:00:00.000Z',
          parentExpiresAt: '2026-01-01T00:00:00.000Z',
          expiresAtBlockHeight: 100,
          parentExpiresAtBlockHeight: 100,
          expiryPolicy: 'inherits_parent',
          createdAt: '2026-06-17T00:00:00.000Z',
        },
        meta: { txId: 'tx-alice-subname', blockHeight: 12 },
      },
      {
        event: { type: 'name_owner_changed', node: subnode, actor: alice, previousOwner: alice, owner: alice, manager: '0xmanager', resolver: `0x${'00'.repeat(32)}`, expiresAt: '2026-01-01T00:00:00.000Z', expiresAtBlockHeight: 100 },
        meta: { txId: 'tx-alice-subname-authorities', blockHeight: 13 },
      },
      {
        event: { type: 'record_changed', node: subnode, controller: '0xmanager', record: record('moonlight_address', moonlight) },
        meta: { txId: 'tx-alice-subname-record', blockHeight: 14 },
      },
      {
        event: {
          type: 'primary_name_changed',
          endpoint: { type: 'moonlight_address', value: moonlight },
          controller: '0xmanager',
          node: subnode,
          name: 'settlement.acme.dusk',
          previousName: null,
          updatedAt: '2026-06-17T00:00:01.000Z',
        },
        meta: { txId: 'tx-alice-primary', blockHeight: 15 },
      },
      {
        event: {
          type: 'name_registered',
          node,
          label: 'acme',
          actor: bob,
          owner: bob,
          expiresAt: '2040-06-17T00:00:00.000Z',
          graceEndsAt: '2040-07-17T00:00:00.000Z',
          expiresAtBlockHeight: 1000,
          graceEndsAtBlockHeight: 1300,
        },
        meta: { txId: 'tx-bob-register', blockHeight: 200 },
      },
      {
        event: { type: 'name_owner_changed', node, actor: bob, previousOwner: alice, owner: bob, manager: bob, resolver, expiresAt: '2040-06-17T00:00:00.000Z', expiresAtBlockHeight: 1000 },
        meta: { txId: 'tx-bob-owner', blockHeight: 200 },
      },
      {
        event: { type: 'record_changed', node, controller: bob, record: record('moonlight_address', 'dusk1bobrecord01') },
        meta: { txId: 'tx-bob-record', blockHeight: 200 },
      },
      {
        event: {
          type: 'name_renewed',
          node,
          actor: bob,
          expiresAt: '2041-06-17T00:00:00.000Z',
          graceEndsAt: '2041-07-17T00:00:00.000Z',
          expiresAtBlockHeight: 2000,
          graceEndsAtBlockHeight: 2300,
        },
        meta: { txId: 'tx-bob-renew', blockHeight: 300 },
      },
    ],
  }
}
